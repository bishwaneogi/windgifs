import type { MarkupShape } from "../types";
import type { NormalizedRect, Point } from "./editor";

const ARROW_HEAD_MULTIPLIER = 4.5;
const ARROW_HEAD_MIN = 18;
const ARROW_WING_ANGLE = Math.PI / 7;
const RECT_CORNER_RADIUS = 18;

export interface ArrowGeometry {
  angle: number;
  bounds: NormalizedRect;
  end: Point;
  headLength: number;
  headLeft: Point;
  headRight: Point;
  start: Point;
}

export interface ShapeRenderSpace {
  height: number;
  minDimension: number;
  width: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createShapeRenderSpace(
  width: number | null | undefined,
  height: number | null | undefined,
): ShapeRenderSpace | null {
  if (!width || !height || width <= 0 || height <= 0) {
    return null;
  }

  return {
    width,
    height,
    minDimension: Math.min(width, height),
  };
}

export function getShapeRect(shape: MarkupShape): NormalizedRect {
  return {
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
  };
}

export function getShapeRenderRect(
  shape: MarkupShape,
  renderSpace: ShapeRenderSpace,
): NormalizedRect {
  const rect = getShapeRect(shape);

  return {
    x: rect.x * renderSpace.width,
    y: rect.y * renderSpace.height,
    width: rect.width * renderSpace.width,
    height: rect.height * renderSpace.height,
  };
}

export function getShapeRenderStrokeWidth(
  shape: MarkupShape,
  renderSpace: ShapeRenderSpace,
): number {
  return Math.max(1, (shape.strokeWidth * 3 * renderSpace.minDimension) / 1000);
}

function inflateRect(rect: NormalizedRect, paddingX: number, paddingY: number): NormalizedRect {
  const left = clamp(rect.x - paddingX, 0, 1);
  const top = clamp(rect.y - paddingY, 0, 1);
  const right = clamp(rect.x + rect.width + paddingX, 0, 1);
  const bottom = clamp(rect.y + rect.height + paddingY, 0, 1);

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function buildArrowGeometry(start: Point, end: Point, lineWidth: number): ArrowGeometry {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLength = Math.max(lineWidth * ARROW_HEAD_MULTIPLIER, ARROW_HEAD_MIN);
  const headLeft = {
    x: end.x - headLength * Math.cos(angle - ARROW_WING_ANGLE),
    y: end.y - headLength * Math.sin(angle - ARROW_WING_ANGLE),
  };
  const headRight = {
    x: end.x - headLength * Math.cos(angle + ARROW_WING_ANGLE),
    y: end.y - headLength * Math.sin(angle + ARROW_WING_ANGLE),
  };
  const halfStroke = lineWidth / 2;
  const minX = Math.min(start.x, end.x, headLeft.x, headRight.x) - halfStroke;
  const maxX = Math.max(start.x, end.x, headLeft.x, headRight.x) + halfStroke;
  const minY = Math.min(start.y, end.y, headLeft.y, headRight.y) - halfStroke;
  const maxY = Math.max(start.y, end.y, headLeft.y, headRight.y) + halfStroke;

  return {
    angle,
    bounds: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    },
    end,
    headLength,
    headLeft,
    headRight,
    start,
  };
}

export function buildArrowGeometryFromShape(
  shape: MarkupShape,
  renderSpace: ShapeRenderSpace,
): ArrowGeometry {
  const rect = getShapeRect(shape);
  const start = {
    x: rect.x * renderSpace.width,
    y: (rect.y + rect.height) * renderSpace.height,
  };
  const end = {
    x: (rect.x + rect.width) * renderSpace.width,
    y: rect.y * renderSpace.height,
  };

  return buildArrowGeometry(start, end, getShapeRenderStrokeWidth(shape, renderSpace));
}

export function getArrowSelectionRect(
  shape: MarkupShape,
  renderSpace: ShapeRenderSpace,
): NormalizedRect {
  const bounds = buildArrowGeometryFromShape(shape, renderSpace).bounds;

  return {
    x: clamp(bounds.x / renderSpace.width, 0, 1),
    y: clamp(bounds.y / renderSpace.height, 0, 1),
    width: clamp(bounds.width / renderSpace.width, 0, 1),
    height: clamp(bounds.height / renderSpace.height, 0, 1),
  };
}

export function getShapeSelectionRect(
  shape: MarkupShape,
  renderSpace: ShapeRenderSpace,
): NormalizedRect {
  if (shape.kind === "arrow") {
    return getArrowSelectionRect(shape, renderSpace);
  }

  const halfStroke = getShapeRenderStrokeWidth(shape, renderSpace) / 2;
  return inflateRect(
    getShapeRect(shape),
    halfStroke / renderSpace.width,
    halfStroke / renderSpace.height,
  );
}

export function getShapeRenderCornerRadius(
  shape: MarkupShape,
  renderSpace: ShapeRenderSpace,
): number {
  if (shape.kind !== "rect") {
    return 0;
  }

  return (RECT_CORNER_RADIUS * renderSpace.minDimension) / 1000;
}
