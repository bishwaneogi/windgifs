import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  FfmpegStatus,
  GifExportRequest,
  GifExportResult,
  GifPreviewRequest,
  GifPreviewResult,
  VideoInspection,
} from "../types";

const browserStatus: FfmpegStatus = {
  available: false,
  ffmpegPath: null,
  ffprobePath: null,
  source: "browser-preview",
  message:
    "Frontend preview is running without the native Tauri backend. FFmpeg checks resume inside the desktop app.",
};

export function isDesktopApp(): boolean {
  return isTauri();
}

export function getPreviewUrlForPath(path: string | null): string | null {
  const trimmedPath = path?.trim().replace(/^"(.*)"$/, "$1");
  if (!trimmedPath) {
    return null;
  }

  if (!isDesktopApp()) {
    return null;
  }

  try {
    return convertFileSrc(trimmedPath);
  } catch {
    return null;
  }
}

export async function loadFfmpegStatus(): Promise<FfmpegStatus> {
  if (!isDesktopApp()) {
    return browserStatus;
  }

  try {
    return await invoke<FfmpegStatus>("get_ffmpeg_status");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to inspect FFmpeg availability.";

    return {
      available: false,
      ffmpegPath: null,
      ffprobePath: null,
      source: "unavailable",
      message,
    };
  }
}

export async function inspectVideoPath(path: string): Promise<VideoInspection> {
  if (!isDesktopApp()) {
    throw new Error("Path inspection requires the Tauri desktop backend.");
  }

  return invoke<VideoInspection>("inspect_video", { path });
}

export async function exportGif(request: GifExportRequest): Promise<GifExportResult> {
  if (!isDesktopApp()) {
    throw new Error("GIF export requires the Tauri desktop backend.");
  }

  return invoke<GifExportResult>("export_gif", { request });
}

export async function renderGifPreview(request: GifPreviewRequest): Promise<GifPreviewResult> {
  if (!isDesktopApp()) {
    throw new Error("GIF preview requires the Tauri desktop backend.");
  }

  return invoke<GifPreviewResult>("render_quality_preview", { request });
}

export async function pickVideoPaths(): Promise<string[]> {
  if (!isDesktopApp()) {
    return [];
  }

  const selected = await open({
    multiple: true,
    directory: false,
    filters: [
      {
        name: "Video",
        extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"],
      },
    ],
  });

  if (Array.isArray(selected)) {
    return selected.filter((path): path is string => typeof path === "string");
  }

  return typeof selected === "string" ? [selected] : [];
}

export async function pickVideoPath(): Promise<string | null> {
  const [selectedPath] = await pickVideoPaths();
  return selectedPath ?? null;
}

export async function pickGifOutputPath(defaultPath: string): Promise<string | null> {
  if (!isDesktopApp()) {
    return null;
  }

  const selected = await save({
    defaultPath,
    filters: [
      {
        name: "GIF",
        extensions: ["gif"],
      },
    ],
  });

  return typeof selected === "string" ? selected : null;
}

export async function appendDebugLog(message: string): Promise<void> {
  if (!isDesktopApp()) {
    return;
  }

  await invoke("append_debug_log", { message });
}
