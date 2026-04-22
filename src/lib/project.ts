import type {
  CropRegion,
  DitherMode,
  EditorProject,
  ExportSettings,
  ExportPresetId,
  MarkupShape,
  ShapeKind,
  SourceMedia,
  TrimRange,
  VideoInspection,
} from "../types";

type ExportPresetDefinition = Pick<
  ExportSettings,
  "presetId" | "width" | "fps" | "colors" | "dither" | "loop"
> & {
  label: string;
};

const DEFAULT_CROP: CropRegion = {
  enabled: true,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

const DEFAULT_TRIM: TrimRange = {
  start: 0,
  end: 0,
};

const MIN_REGION = 0.05;

export const EXPORT_PRESETS: Record<ExportPresetId, ExportPresetDefinition> = {
  small: {
    presetId: "small",
    label: "Small",
    width: 360,
    fps: 12,
    colors: 48,
    dither: "bayer",
    loop: true,
  },
  balanced: {
    presetId: "balanced",
    label: "Balanced",
    width: 540,
    fps: 15,
    colors: 96,
    dither: "sierra2_4a",
    loop: true,
  },
  high: {
    presetId: "high",
    label: "High",
    width: 720,
    fps: 20,
    colors: 128,
    dither: "floyd_steinberg",
    loop: true,
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nextShapeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `shape-${Date.now()}-${Math.random()}`;
}

function createDefaultExportSettings(width?: number): ExportSettings {
  const preset = EXPORT_PRESETS.balanced;
  const { label: _label, ...baseExport } = preset;
  return {
    ...baseExport,
    width: width ? Math.min(width, baseExport.width) : baseExport.width,
    useSourceResolution: false,
    targetFileSizeEnabled: false,
    targetFileSizeMb: 4,
  };
}

export function buildDraftProject(source: SourceMedia): EditorProject {
  return {
    source,
    inspection: null,
    trim: DEFAULT_TRIM,
    crop: DEFAULT_CROP,
    markup: [],
    export: createDefaultExportSettings(),
  };
}

export function clampTrim(trim: TrimRange, durationSeconds: number): TrimRange {
  const safeDuration = Math.max(0, durationSeconds);
  const start = clamp(trim.start, 0, safeDuration);
  const end = clamp(trim.end || safeDuration, start, safeDuration);

  return {
    start,
    end,
  };
}

export function clampCrop(crop: CropRegion): CropRegion {
  const x = clamp(crop.x, 0, 1 - MIN_REGION);
  const y = clamp(crop.y, 0, 1 - MIN_REGION);
  const width = clamp(crop.width, MIN_REGION, 1 - x);
  const height = clamp(crop.height, MIN_REGION, 1 - y);

  return {
    enabled: crop.enabled,
    x,
    y,
    width,
    height,
  };
}

export function clampShape(shape: MarkupShape): MarkupShape {
  const x = clamp(shape.x, 0, 1 - MIN_REGION);
  const y = clamp(shape.y, 0, 1 - MIN_REGION);
  const width = clamp(shape.width, MIN_REGION, 1 - x);
  const height = clamp(shape.height, MIN_REGION, 1 - y);

  return {
    ...shape,
    x,
    y,
    width,
    height,
    strokeWidth: clamp(shape.strokeWidth, 1, 16),
    opacity: clamp(shape.opacity, 0.1, 1),
  };
}

export function updateExportPreset(
  project: EditorProject,
  presetId: ExportPresetId,
): EditorProject {
  const preset = EXPORT_PRESETS[presetId];
  const { label: _label, ...baseExport } = preset;
  const nextWidth = project.inspection
    ? Math.min(project.inspection.width, baseExport.width)
    : baseExport.width;

  return {
    ...project,
    export: {
      ...baseExport,
      width: nextWidth,
      useSourceResolution: project.export.useSourceResolution,
      targetFileSizeEnabled: project.export.targetFileSizeEnabled,
      targetFileSizeMb: project.export.targetFileSizeMb,
    },
  };
}

export function applyInspectionToProject(
  project: EditorProject,
  inspection: VideoInspection,
): EditorProject {
  const nextTrim = project.inspection
    ? clampTrim(project.trim, inspection.durationSeconds)
    : {
        start: 0,
        end: inspection.durationSeconds,
      };

  return {
    ...project,
    source: {
      ...project.source,
      fileName: inspection.fileName,
      sourcePath: inspection.sourcePath,
      fileSizeBytes: inspection.fileSizeBytes ?? project.source.fileSizeBytes,
    },
    inspection,
    trim: nextTrim,
    crop: project.inspection ? clampCrop(project.crop) : DEFAULT_CROP,
    export: {
      ...project.export,
      width: Math.min(project.export.width, inspection.width),
    },
  };
}

function shapeColor(kind: ShapeKind): string {
  switch (kind) {
    case "ellipse":
      return "#f4c95d";
    case "arrow":
      return "#40c0cb";
    default:
      return "#ff6b57";
  }
}

export function addMarkupShape(project: EditorProject, kind: ShapeKind): EditorProject {
  const offset = project.markup.length * 0.04;
  const shape = clampShape({
    id: nextShapeId(),
    kind,
    x: 0.18 + offset,
    y: 0.18 + offset,
    width: kind === "arrow" ? 0.34 : 0.26,
    height: kind === "arrow" ? 0.24 : 0.2,
    color: shapeColor(kind),
    strokeWidth: 4,
    opacity: 0.92,
  });

  return {
    ...project,
    markup: [...project.markup, shape],
  };
}

export function getSourceOutputDimensions(
  project: EditorProject,
): { height: number; width: number } | null {
  const inspection = project.inspection;
  if (!inspection) {
    return null;
  }

  const crop = project.crop.enabled ? project.crop : DEFAULT_CROP;

  return {
    width: Math.max(1, Math.round(inspection.width * crop.width)),
    height: Math.max(1, Math.round(inspection.height * crop.height)),
  };
}

export function getResolvedExportWidth(project: EditorProject): number | null {
  const sourceOutput = getSourceOutputDimensions(project);
  if (!sourceOutput) {
    return null;
  }

  if (project.export.useSourceResolution) {
    return sourceOutput.width;
  }

  return Math.min(project.export.width, sourceOutput.width);
}

export function getPreviewExportWidth(project: EditorProject): number | null {
  const resolvedWidth = getResolvedExportWidth(project);
  if (!resolvedWidth) {
    return null;
  }

  if (!project.export.targetFileSizeEnabled || project.export.targetFileSizeMb <= 0) {
    return resolvedWidth;
  }

  const estimatedBytes = estimateGifSizeBytes(project);
  const targetBytes = Math.max(256 * 1024, Math.round(project.export.targetFileSizeMb * 1024 * 1024));
  if (!estimatedBytes || estimatedBytes <= targetBytes) {
    return resolvedWidth;
  }

  const minimumWidth = Math.min(160, resolvedWidth);
  const predictedWidth = Math.round(resolvedWidth * Math.sqrt(targetBytes / estimatedBytes) * 0.98);

  return Math.max(minimumWidth, Math.min(resolvedWidth, predictedWidth));
}

export function getOutputDimensions(
  project: EditorProject,
): { height: number; width: number } | null {
  const sourceOutput = getSourceOutputDimensions(project);
  const outputWidth = getResolvedExportWidth(project);

  if (!sourceOutput || !outputWidth) {
    return null;
  }

  if (project.export.useSourceResolution) {
    return sourceOutput;
  }

  const aspectRatio = sourceOutput.width / sourceOutput.height;

  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return null;
  }

  return {
    width: outputWidth,
    height: Math.max(1, Math.round(outputWidth / aspectRatio)),
  };
}

export function estimateGifSizeBytes(project: EditorProject): number | null {
  const inspection = project.inspection;
  const output = getOutputDimensions(project);

  if (!inspection || !output) {
    return null;
  }

  const duration = Math.max(0.2, project.trim.end - project.trim.start);
  const frameCount = duration * project.export.fps;
  const ditherFactor =
    project.export.dither === "none"
      ? 0.82
      : project.export.dither === "bayer"
        ? 1
        : 1.08;

  const paletteFactor = clamp(project.export.colors / 128, 0.2, 2);
  const rawEstimate = output.width * output.height * frameCount * 0.095 * paletteFactor * ditherFactor;

  return Math.round(rawEstimate);
}

function cropPlan(project: EditorProject): string {
  const inspection = project.inspection;
  if (!inspection) {
    return "Crop: waiting for dimensions";
  }

  if (!project.crop.enabled) {
    return "Crop: disabled";
  }

  const x = Math.round(project.crop.x * inspection.width);
  const y = Math.round(project.crop.y * inspection.height);
  const width = Math.round(project.crop.width * inspection.width);
  const height = Math.round(project.crop.height * inspection.height);

  return `Crop: ${width}x${height} at (${x}, ${y})`;
}

export function serializeExportPlan(project: EditorProject): string[] {
  const output = getOutputDimensions(project);

  return [
    `Trim: ${project.trim.start.toFixed(1)}s to ${project.trim.end.toFixed(1)}s`,
    cropPlan(project),
    output
      ? `Scale: ${output.width}x${output.height} at ${project.export.fps} fps`
      : "Scale: waiting for source dimensions",
    `Palette: ${project.export.colors} colors with ${formatDitherLabel(project.export.dither)}`,
    `Markup: ${project.markup.length} shape${project.markup.length === 1 ? "" : "s"} staged`,
  ];
}

export function formatDitherLabel(mode: DitherMode): string {
  switch (mode) {
    case "floyd_steinberg":
      return "Floyd-Steinberg";
    case "sierra2_4a":
      return "Sierra 2-4A";
    case "bayer":
      return "Bayer";
    default:
      return "None";
  }
}

export function createFullCropRegion(): CropRegion {
  return {
    enabled: false,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };
}
