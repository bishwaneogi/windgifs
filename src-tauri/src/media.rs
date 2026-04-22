use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    available: bool,
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
    source: String,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoInspection {
    source_path: Option<String>,
    file_name: String,
    file_size_bytes: Option<u64>,
    width: u32,
    height: u32,
    duration_seconds: f64,
    frame_rate: Option<f64>,
    has_audio: Option<bool>,
    video_codec: Option<String>,
    format_name: Option<String>,
    metadata_source: String,
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    size: Option<String>,
    format_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifExportRequest {
    source_path: String,
    output_path: String,
    trim: TrimRange,
    crop: CropRegion,
    export: ExportSettings,
    overlay_png_data_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifPreviewRequest {
    source_path: String,
    trim: TrimRange,
    crop: CropRegion,
    export: ExportSettings,
    overlay_png_data_url: Option<String>,
    frame_time_seconds: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrimRange {
    start: f64,
    end: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CropRegion {
    enabled: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportSettings {
    width: u32,
    fps: u32,
    colors: u32,
    dither: String,
    r#loop: bool,
    target_file_size_bytes: Option<u64>,
    #[serde(default)]
    compression_effort: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GifExportResult {
    output_path: String,
    file_size_bytes: Option<u64>,
    width: u32,
    height: u32,
    duration_seconds: f64,
    used_overlay: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GifPreviewResult {
    data_url: String,
    width: u32,
    height: u32,
}

#[derive(Debug)]
struct ResolvedTools {
    ffmpeg_path: PathBuf,
    ffprobe_path: PathBuf,
    source: &'static str,
}

#[derive(Debug)]
struct CandidateTools {
    ffmpeg_path: PathBuf,
    ffprobe_path: PathBuf,
    source: &'static str,
}

#[derive(Debug, Clone)]
struct NormalizedRenderSettings {
    source_path: PathBuf,
    trim_start: f64,
    trim_end: f64,
    crop_x: u32,
    crop_y: u32,
    crop_width: u32,
    crop_height: u32,
    output_width: u32,
    output_height: u32,
    fps: u32,
    colors: u32,
    dither: &'static str,
    overlay_png_data_url: Option<String>,
}

impl NormalizedRenderSettings {
    fn with_width(&self, output_width: u32) -> Self {
        let output_height = (((output_width as f64) * (self.crop_height as f64)
            / (self.crop_width as f64))
            .round() as u32)
            .max(1);

        Self {
            output_width,
            output_height,
            ..self.clone()
        }
    }

    fn with_compression_options(
        &self,
        output_width: u32,
        fps: u32,
        colors: u32,
        dither: &'static str,
    ) -> Self {
        let mut next = self.with_width(output_width);
        next.fps = fps;
        next.colors = colors;
        next.dither = dither;
        next
    }
}

#[derive(Debug, Clone)]
struct NormalizedExportRequest {
    render: NormalizedRenderSettings,
    output_path: PathBuf,
    loop_count: i32,
    target_file_size_bytes: Option<u64>,
    compression_effort: CompressionEffort,
}

#[derive(Debug, Clone)]
struct NormalizedPreviewRequest {
    render: NormalizedRenderSettings,
    frame_index: u32,
}

impl NormalizedExportRequest {
    fn with_output_path(&self, output_path: PathBuf) -> Self {
        Self {
            output_path,
            ..self.clone()
        }
    }
}

#[derive(Debug, Clone)]
struct TempExportCandidate {
    temp_path: PathBuf,
    request: NormalizedExportRequest,
    file_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
struct CompressionVariant {
    fps: u32,
    colors: u32,
    dither: &'static str,
}

#[derive(Debug, Clone)]
struct CompressionCandidateSpec {
    request: NormalizedExportRequest,
    quality_score: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompressionEffort {
    Fast,
    Balanced,
    Best,
}

const MIN_EXPORT_TIMEOUT: Duration = Duration::from_secs(30);
const EXPORT_TIMEOUT_PADDING: Duration = Duration::from_secs(15);
const EXPORT_TIMEOUT_MULTIPLIER: f64 = 8.0;
const INPUT_SEEK_PREROLL_SECONDS: f64 = 1.0;
const MIN_COMPRESSED_FPS: u32 = 6;
const MIN_COMPRESSED_COLORS: u32 = 16;
const FAST_COMPRESSION_CANDIDATES: usize = 1;
const BALANCED_COMPRESSION_CANDIDATES: usize = 5;
const MAX_COMPRESSION_CANDIDATES: usize = 14;

#[tauri::command]
pub fn get_ffmpeg_status() -> FfmpegStatus {
    match resolve_tools() {
        Ok(tools) => FfmpegStatus {
            available: true,
            ffmpeg_path: Some(tools.ffmpeg_path.display().to_string()),
            ffprobe_path: Some(tools.ffprobe_path.display().to_string()),
            source: tools.source.to_string(),
            message: format!(
                "Using ffmpeg from {}.",
                tools
                    .ffmpeg_path
                    .parent()
                    .unwrap_or(Path::new("."))
                    .display()
            ),
        },
        Err(message) => FfmpegStatus {
            available: false,
            ffmpeg_path: None,
            ffprobe_path: None,
            source: "unavailable".to_string(),
            message,
        },
    }
}

#[tauri::command]
pub fn inspect_video(path: String) -> Result<VideoInspection, String> {
    let tools = resolve_tools()?;
    let source_path = sanitize_input_path(&path);
    inspect_video_internal(&source_path, &tools)
}

#[tauri::command]
pub fn append_debug_log(message: String) -> Result<(), String> {
    let debug_dir = std::env::temp_dir().join("windgifs");
    fs::create_dir_all(&debug_dir)
        .map_err(|error| format!("Could not create debug log folder: {error}"))?;

    let log_path = debug_dir.join("debug.log");
    let mut entry = format!("\n==== {} ====\n", timestamp_label());
    entry.push_str(&message);
    entry.push('\n');

    use std::io::Write;

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Could not open debug log: {error}"))?;

    file.write_all(entry.as_bytes())
        .map_err(|error| format!("Could not write debug log: {error}"))?;

    Ok(())
}

#[tauri::command]
pub async fn export_gif(request: GifExportRequest) -> Result<GifExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || export_gif_blocking(request))
        .await
        .map_err(|error| format!("GIF export task failed: {error}"))?
}

#[tauri::command]
pub async fn render_quality_preview(
    request: GifPreviewRequest,
) -> Result<GifPreviewResult, String> {
    tauri::async_runtime::spawn_blocking(move || render_quality_preview_blocking(request))
        .await
        .map_err(|error| format!("GIF preview task failed: {error}"))?
}

fn export_gif_blocking(request: GifExportRequest) -> Result<GifExportResult, String> {
    let tools = resolve_tools()?;
    let source_path = sanitize_input_path(&request.source_path);
    let inspection = inspect_video_internal(&source_path, &tools)?;
    let normalized = normalize_export_request(request, &source_path, &inspection)?;

    if let Some(parent) = normalized.output_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create output folder: {error}"))?;
        }
    }

    let overlay_path = create_overlay_temp_path(normalized.render.overlay_png_data_url.as_deref())?;

    let result = if normalized.target_file_size_bytes.is_some() {
        run_compressed_ffmpeg_export(&tools, &normalized, overlay_path.as_deref())
    } else {
        run_ffmpeg_export(&tools, &normalized, overlay_path.as_deref())
    };

    if let Some(path) = overlay_path {
        let _ = fs::remove_file(path);
    }

    result
}

fn render_quality_preview_blocking(request: GifPreviewRequest) -> Result<GifPreviewResult, String> {
    let tools = resolve_tools()?;
    let source_path = sanitize_input_path(&request.source_path);
    let inspection = inspect_video_internal(&source_path, &tools)?;
    let normalized = normalize_preview_request(request, &source_path, &inspection)?;
    let overlay_path = create_overlay_temp_path(normalized.render.overlay_png_data_url.as_deref())?;
    let result = run_ffmpeg_preview(&tools, &normalized, overlay_path.as_deref());

    if let Some(path) = overlay_path {
        let _ = fs::remove_file(path);
    }

    result
}

fn run_ffmpeg_export(
    tools: &ResolvedTools,
    request: &NormalizedExportRequest,
    overlay_path: Option<&Path>,
) -> Result<GifExportResult, String> {
    let filter_graph = build_filter_graph(&request.render, overlay_path.is_some());
    run_ffmpeg_export_with_filter_graph(tools, request, overlay_path, &filter_graph)
}

fn run_compressed_ffmpeg_export(
    tools: &ResolvedTools,
    request: &NormalizedExportRequest,
    overlay_path: Option<&Path>,
) -> Result<GifExportResult, String> {
    let target_file_size_bytes = request
        .target_file_size_bytes
        .ok_or_else(|| "Target file size was missing for compression.".to_string())?;

    let mut temp_paths = Vec::new();
    let baseline = run_temp_ffmpeg_export(tools, request, overlay_path)?;
    temp_paths.push(baseline.temp_path.clone());
    let mut best_candidate = baseline.clone();

    if baseline
        .file_size_bytes
        .is_some_and(|file_size_bytes| file_size_bytes <= target_file_size_bytes)
    {
        return finalize_compressed_candidate(
            request,
            overlay_path.is_some(),
            baseline,
            &temp_paths,
        );
    }

    for candidate_spec in build_compression_candidate_specs(
        request,
        baseline.file_size_bytes,
        target_file_size_bytes,
        request.compression_effort,
    ) {
        let candidate = run_temp_ffmpeg_export(tools, &candidate_spec.request, overlay_path)?;
        temp_paths.push(candidate.temp_path.clone());

        if should_replace_best_candidate(
            request,
            &best_candidate,
            &candidate,
            target_file_size_bytes,
        ) {
            best_candidate = candidate;
        }
    }

    finalize_compressed_candidate(request, overlay_path.is_some(), best_candidate, &temp_paths)
}

fn run_temp_ffmpeg_export(
    tools: &ResolvedTools,
    request: &NormalizedExportRequest,
    overlay_path: Option<&Path>,
) -> Result<TempExportCandidate, String> {
    let temp_path = create_temp_work_path("export", "gif")?;
    let temp_request = request.with_output_path(temp_path.clone());
    let export_result = run_ffmpeg_export(tools, &temp_request, overlay_path)?;

    Ok(TempExportCandidate {
        temp_path,
        request: temp_request,
        file_size_bytes: export_result.file_size_bytes,
    })
}

fn should_replace_best_candidate(
    original_request: &NormalizedExportRequest,
    current_best: &TempExportCandidate,
    candidate: &TempExportCandidate,
    target_file_size_bytes: u64,
) -> bool {
    match (current_best.file_size_bytes, candidate.file_size_bytes) {
        (None, None) => false,
        (None, Some(_)) => true,
        (_, None) => false,
        (Some(current_size), Some(candidate_size)) => {
            let current_within_target = current_size <= target_file_size_bytes;
            let candidate_within_target = candidate_size <= target_file_size_bytes;

            if candidate_within_target != current_within_target {
                return candidate_within_target;
            }

            let current_score =
                compression_quality_score(&original_request.render, &current_best.request.render);
            let candidate_score =
                compression_quality_score(&original_request.render, &candidate.request.render);

            if current_within_target {
                if (candidate_score - current_score).abs() > 0.001 {
                    return candidate_score > current_score;
                }

                return candidate_size > current_size;
            }

            let size_gap = current_size.abs_diff(candidate_size);
            let close_enough = size_gap <= (target_file_size_bytes / 32).max(1);
            if close_enough && (candidate_score - current_score).abs() > 0.001 {
                return candidate_score > current_score;
            }

            candidate_size < current_size
        }
    }
}

fn build_compression_candidate_specs(
    request: &NormalizedExportRequest,
    baseline_file_size_bytes: Option<u64>,
    target_file_size_bytes: u64,
    effort: CompressionEffort,
) -> Vec<CompressionCandidateSpec> {
    let minimum_width = 160u32.min(request.render.output_width);
    let baseline_size =
        baseline_file_size_bytes.unwrap_or(target_file_size_bytes.saturating_mul(2));
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();

    for variant in build_compression_variants(&request.render) {
        let estimated_size_at_full_width =
            (baseline_size as f64 * compression_size_ratio(&request.render, &variant)).max(1.0);
        let predicted_width = if estimated_size_at_full_width <= target_file_size_bytes as f64 {
            request.render.output_width
        } else {
            predict_target_width(
                request.render.output_width,
                estimated_size_at_full_width.round() as u64,
                target_file_size_bytes,
                minimum_width,
            )
            .unwrap_or(minimum_width)
        };

        for width in candidate_widths_for_prediction(
            predicted_width,
            request.render.output_width,
            minimum_width,
        ) {
            if width == request.render.output_width
                && variant.fps == request.render.fps
                && variant.colors == request.render.colors
                && variant.dither == request.render.dither
            {
                continue;
            }

            if !seen.insert((width, variant.fps, variant.colors, variant.dither)) {
                continue;
            }

            let render = request.render.with_compression_options(
                width,
                variant.fps,
                variant.colors,
                variant.dither,
            );
            let quality_score = compression_quality_score(&request.render, &render);
            candidates.push(CompressionCandidateSpec {
                request: NormalizedExportRequest {
                    render,
                    ..request.clone()
                },
                quality_score,
            });
        }
    }

    candidates.sort_by(|left, right| {
        right
            .quality_score
            .partial_cmp(&left.quality_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.truncate(compression_candidate_limit(effort));
    candidates
}

fn compression_candidate_limit(effort: CompressionEffort) -> usize {
    match effort {
        CompressionEffort::Fast => FAST_COMPRESSION_CANDIDATES,
        CompressionEffort::Balanced => BALANCED_COMPRESSION_CANDIDATES,
        CompressionEffort::Best => MAX_COMPRESSION_CANDIDATES,
    }
}

fn build_compression_variants(render: &NormalizedRenderSettings) -> Vec<CompressionVariant> {
    let mut seen = HashSet::new();
    let mut variants = Vec::new();
    let mut push_variant = |fps: u32, colors: u32| {
        let variant = CompressionVariant {
            fps: compression_fps(render.fps, fps),
            colors: compression_colors(render.colors, colors),
            dither: render.dither,
        };

        if seen.insert((variant.fps, variant.colors, variant.dither)) {
            variants.push(variant);
        }
    };

    push_variant(render.fps, render.colors);
    push_variant(render.fps, 96);
    push_variant((render.fps as f64 * 0.85).round() as u32, render.colors);
    push_variant((render.fps as f64 * 0.85).round() as u32, 96);
    push_variant((render.fps as f64 * 0.70).round() as u32, 96);
    push_variant((render.fps as f64 * 0.70).round() as u32, 64);
    push_variant((render.fps as f64 * 0.55).round() as u32, 64);
    push_variant((render.fps as f64 * 0.55).round() as u32, 48);
    push_variant((render.fps as f64 * 0.40).round() as u32, 48);
    push_variant(MIN_COMPRESSED_FPS, 32);

    variants
}

fn compression_fps(original_fps: u32, requested_fps: u32) -> u32 {
    let minimum = MIN_COMPRESSED_FPS.min(original_fps).max(1);
    requested_fps.clamp(minimum, original_fps.max(minimum))
}

fn compression_colors(original_colors: u32, requested_colors: u32) -> u32 {
    let minimum = MIN_COMPRESSED_COLORS.min(original_colors).max(2);
    requested_colors.clamp(minimum, original_colors.max(minimum))
}

fn candidate_widths_for_prediction(
    predicted_width: u32,
    original_width: u32,
    minimum_width: u32,
) -> Vec<u32> {
    let mut widths = Vec::new();
    let mut seen = HashSet::new();
    let mut push_width = |width: u32| {
        let safe_width = width.clamp(minimum_width, original_width);
        if seen.insert(safe_width) {
            widths.push(safe_width);
        }
    };

    push_width(predicted_width);
    push_width(((predicted_width as f64) * 0.94).round() as u32);

    if predicted_width >= original_width {
        push_width(original_width);
    } else {
        push_width(((predicted_width as f64) * 0.88).round() as u32);
    }

    widths
}

fn compression_size_ratio(
    original: &NormalizedRenderSettings,
    variant: &CompressionVariant,
) -> f64 {
    let fps_ratio = variant.fps as f64 / original.fps.max(1) as f64;
    let color_ratio = palette_size_factor(variant.colors) / palette_size_factor(original.colors);

    (fps_ratio * color_ratio).clamp(0.08, 1.0)
}

fn compression_quality_score(
    original: &NormalizedRenderSettings,
    candidate: &NormalizedRenderSettings,
) -> f64 {
    let width_score = candidate.output_width as f64 / original.output_width.max(1) as f64;
    let fps_score = candidate.fps as f64 / original.fps.max(1) as f64;
    let color_score = (candidate.colors as f64 / original.colors.max(1) as f64).sqrt();

    width_score * 0.65 + fps_score * 0.22 + color_score * 0.13
}

fn palette_size_factor(colors: u32) -> f64 {
    (colors.clamp(2, 256) as f64 / 128.0)
        .sqrt()
        .clamp(0.22, 1.45)
}

fn predict_target_width(
    current_width: u32,
    current_file_size_bytes: u64,
    target_file_size_bytes: u64,
    minimum_width: u32,
) -> Option<u32> {
    if current_file_size_bytes == 0
        || current_file_size_bytes <= target_file_size_bytes
        || minimum_width >= current_width
    {
        return None;
    }

    let scale_ratio = (target_file_size_bytes as f64 / current_file_size_bytes as f64)
        .sqrt()
        .clamp(0.1, 0.99);
    let predicted_width = ((current_width as f64) * scale_ratio * 0.98).round() as u32;
    let clamped_width = predicted_width.clamp(minimum_width, current_width.saturating_sub(1));

    (clamped_width < current_width).then_some(clamped_width)
}

fn finalize_compressed_candidate(
    request: &NormalizedExportRequest,
    used_overlay: bool,
    best_candidate: TempExportCandidate,
    temp_paths: &[PathBuf],
) -> Result<GifExportResult, String> {
    move_or_replace_file(&best_candidate.temp_path, &request.output_path)?;

    for temp_path in temp_paths {
        if temp_path != &best_candidate.temp_path {
            let _ = fs::remove_file(temp_path);
        }
    }

    let finalized_request = best_candidate
        .request
        .with_output_path(request.output_path.clone());

    Ok(build_export_result(
        &finalized_request,
        best_candidate.file_size_bytes,
        used_overlay,
    ))
}

fn build_filter_graph(render: &NormalizedRenderSettings, has_overlay: bool) -> String {
    let base_chain = build_base_chain(render);
    let palettegen = palettegen_options(render);
    let paletteuse = paletteuse_options(render);

    if has_overlay {
        format!(
            "[0:v]{base_chain}[base];[1:v]scale={}:{}:flags=lanczos,format=rgba[overlay];[base][overlay]overlay=0:0:format=auto:shortest=1[composited];[composited]split[palette_in][gif_in];[palette_in]palettegen={palettegen}[palette];[gif_in][palette]paletteuse={paletteuse}[out]",
            render.output_width,
            render.output_height
        )
    } else {
        format!(
            "[0:v]{base_chain},split[palette_in][gif_in];[palette_in]palettegen={palettegen}[palette];[gif_in][palette]paletteuse={paletteuse}[out]",
        )
    }
}

fn build_preview_filter_graph(request: &NormalizedPreviewRequest, has_overlay: bool) -> String {
    let base_chain = build_base_chain(&request.render);
    let palettegen = palettegen_options(&request.render);
    let paletteuse = paletteuse_options(&request.render);

    if has_overlay {
        format!(
            "[0:v]{base_chain}[base];[1:v]scale={}:{}:flags=lanczos,format=rgba[overlay];[base][overlay]overlay=0:0:format=auto:shortest=1[composited];[composited]split[palette_in][preview_seq];[palette_in]palettegen={palettegen}[palette];[preview_seq]select='eq(n\\,{})'[preview_in];[preview_in][palette]paletteuse={paletteuse}[out]",
            request.render.output_width,
            request.render.output_height,
            request.frame_index,
        )
    } else {
        format!(
            "[0:v]{base_chain},split[palette_in][preview_seq];[palette_in]palettegen={palettegen}[palette];[preview_seq]select='eq(n\\,{})'[preview_in];[preview_in][palette]paletteuse={paletteuse}[out]",
            request.frame_index,
        )
    }
}

fn palettegen_options(render: &NormalizedRenderSettings) -> String {
    format!(
        "max_colors={}:reserve_transparent=0:stats_mode=diff",
        render.colors
    )
}

fn paletteuse_options(render: &NormalizedRenderSettings) -> String {
    format!("dither={}:diff_mode=rectangle", render.dither)
}

fn build_base_chain(render: &NormalizedRenderSettings) -> String {
    let decode_window = build_decode_window(render);

    format!(
        "trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS,fps=fps={},crop={}:{}:{}:{},scale={}:{}:flags=lanczos,setsar=1",
        decode_window.trim_start,
        decode_window.trim_end,
        render.fps,
        render.crop_width,
        render.crop_height,
        render.crop_x,
        render.crop_y,
        render.output_width,
        render.output_height
    )
}

#[derive(Debug, Clone, Copy)]
struct DecodeWindow {
    input_seek_start: f64,
    trim_start: f64,
    trim_end: f64,
    decode_duration: f64,
}

fn build_decode_window(render: &NormalizedRenderSettings) -> DecodeWindow {
    let input_seek_start = (render.trim_start - INPUT_SEEK_PREROLL_SECONDS).max(0.0);
    let trim_start = (render.trim_start - input_seek_start).max(0.0);
    let trim_end = (render.trim_end - input_seek_start).max(trim_start + 0.05);

    DecodeWindow {
        input_seek_start,
        trim_start,
        trim_end,
        decode_duration: trim_end.max(0.05),
    }
}

fn append_source_input_args(command: &mut Command, render: &NormalizedRenderSettings) {
    let decode_window = build_decode_window(render);

    if decode_window.input_seek_start > 0.0 {
        command.arg("-ss");
        command.arg(format!("{:.3}", decode_window.input_seek_start));
    }

    command.arg("-t");
    command.arg(format!("{:.3}", decode_window.decode_duration));
    command.arg("-i");
    command.arg(&render.source_path);
}

fn run_ffmpeg_export_with_filter_graph(
    tools: &ResolvedTools,
    request: &NormalizedExportRequest,
    overlay_path: Option<&Path>,
    filter_graph: &str,
) -> Result<GifExportResult, String> {
    let mut command = Command::new(&tools.ffmpeg_path);
    command.args(["-y", "-v", "error"]);
    append_source_input_args(&mut command, &request.render);

    if let Some(overlay_path) = overlay_path {
        command.arg("-loop");
        command.arg("1");
        command.arg("-i");
        command.arg(overlay_path);
    }

    command.arg("-filter_complex");
    command.arg(filter_graph);
    command.arg("-map");
    command.arg("[out]");
    command.arg("-loop");
    command.arg(request.loop_count.to_string());
    command.arg(&request.output_path);

    apply_hidden_process_flags(&mut command);
    let _guard = WindowsErrorModeGuard::set_safely();
    let timeout = export_timeout_for_request(request);
    let output = run_command_with_timeout(&mut command, timeout, "ffmpeg")
        .map_err(|error| format!("Failed during GIF export: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "ffmpeg could not create the GIF.".to_string()
        } else {
            stderr
        });
    }

    let file_size_bytes = fs::metadata(&request.output_path)
        .ok()
        .map(|metadata| metadata.len());

    Ok(build_export_result(
        request,
        file_size_bytes,
        overlay_path.is_some(),
    ))
}

fn run_ffmpeg_preview(
    tools: &ResolvedTools,
    request: &NormalizedPreviewRequest,
    overlay_path: Option<&Path>,
) -> Result<GifPreviewResult, String> {
    let filter_graph = build_preview_filter_graph(request, overlay_path.is_some());
    let mut command = Command::new(&tools.ffmpeg_path);
    command.args(["-v", "error"]);
    append_source_input_args(&mut command, &request.render);

    if let Some(overlay_path) = overlay_path {
        command.arg("-loop");
        command.arg("1");
        command.arg("-i");
        command.arg(overlay_path);
    }

    command.arg("-filter_complex");
    command.arg(filter_graph);
    command.arg("-map");
    command.arg("[out]");
    command.arg("-frames:v");
    command.arg("1");
    command.arg("-f");
    command.arg("image2pipe");
    command.arg("-vcodec");
    command.arg("png");
    command.arg("-");

    apply_hidden_process_flags(&mut command);
    let _guard = WindowsErrorModeGuard::set_safely();
    let timeout = export_timeout_for_render(&request.render);
    let output = run_command_with_timeout(&mut command, timeout, "ffmpeg")
        .map_err(|error| format!("Failed during GIF preview: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "ffmpeg could not render the preview frame.".to_string()
        } else {
            stderr
        });
    }

    if output.stdout.is_empty() {
        return Err("ffmpeg did not return a preview frame.".to_string());
    }

    Ok(GifPreviewResult {
        data_url: format!("data:image/png;base64,{}", encode_base64(&output.stdout)),
        width: request.render.output_width,
        height: request.render.output_height,
    })
}

fn export_timeout_for_request(request: &NormalizedExportRequest) -> Duration {
    export_timeout_for_render(&request.render)
}

fn export_timeout_for_render(render: &NormalizedRenderSettings) -> Duration {
    let trim_duration = (render.trim_end - render.trim_start).max(0.0);
    let estimated_seconds = (trim_duration * EXPORT_TIMEOUT_MULTIPLIER).ceil() as u64;
    MIN_EXPORT_TIMEOUT.max(Duration::from_secs(estimated_seconds) + EXPORT_TIMEOUT_PADDING)
}

fn run_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
    label: &str,
) -> Result<Output, String> {
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not launch {label}: {error}"))?;
    let started = Instant::now();

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not wait on {label}: {error}"))?
        {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();

            if let Some(mut handle) = child.stdout.take() {
                handle
                    .read_to_end(&mut stdout)
                    .map_err(|error| format!("Could not read {label} output: {error}"))?;
            }

            if let Some(mut handle) = child.stderr.take() {
                handle
                    .read_to_end(&mut stderr)
                    .map_err(|error| format!("Could not read {label} errors: {error}"))?;
            }

            return Ok(Output {
                status,
                stdout,
                stderr,
            });
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "{label} timed out after {:.1}s.",
                timeout.as_secs_f64()
            ));
        }

        thread::sleep(Duration::from_millis(100));
    }
}

fn build_export_result(
    request: &NormalizedExportRequest,
    file_size_bytes: Option<u64>,
    used_overlay: bool,
) -> GifExportResult {
    GifExportResult {
        output_path: request.output_path.display().to_string(),
        file_size_bytes,
        width: request.render.output_width,
        height: request.render.output_height,
        duration_seconds: request.render.trim_end - request.render.trim_start,
        used_overlay,
    }
}

fn normalize_export_request(
    request: GifExportRequest,
    source_path: &Path,
    inspection: &VideoInspection,
) -> Result<NormalizedExportRequest, String> {
    let render = normalize_render_settings(
        &request.trim,
        &request.crop,
        &request.export,
        request.overlay_png_data_url,
        source_path,
        inspection,
    )?;
    let output_path = resolve_output_path(&request.output_path, source_path, &inspection.file_name);
    let loop_count = if request.export.r#loop { 0 } else { -1 };
    let compression_effort =
        normalize_compression_effort(request.export.compression_effort.as_deref())?;

    Ok(NormalizedExportRequest {
        render,
        output_path,
        loop_count,
        target_file_size_bytes: request.export.target_file_size_bytes,
        compression_effort,
    })
}

fn normalize_preview_request(
    request: GifPreviewRequest,
    source_path: &Path,
    inspection: &VideoInspection,
) -> Result<NormalizedPreviewRequest, String> {
    let render = normalize_render_settings(
        &request.trim,
        &request.crop,
        &request.export,
        request.overlay_png_data_url,
        source_path,
        inspection,
    )?;
    let frame_index = resolve_preview_frame_index(&render, request.frame_time_seconds);

    Ok(NormalizedPreviewRequest {
        render,
        frame_index,
    })
}

fn normalize_render_settings(
    trim: &TrimRange,
    crop: &CropRegion,
    export: &ExportSettings,
    overlay_png_data_url: Option<String>,
    source_path: &Path,
    inspection: &VideoInspection,
) -> Result<NormalizedRenderSettings, String> {
    let (trim_start, trim_end) = clamp_trim(trim, inspection.duration_seconds)?;
    let (crop_x, crop_y, crop_width, crop_height) = resolve_crop(crop, inspection);
    let (output_width, output_height) =
        resolve_output_dimensions(export.width, crop_width, crop_height);

    Ok(NormalizedRenderSettings {
        source_path: source_path.to_path_buf(),
        trim_start,
        trim_end,
        crop_x,
        crop_y,
        crop_width,
        crop_height,
        output_width,
        output_height,
        fps: export.fps.clamp(4, 30),
        colors: export.colors.clamp(16, 256),
        dither: normalize_dither(&export.dither)?,
        overlay_png_data_url,
    })
}

fn resolve_preview_frame_index(
    render: &NormalizedRenderSettings,
    frame_time_seconds: Option<f64>,
) -> u32 {
    let trim_duration = (render.trim_end - render.trim_start).max(0.05);
    let max_frame_index = ((trim_duration * render.fps as f64).ceil() as u32).saturating_sub(1);
    let requested_frame_time = frame_time_seconds.unwrap_or(render.trim_start);
    let relative_time = (requested_frame_time - render.trim_start).clamp(0.0, trim_duration);
    let frame_index = (relative_time * render.fps as f64).floor() as u32;

    frame_index.min(max_frame_index)
}

fn resolve_output_path(value: &str, source_path: &Path, file_name: &str) -> PathBuf {
    let cleaned_value = value.trim().trim_matches('"');

    let mut output_path = if cleaned_value.is_empty() {
        let base_name = source_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(file_name);
        source_path
            .parent()
            .unwrap_or(Path::new("."))
            .join(format!("{base_name}-windgifs.gif"))
    } else {
        let candidate = PathBuf::from(cleaned_value);
        if candidate.is_absolute() {
            candidate
        } else {
            source_path
                .parent()
                .unwrap_or(Path::new("."))
                .join(candidate)
        }
    };

    let is_gif = output_path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("gif"))
        .unwrap_or(false);

    if !is_gif {
        output_path.set_extension("gif");
    }

    output_path
}

fn clamp_trim(trim: &TrimRange, duration_seconds: f64) -> Result<(f64, f64), String> {
    let safe_duration = duration_seconds.max(0.1);
    let start = trim.start.clamp(0.0, safe_duration);
    let end = if trim.end <= 0.0 {
        safe_duration
    } else {
        trim.end.clamp(start, safe_duration)
    };

    if end - start < 0.05 {
        return Err("Choose a trim range that is at least 0.05 seconds long.".to_string());
    }

    Ok((start, end))
}

fn resolve_crop(crop: &CropRegion, inspection: &VideoInspection) -> (u32, u32, u32, u32) {
    if !crop.enabled {
        return (0, 0, inspection.width, inspection.height);
    }

    let x = crop.x.clamp(0.0, 0.95);
    let y = crop.y.clamp(0.0, 0.95);
    let width = crop.width.clamp(0.05, 1.0 - x);
    let height = crop.height.clamp(0.05, 1.0 - y);

    let crop_x = ((inspection.width as f64) * x).round() as u32;
    let crop_y = ((inspection.height as f64) * y).round() as u32;

    let mut crop_width = (((inspection.width as f64) * width).round() as u32).max(1);
    let mut crop_height = (((inspection.height as f64) * height).round() as u32).max(1);

    if crop_x + crop_width > inspection.width {
        crop_width = inspection.width.saturating_sub(crop_x).max(1);
    }

    if crop_y + crop_height > inspection.height {
        crop_height = inspection.height.saturating_sub(crop_y).max(1);
    }

    (crop_x, crop_y, crop_width, crop_height)
}

fn resolve_output_dimensions(width: u32, crop_width: u32, crop_height: u32) -> (u32, u32) {
    let safe_width = width.max(32).min(crop_width.max(1));
    let safe_height =
        (((safe_width as f64) * (crop_height as f64) / (crop_width as f64)).round() as u32).max(1);

    (safe_width, safe_height)
}

fn normalize_dither(value: &str) -> Result<&'static str, String> {
    match value.trim() {
        "bayer" => Ok("bayer"),
        "floyd_steinberg" => Ok("floyd_steinberg"),
        "none" => Ok("none"),
        "sierra2_4a" => Ok("sierra2_4a"),
        _ => Err("Unsupported dithering mode for paletteuse.".to_string()),
    }
}

