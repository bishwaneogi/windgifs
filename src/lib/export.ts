import type { EditorProject, GifExportRequest, GifPreviewRequest } from "../types";
import { getOutputDimensions, getPreviewExportWidth, getResolvedExportWidth } from "./project";
import {
  buildArrowGeometry,
  createShapeRenderSpace,
  getShapeRenderCornerRadius,
  getShapeRenderStrokeWidth,
} from "./shape-geometry";

function splitPath(path: string): { dir: string; fileName: string } {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

  if (separatorIndex < 0) {
    return {
      dir: "",
      fileName: path,
    };
  }

  return {
    dir: path.slice(0, separatorIndex + 1),
    fileName: path.slice(separatorIndex + 1),
  };
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "");
}

function makeStrokeStyle(hexColor: string, opacity: number): string {
  const red = Number.parseInt(hexColor.slice(1, 3), 16);
  const green = Number.parseInt(hexColor.slice(3, 5), 16);
  const blue = Number.parseInt(hexColor.slice(5, 7), 16);

  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));

  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function renderArrow(
  context: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  lineWidth: number,
) {
  const geometry = buildArrowGeometry(
    { x: startX, y: startY },
    { x: endX, y: endY },
    lineWidth,
  );

  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.stroke();

  context.beginPath();
  context.moveTo(geometry.end.x, geometry.end.y);
  context.lineTo(geometry.headLeft.x, geometry.headLeft.y);
  context.lineTo(geometry.headRight.x, geometry.headRight.y);
  context.closePath();
  context.fill();
}

export function buildDefaultOutputPath(sourcePath: string | null, fileName: string): string {
  const safeFileName = stripExtension(fileName) || "windgifs-export";

  if (!sourcePath) {
    return `${safeFileName}-windgifs.gif`;
  }

  const { dir, fileName: sourceFileName } = splitPath(sourcePath);
  const baseName = stripExtension(sourceFileName) || safeFileName;
  return `${dir}${baseName}-windgifs.gif`;
}

export function renderMarkupOverlayPng(project: EditorProject): string | null {
  if (!project.inspection || project.markup.length === 0) {
    return null;
  }

  const output = getOutputDimensions(project);
  if (!output) {
    return null;
  }

  const crop = project.crop.enabled
    ? project.crop
    : {
        enabled: false,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      };

  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const renderSpace = createShapeRenderSpace(canvas.width, canvas.height);
  if (!renderSpace) {
    return null;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const shape of project.markup) {
    const x = ((shape.x - crop.x) / crop.width) * canvas.width;
    const y = ((shape.y - crop.y) / crop.height) * canvas.height;
    const width = (shape.width / crop.width) * canvas.width;
    const height = (shape.height / crop.height) * canvas.height;
    const lineWidth = getShapeRenderStrokeWidth(shape, renderSpace);

    context.strokeStyle = makeStrokeStyle(shape.color, shape.opacity);
    context.fillStyle = makeStrokeStyle(shape.color, shape.opacity);
    context.lineWidth = lineWidth;

    if (shape.kind === "rect") {
      drawRoundedRect(context, x, y, width, height, getShapeRenderCornerRadius(shape, renderSpace));
      context.stroke();
      continue;
    }

    if (shape.kind === "ellipse") {
      context.beginPath();
      context.ellipse(
        x + width / 2,
        y + height / 2,
        Math.abs(width / 2),
        Math.abs(height / 2),
        0,
        0,
        Math.PI * 2,
      );
      context.stroke();
      continue;
    }

    renderArrow(context, x, y + height, x + width, y, lineWidth);
  }

  return canvas.toDataURL("image/png");
}

export function buildGifExportRequest(
  project: EditorProject,
  outputPath: string,
  overlayPngDataUrl: string | null,
): GifExportRequest {
  const resolvedWidth = getResolvedExportWidth(project) ?? project.export.width;
  const targetFileSizeBytes = project.export.targetFileSizeEnabled
    ? Math.max(256 * 1024, Math.round(project.export.targetFileSizeMb * 1024 * 1024))
    : null;

  return {
    sourcePath: project.source.sourcePath ?? "",
    outputPath,
    trim: project.trim,
    crop: project.crop,
    export: {
      width: resolvedWidth,
      fps: project.export.fps,
      colors: project.export.colors,
      dither: project.export.dither,
      loop: project.export.loop,
      targetFileSizeBytes,
    },
    overlayPngDataUrl,
  };
}

export function buildGifPreviewRequest(
  project: EditorProject,
  frameTimeSeconds: number | null,
  overlayPngDataUrl: string | null,
): GifPreviewRequest {
  const resolvedWidth = getPreviewExportWidth(project) ?? getResolvedExportWidth(project) ?? project.export.width;

  return {
    sourcePath: project.source.sourcePath ?? "",
    trim: project.trim,
    crop: project.crop,
    export: {
      width: resolvedWidth,
      fps: project.export.fps,
      colors: project.export.colors,
      dither: project.export.dither,
      loop: project.export.loop,
      targetFileSizeBytes: null,
    },
    overlayPngDataUrl,
    frameTimeSeconds,
  };
}
