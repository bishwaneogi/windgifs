export type MetadataSource = "ffprobe" | "html-video";

export type DitherMode = "bayer" | "floyd_steinberg" | "none" | "sierra2_4a";
export type ExportPresetId = "balanced" | "high" | "small";
export type ShapeKind = "arrow" | "ellipse" | "rect";

export interface SourceMedia {
  fileName: string;
  previewUrl: string | null;
  sourcePath: string | null;
  fileSizeBytes: number | null;
}

export interface VideoInspection {
  sourcePath: string | null;
  fileName: string;
  fileSizeBytes: number | null;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number | null;
  hasAudio: boolean | null;
  videoCodec: string | null;
  formatName: string | null;
  metadataSource: MetadataSource;
}

export interface TrimRange {
  start: number;
  end: number;
}

export interface CropRegion {
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MarkupShape {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
  opacity: number;
}

export interface ExportSettings {
  presetId: ExportPresetId;
  width: number;
  useSourceResolution: boolean;
  fps: number;
  colors: number;
  dither: DitherMode;
  loop: boolean;
  targetFileSizeEnabled: boolean;
  targetFileSizeMb: number;
}

export interface EditorProject {
  source: SourceMedia;
  inspection: VideoInspection | null;
  trim: TrimRange;
  crop: CropRegion;
  markup: MarkupShape[];
  export: ExportSettings;
}

export interface FfmpegStatus {
  available: boolean;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  source: "browser-preview" | "system-path" | "unavailable" | "workspace-tools";
  message: string;
}

export interface NativeExportSettings {
  width: number;
  fps: number;
  colors: number;
  dither: DitherMode;
  loop: boolean;
  targetFileSizeBytes: number | null;
}

export interface GifExportRequest {
  sourcePath: string;
  outputPath: string;
  trim: TrimRange;
  crop: CropRegion;
  export: NativeExportSettings;
  overlayPngDataUrl: string | null;
}

export interface GifPreviewRequest {
  sourcePath: string;
  trim: TrimRange;
  crop: CropRegion;
  export: NativeExportSettings;
  overlayPngDataUrl: string | null;
  frameTimeSeconds: number | null;
}

export interface GifExportResult {
  outputPath: string;
  fileSizeBytes: number | null;
  width: number;
  height: number;
  durationSeconds: number;
  usedOverlay: boolean;
}

export interface GifPreviewResult {
  dataUrl: string;
  width: number;
  height: number;
}