fn normalize_compression_effort(value: Option<&str>) -> Result<CompressionEffort, String> {
    match value.unwrap_or("balanced").trim() {
        "" | "balanced" => Ok(CompressionEffort::Balanced),
        "fast" => Ok(CompressionEffort::Fast),
        "best" => Ok(CompressionEffort::Best),
        _ => Err("Unsupported compression effort.".to_string()),
    }
}

fn sanitize_input_path(value: &str) -> PathBuf {
    PathBuf::from(value.trim().trim_matches('"'))
}

fn inspect_video_internal(
    source_path: &Path,
    tools: &ResolvedTools,
) -> Result<VideoInspection, String> {
    if !source_path.exists() {
        return Err(format!(
            "Source path was not found: {}",
            source_path.display()
        ));
    }

    if !source_path.is_file() {
        return Err(format!(
            "Expected a file but received: {}",
            source_path.display()
        ));
    }

    let mut command = Command::new(&tools.ffprobe_path);
    command.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
    ]);
    command.arg(source_path);
    apply_hidden_process_flags(&mut command);
    let _guard = WindowsErrorModeGuard::set_safely();

    let output = command
        .output()
        .map_err(|error| format!("Failed to launch ffprobe: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "ffprobe could not inspect the selected video.".to_string()
        } else {
            stderr
        });
    }

    let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Could not parse ffprobe output: {error}"))?;

    let video_stream = parsed
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| "ffprobe did not find a video stream in the selected file.".to_string())?;

    let duration_seconds = parse_number(
        video_stream.duration.as_deref().or(parsed
            .format
            .as_ref()
            .and_then(|format| format.duration.as_deref())),
    )
    .ok_or_else(|| "Could not determine video duration.".to_string())?;

    let width = video_stream
        .width
        .ok_or_else(|| "Could not determine the source width.".to_string())?;
    let height = video_stream
        .height
        .ok_or_else(|| "Could not determine the source height.".to_string())?;

    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("video")
        .to_string();

    let file_size_bytes = fs::metadata(source_path)
        .ok()
        .map(|metadata| metadata.len())
        .or_else(|| {
            parsed
                .format
                .as_ref()
                .and_then(|format| parse_u64(format.size.as_deref()))
        });

    Ok(VideoInspection {
        source_path: Some(source_path.display().to_string()),
        file_name,
        file_size_bytes,
        width,
        height,
        duration_seconds,
        frame_rate: parse_frame_rate(
            video_stream
                .avg_frame_rate
                .as_deref()
                .or(video_stream.r_frame_rate.as_deref()),
        ),
        has_audio: Some(
            parsed
                .streams
                .iter()
                .any(|stream| stream.codec_type.as_deref() == Some("audio")),
        ),
        video_codec: video_stream.codec_name.clone(),
        format_name: parsed
            .format
            .as_ref()
            .and_then(|format| format.format_name.clone()),
        metadata_source: "ffprobe".to_string(),
    })
}

fn parse_number(value: Option<&str>) -> Option<f64> {
    value.and_then(|number| number.parse::<f64>().ok())
}

fn parse_u64(value: Option<&str>) -> Option<u64> {
    value.and_then(|number| number.parse::<u64>().ok())
}

fn parse_frame_rate(value: Option<&str>) -> Option<f64> {
    let raw = value?;
    if raw == "0/0" {
        return None;
    }

    if let Some((numerator, denominator)) = raw.split_once('/') {
        let numerator = numerator.parse::<f64>().ok()?;
        let denominator = denominator.parse::<f64>().ok()?;

        if denominator == 0.0 {
            return None;
        }

        return Some(numerator / denominator);
    }

    raw.parse::<f64>().ok()
}

fn resolve_tools() -> Result<ResolvedTools, String> {
    if let Some(directory) = std::env::var_os("WINDGIFS_FFMPEG_DIR") {
        let directory = PathBuf::from(directory);
        let ffmpeg = windows_binary(&directory, "ffmpeg");
        let ffprobe = windows_binary(&directory, "ffprobe");

        if ffmpeg.is_file() && ffprobe.is_file() {
            if tool_pair_is_healthy(&ffmpeg, &ffprobe) {
                return Ok(ResolvedTools {
                    ffmpeg_path: ffmpeg,
                    ffprobe_path: ffprobe,
                    source: "workspace-tools",
                });
            }
        }
    }

    for candidate in workspace_tool_candidates() {
        let ffmpeg = windows_binary(&candidate, "ffmpeg");
        let ffprobe = windows_binary(&candidate, "ffprobe");

        if ffmpeg.is_file() && ffprobe.is_file() && tool_pair_is_healthy(&ffmpeg, &ffprobe) {
            return Ok(ResolvedTools {
                ffmpeg_path: ffmpeg,
                ffprobe_path: ffprobe,
                source: "workspace-tools",
            });
        }
    }

    for candidate in system_tool_candidates() {
        if tool_pair_is_healthy(&candidate.ffmpeg_path, &candidate.ffprobe_path) {
            return Ok(ResolvedTools {
                ffmpeg_path: candidate.ffmpeg_path,
                ffprobe_path: candidate.ffprobe_path,
                source: candidate.source,
            });
        }
    }

    Err("WindGifs needs both ffmpeg and ffprobe. Install them on PATH or place ffmpeg.exe and ffprobe.exe in tools/ffmpeg/.".to_string())
}

fn workspace_tool_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("tools").join("ffmpeg"));
    }

    if let Ok(executable_path) = std::env::current_exe() {
        if let Some(executable_dir) = executable_path.parent() {
            candidates.push(executable_dir.join("tools").join("ffmpeg"));
            candidates.push(
                executable_dir
                    .join("resources")
                    .join("tools")
                    .join("ffmpeg"),
            );
        }
    }

    candidates
}

fn system_tool_candidates() -> Vec<CandidateTools> {
    let ffmpeg_paths = discover_command_paths("ffmpeg");
    let ffprobe_paths = discover_command_paths("ffprobe");
    let mut candidates = Vec::new();

    for ffmpeg_path in &ffmpeg_paths {
        if let Some(directory) = ffmpeg_path.parent() {
            let paired_ffprobe = windows_binary(directory, "ffprobe");
            if ffprobe_paths.iter().any(|path| path == &paired_ffprobe) {
                candidates.push(CandidateTools {
                    ffmpeg_path: ffmpeg_path.clone(),
                    ffprobe_path: paired_ffprobe,
                    source: "system-path",
                });
            }
        }
    }

    if candidates.is_empty() && !ffmpeg_paths.is_empty() && !ffprobe_paths.is_empty() {
        candidates.push(CandidateTools {
            ffmpeg_path: ffmpeg_paths[0].clone(),
            ffprobe_path: ffprobe_paths[0].clone(),
            source: "system-path",
        });
    }

    candidates
}

fn discover_command_paths(command_name: &str) -> Vec<PathBuf> {
    let output = run_hidden_command("where.exe", [command_name]);
    let Ok(output) = output else {
        return Vec::new();
    };

    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .collect()
}

fn windows_binary(directory: &Path, name: &str) -> PathBuf {
    if cfg!(target_os = "windows") {
        directory.join(format!("{name}.exe"))
    } else {
        directory.join(name)
    }
}

fn tool_pair_is_healthy(ffmpeg_path: &Path, ffprobe_path: &Path) -> bool {
    tool_is_healthy(ffmpeg_path) && tool_is_healthy(ffprobe_path)
}

fn tool_is_healthy(path: &Path) -> bool {
    run_hidden_path_command(path, ["-version"])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn run_hidden_path_command<I, S>(program: &Path, args: I) -> io::Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut command = Command::new(program);
    command.args(args);
    apply_hidden_process_flags(&mut command);
    let _guard = WindowsErrorModeGuard::set_safely();
    command.output()
}

fn run_hidden_command<I, S>(program: &str, args: I) -> io::Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut command = Command::new(program);
    command.args(args);
    apply_hidden_process_flags(&mut command);
    let _guard = WindowsErrorModeGuard::set_safely();
    command.output()
}

fn apply_hidden_process_flags(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(target_os = "windows")]
struct WindowsErrorModeGuard {
    previous_mode: u32,
    active: bool,
}

#[cfg(target_os = "windows")]
impl WindowsErrorModeGuard {
    fn set_safely() -> Self {
        const SEM_FAILCRITICALERRORS: u32 = 0x0001;
        const SEM_NOGPFAULTERRORBOX: u32 = 0x0002;
        const SEM_NOOPENFILEERRORBOX: u32 = 0x8000;
        let new_mode = SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX;

        let mut previous_mode = 0u32;
        let active = unsafe { SetThreadErrorMode(new_mode, &mut previous_mode) != 0 };

        Self {
            previous_mode,
            active,
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsErrorModeGuard {
    fn drop(&mut self) {
        if self.active {
            unsafe {
                let mut ignored_previous = 0u32;
                let _ = SetThreadErrorMode(self.previous_mode, &mut ignored_previous);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
struct WindowsErrorModeGuard;

#[cfg(not(target_os = "windows"))]
impl WindowsErrorModeGuard {
    fn set_safely() -> Self {
        Self
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" {
    fn SetThreadErrorMode(new_mode: u32, old_mode: *mut u32) -> i32;
}

fn create_temp_work_path(prefix: &str, extension: &str) -> Result<PathBuf, String> {
    let temp_dir = std::env::temp_dir().join("windgifs");
    fs::create_dir_all(&temp_dir)
        .map_err(|error| format!("Could not create temp folder: {error}"))?;

    let unique_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    Ok(temp_dir.join(format!(
        "{prefix}-{unique_id}.{}",
        extension.trim_start_matches('.')
    )))
}

fn move_or_replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    if source == destination {
        return Ok(());
    }

    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| format!("Could not replace existing output GIF: {error}"))?;
    }

    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            fs::copy(source, destination)
                .map_err(|copy_error| format!("Could not finalize compressed GIF: {copy_error}"))?;
            let _ = fs::remove_file(source);
            let _ = rename_error;
            Ok(())
        }
    }
}

fn write_temp_overlay(bytes: &[u8]) -> Result<PathBuf, String> {
    let overlay_path = create_temp_work_path("overlay", "png")?;
    fs::write(&overlay_path, bytes)
        .map_err(|error| format!("Could not write overlay image: {error}"))?;

    Ok(overlay_path)
}

fn create_overlay_temp_path(data_url: Option<&str>) -> Result<Option<PathBuf>, String> {
    match data_url {
        Some(data_url) if !data_url.trim().is_empty() => {
            let bytes = decode_png_data_url(data_url)?;
            write_temp_overlay(&bytes).map(Some)
        }
        _ => Ok(None),
    }
}

fn timestamp_label() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs().to_string(),
        Err(_) => "time-error".to_string(),
    }
}

fn decode_png_data_url(value: &str) -> Result<Vec<u8>, String> {
    let (header, payload) = value
        .split_once(',')
        .ok_or_else(|| "Overlay data URL is malformed.".to_string())?;

    if !header.starts_with("data:image/png;base64") {
        return Err("Overlay image must be a PNG data URL.".to_string());
    }

    decode_base64(payload)
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity((input.len() * 3) / 4);
    let mut chunk = [0u8; 4];
    let mut chunk_len = 0usize;

    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            b'=' => Some(64),
            b'\r' | b'\n' | b'\t' | b' ' => None,
            _ => return Err("Overlay image contains invalid base64 data.".to_string()),
        };

        let Some(value) = value else {
            continue;
        };

        chunk[chunk_len] = value;
        chunk_len += 1;

        if chunk_len == 4 {
            if chunk[0] == 64 || chunk[1] == 64 {
                return Err("Overlay image contains invalid base64 padding.".to_string());
            }

            output.push((chunk[0] << 2) | (chunk[1] >> 4));

            if chunk[2] != 64 {
                output.push(((chunk[1] & 0x0F) << 4) | (chunk[2] >> 2));
            } else if chunk[3] != 64 {
                return Err("Overlay image contains invalid base64 padding.".to_string());
            }

            if chunk[3] != 64 {
                output.push(((chunk[2] & 0x03) << 6) | chunk[3]);
            }

            chunk_len = 0;
            chunk = [0u8; 4];
        }
    }

    if chunk_len != 0 {
        return Err("Overlay image base64 length is incomplete.".to_string());
    }

    Ok(output)
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0usize;

    while index + 3 <= bytes.len() {
        let chunk = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | (bytes[index + 2] as u32);

        output.push(TABLE[((chunk >> 18) & 0x3F) as usize] as char);
        output.push(TABLE[((chunk >> 12) & 0x3F) as usize] as char);
        output.push(TABLE[((chunk >> 6) & 0x3F) as usize] as char);
        output.push(TABLE[(chunk & 0x3F) as usize] as char);
        index += 3;
    }

    match bytes.len().saturating_sub(index) {
        1 => {
            let chunk = (bytes[index] as u32) << 16;
            output.push(TABLE[((chunk >> 18) & 0x3F) as usize] as char);
            output.push(TABLE[((chunk >> 12) & 0x3F) as usize] as char);
            output.push('=');
            output.push('=');
        }
        2 => {
            let chunk = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8);
            output.push(TABLE[((chunk >> 18) & 0x3F) as usize] as char);
            output.push(TABLE[((chunk >> 12) & 0x3F) as usize] as char);
            output.push(TABLE[((chunk >> 6) & 0x3F) as usize] as char);
            output.push('=');
        }
        _ => {}
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires WINDGIFS_TEST_VIDEO to point at a real local video file"]
    fn smoke_export_from_env_video() {
        let source_path = std::env::var("WINDGIFS_TEST_VIDEO")
            .expect("WINDGIFS_TEST_VIDEO must be set for the smoke export test");

        let source_path = sanitize_input_path(&source_path);
        let output_path = std::env::temp_dir().join("windgifs-smoke-export.gif");
        let _ = fs::remove_file(&output_path);

        let request = GifExportRequest {
            source_path: source_path.display().to_string(),
            output_path: output_path.display().to_string(),
            trim: TrimRange {
                start: 0.0,
                end: 5.0,
            },
            crop: CropRegion {
                enabled: true,
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            export: ExportSettings {
                width: 540,
                fps: 15,
                colors: 96,
                dither: "sierra2_4a".to_string(),
                r#loop: true,
                target_file_size_bytes: None,
                compression_effort: Some("balanced".to_string()),
            },
            overlay_png_data_url: None,
        };

        let result = export_gif_blocking(request).expect("smoke export should succeed");

        assert_eq!(result.output_path, output_path.display().to_string());
        assert!(result.file_size_bytes.unwrap_or(0) > 0);
        assert!(output_path.is_file());
    }

    #[test]
    #[ignore = "requires WINDGIFS_TEST_VIDEO to point at a real local video file"]
    fn smoke_compressed_export_from_env_video() {
        let source_path = std::env::var("WINDGIFS_TEST_VIDEO")
            .expect("WINDGIFS_TEST_VIDEO must be set for the compressed smoke export test");

        let source_path = sanitize_input_path(&source_path);
        let output_path = std::env::temp_dir().join("windgifs-smoke-compressed-export.gif");
        let _ = fs::remove_file(&output_path);
        let target_file_size_bytes = 1024 * 1024;

        let request = GifExportRequest {
            source_path: source_path.display().to_string(),
            output_path: output_path.display().to_string(),
            trim: TrimRange {
                start: 0.0,
                end: 5.0,
            },
            crop: CropRegion {
                enabled: true,
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            export: ExportSettings {
                width: 540,
                fps: 15,
                colors: 96,
                dither: "sierra2_4a".to_string(),
                r#loop: true,
                target_file_size_bytes: Some(target_file_size_bytes),
                compression_effort: Some("balanced".to_string()),
            },
            overlay_png_data_url: None,
        };

        let result = export_gif_blocking(request).expect("compressed smoke export should succeed");
        let file_size_bytes = result
            .file_size_bytes
            .expect("compressed export should report a file size");

        assert!(
            file_size_bytes <= target_file_size_bytes || result.width <= 160,
            "expected export to fit target or reach minimum width, got {} bytes at {}px",
            file_size_bytes,
            result.width
        );

        let _ = fs::remove_file(&output_path);
    }

    #[test]
    #[ignore = "requires WINDGIFS_TEST_VIDEO to point at a real local video file"]
    fn smoke_preview_from_env_video() {
        let source_path = std::env::var("WINDGIFS_TEST_VIDEO")
            .expect("WINDGIFS_TEST_VIDEO must be set for the smoke preview test");

        let request = GifPreviewRequest {
            source_path,
            trim: TrimRange {
                start: 0.0,
                end: 3.0,
            },
            crop: CropRegion {
                enabled: true,
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            export: ExportSettings {
                width: 540,
                fps: 15,
                colors: 96,
                dither: "sierra2_4a".to_string(),
                r#loop: true,
                target_file_size_bytes: None,
                compression_effort: Some("balanced".to_string()),
            },
            overlay_png_data_url: None,
            frame_time_seconds: Some(1.0),
        };

        let result =
            render_quality_preview_blocking(request).expect("smoke preview should succeed");

        assert!(result.data_url.starts_with("data:image/png;base64,"));
        assert_eq!(result.width, 540);
        assert!(result.height > 0);
    }

    #[test]
    #[ignore = "requires ffmpeg and ffprobe on PATH"]
    fn resolve_tools_skips_invalid_env_dir() {
        let invalid_dir = std::env::temp_dir().join("windgifs-invalid-tools");
        let _ = fs::remove_dir_all(&invalid_dir);
        fs::create_dir_all(&invalid_dir).expect("temp invalid tool dir should exist");

        fs::write(windows_binary(&invalid_dir, "ffmpeg"), b"not-a-real-exe")
            .expect("should write fake ffmpeg");
        fs::write(windows_binary(&invalid_dir, "ffprobe"), b"not-a-real-exe")
            .expect("should write fake ffprobe");

        let previous = std::env::var_os("WINDGIFS_FFMPEG_DIR");
        std::env::set_var("WINDGIFS_FFMPEG_DIR", &invalid_dir);

        let resolved = resolve_tools().expect("system tools should still resolve");
        assert_eq!(resolved.source, "system-path");

        if let Some(previous) = previous {
            std::env::set_var("WINDGIFS_FFMPEG_DIR", previous);
        } else {
            std::env::remove_var("WINDGIFS_FFMPEG_DIR");
        }

        let _ = fs::remove_dir_all(&invalid_dir);
    }

    #[test]
    fn overlay_filter_graph_stops_at_main_video_end() {
        let request = NormalizedExportRequest {
            render: NormalizedRenderSettings {
                source_path: PathBuf::from("input.mp4"),
                trim_start: 0.0,
                trim_end: 5.0,
                crop_x: 0,
                crop_y: 0,
                crop_width: 1920,
                crop_height: 1080,
                output_width: 540,
                output_height: 304,
                fps: 15,
                colors: 96,
                dither: "sierra2_4a",
                overlay_png_data_url: Some("data:image/png;base64,AAAA".to_string()),
            },
            output_path: PathBuf::from("output.gif"),
            loop_count: 0,
            target_file_size_bytes: None,
            compression_effort: CompressionEffort::Balanced,
        };

        let graph = build_filter_graph(&request.render, true);

        assert!(graph.contains("overlay=0:0:format=auto:shortest=1"));
        assert!(graph.contains("palettegen=max_colors=96:reserve_transparent=0:stats_mode=diff"));
        assert!(graph.contains("paletteuse=dither=sierra2_4a:diff_mode=rectangle"));
    }

    #[test]
    fn decode_window_limits_input_duration_for_trimmed_exports() {
        let render = NormalizedRenderSettings {
            source_path: PathBuf::from("input.mp4"),
            trim_start: 12.0,
            trim_end: 18.5,
            crop_x: 0,
            crop_y: 0,
            crop_width: 1920,
            crop_height: 1080,
            output_width: 540,
            output_height: 304,
            fps: 15,
            colors: 96,
            dither: "sierra2_4a",
            overlay_png_data_url: None,
        };

        let decode_window = build_decode_window(&render);

        assert_eq!(decode_window.input_seek_start, 11.0);
        assert_eq!(decode_window.trim_start, 1.0);
        assert_eq!(decode_window.trim_end, 7.5);
        assert_eq!(decode_window.decode_duration, 7.5);
    }

    #[test]
    fn predict_target_width_scales_down_oversized_exports() {
        let predicted = predict_target_width(720, 8 * 1024 * 1024, 2 * 1024 * 1024, 160)
            .expect("oversized export should predict a narrower width");

        assert!(predicted < 720);
        assert!(predicted >= 160);
    }

    #[test]
    fn preview_filter_graph_selects_requested_frame() {
        let request = NormalizedPreviewRequest {
            render: NormalizedRenderSettings {
                source_path: PathBuf::from("input.mp4"),
                trim_start: 0.0,
                trim_end: 5.0,
                crop_x: 0,
                crop_y: 0,
                crop_width: 1920,
                crop_height: 1080,
                output_width: 540,
                output_height: 304,
                fps: 15,
                colors: 96,
                dither: "sierra2_4a",
                overlay_png_data_url: None,
            },
            frame_index: 12,
        };

        let graph = build_preview_filter_graph(&request, false);

        assert!(graph.contains("select='eq(n\\,12)'"));
        assert!(graph.contains("stats_mode=diff"));
        assert!(graph.contains("diff_mode=rectangle"));
    }

    #[test]
    fn compression_candidates_trade_size_without_changing_dither() {
        let request = NormalizedExportRequest {
            render: NormalizedRenderSettings {
                source_path: PathBuf::from("input.mp4"),
                trim_start: 0.0,
                trim_end: 5.0,
                crop_x: 0,
                crop_y: 0,
                crop_width: 1920,
                crop_height: 1080,
                output_width: 720,
                output_height: 405,
                fps: 20,
                colors: 128,
                dither: "floyd_steinberg",
                overlay_png_data_url: None,
            },
            output_path: PathBuf::from("output.gif"),
            loop_count: 0,
            target_file_size_bytes: Some(1024 * 1024),
            compression_effort: CompressionEffort::Best,
        };

        let candidates = build_compression_candidate_specs(
            &request,
            Some(5 * 1024 * 1024),
            1024 * 1024,
            CompressionEffort::Best,
        );

        assert!(!candidates.is_empty());
        assert!(candidates
            .iter()
            .any(|candidate| candidate.request.render.fps < request.render.fps));
        assert!(candidates
            .iter()
            .any(|candidate| candidate.request.render.colors < request.render.colors));
        assert!(candidates
            .iter()
            .all(|candidate| candidate.request.render.dither == request.render.dither));
    }

    #[test]
    fn compression_effort_limits_candidate_search() {
        let request = NormalizedExportRequest {
            render: NormalizedRenderSettings {
                source_path: PathBuf::from("input.mp4"),
                trim_start: 0.0,
                trim_end: 5.0,
                crop_x: 0,
                crop_y: 0,
                crop_width: 1920,
                crop_height: 1080,
                output_width: 720,
                output_height: 405,
                fps: 20,
                colors: 128,
                dither: "sierra2_4a",
                overlay_png_data_url: None,
            },
            output_path: PathBuf::from("output.gif"),
            loop_count: 0,
            target_file_size_bytes: Some(1024 * 1024),
            compression_effort: CompressionEffort::Balanced,
        };

        let fast = build_compression_candidate_specs(
            &request,
            Some(5 * 1024 * 1024),
            1024 * 1024,
            CompressionEffort::Fast,
        );
        let balanced = build_compression_candidate_specs(
            &request,
            Some(5 * 1024 * 1024),
            1024 * 1024,
            CompressionEffort::Balanced,
        );
        let best = build_compression_candidate_specs(
            &request,
            Some(5 * 1024 * 1024),
            1024 * 1024,
            CompressionEffort::Best,
        );

        assert_eq!(fast.len(), FAST_COMPRESSION_CANDIDATES);
        assert!(balanced.len() <= BALANCED_COMPRESSION_CANDIDATES);
        assert!(balanced.len() > fast.len());
        assert!(best.len() >= balanced.len());
    }
}
