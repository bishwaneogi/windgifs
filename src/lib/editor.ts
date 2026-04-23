export interface Point {
  x: number;
  y: number;
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ZoomedViewportRect extends ViewportRect {}

export interface ViewportOffsetBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResizeHandle =
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "nw";

const MIN_SIZE = 0.05;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getContainedViewport(
  stageWidth: number,
  stageHeight: number,
  mediaWidth: number | null | undefined,
  mediaHeight: number | null | undefined,
): ViewportRect | null {
  if (!stageWidth || !stageHeight || !mediaWidth || !mediaHeight) {
    return null;
  }

  const mediaAspect = mediaWidth / mediaHeight;
  if (!Number.isFinite(mediaAspect) || mediaAspect <= 0) {
    return null;
  }

  const stageAspect = stageWidth / stageHeight;

  if (stageAspect > mediaAspect) {
    const width = stageHeight * mediaAspect;
    return {
      left: (stageWidth - width) / 2,
      top: 0,
      width,
      height: stageHeight,
    };
  }

  const height = stageWidth / mediaAspect;
  return {
    left: 0,
    top: (stageHeight - height) / 2,
    width: stageWidth,
    height,
  };
}

export function getZoomedViewport(
  stageWidth: number,
  stageHeight: number,
  mediaWidth: number | null | undefined,
  mediaHeight: number | null | undefined,
  zoom: number,
): ZoomedViewportRect | null {
  const contained = getContainedViewport(stageWidth, stageHeight, mediaWidth, mediaHeight);
  if (!contained) {
    return null;
  }

  const safeZoom = clamp(zoom, 0.5, 4);
  const width = contained.width * safeZoom;
  const height = contained.height * safeZoom;

  return {
    left: width >= stageWidth ? 0 : (stageWidth - width) / 2,
    top: height >= stageHeight ? 0 : (stageHeight - height) / 2,
    width,
    height,
  };
}

export function getViewportOffsetBounds(
  stageWidth: number,
  stageHeight: number,
  viewport: ViewportRect,
): ViewportOffsetBounds {
  const centeredX = viewport.width >= stageWidth ? 0 : (stageWidth - viewport.width) / 2;
  const centeredY = viewport.height >= stageHeight ? 0 : (stageHeight - viewport.height) / 2;

  return {
    minX: viewport.width > stageWidth ? stageWidth - viewport.width : centeredX,
    maxX: viewport.width > stageWidth ? 0 : centeredX,
    minY: viewport.height > stageHeight ? stageHeight - viewport.height : centeredY,
    maxY: viewport.height > stageHeight ? 0 : centeredY,
  };
}

export function clampViewportOffset(point: Point, bounds: ViewportOffsetBounds): Point {
  return {
    x: clamp(point.x, bounds.minX, bounds.maxX),
    y: clamp(point.y, bounds.minY, bounds.maxY),
  };
}

export function clientPointToNormalized(
  clientX: number,
  clientY: number,
  viewport: ViewportRect,
): Point {
  return {
    x: clamp((clientX - viewport.left) / viewport.width, 0, 1),
    y: clamp((clientY - viewport.top) / viewport.height, 0, 1),
  };
}

export function deltaBetweenPoints(start: Point, current: Point): Point {
  return {
    x: current.x - start.x,
    y: current.y - start.y,
  };
}

export function moveNormalizedRect(rect: NormalizedRect, delta: Point): NormalizedRect {
  const x = clamp(rect.x + delta.x, 0, 1 - rect.width);
  const y = clamp(rect.y + delta.y, 0, 1 - rect.height);

  return {
    ...rect,
    x,
    y,
  };
}

export function resizeNormalizedRect(
  rect: NormalizedRect,
  handle: ResizeHandle,
  delta: Point,
): NormalizedRect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (handle.includes("w")) {
    left += delta.x;
  }

  if (handle.includes("e")) {
    right += delta.x;
  }

  if (handle.includes("n")) {
    top += delta.y;
  }

  if (handle.includes("s")) {
    bottom += delta.y;
  }

  left = clamp(left, 0, 1 - MIN_SIZE);
  top = clamp(top, 0, 1 - MIN_SIZE);
  right = clamp(right, MIN_SIZE, 1);
  bottom = clamp(bottom, MIN_SIZE, 1);

  if (right - left < MIN_SIZE) {
    if (handle.includes("w")) {
      left = right - MIN_SIZE;
    } else {
      right = left + MIN_SIZE;
    }
  }

  if (bottom - top < MIN_SIZE) {
    if (handle.includes("n")) {
      top = bottom - MIN_SIZE;
    } else {
      bottom = top + MIN_SIZE;
    }
  }

  left = clamp(left, 0, 1 - MIN_SIZE);
  top = clamp(top, 0, 1 - MIN_SIZE);
  right = clamp(right, left + MIN_SIZE, 1);
  bottom = clamp(bottom, top + MIN_SIZE, 1);

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

export function normalizedRectToStyle(rect: NormalizedRect): Record<string, string> {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

export function normalizedRectToSvg(rect: NormalizedRect): NormalizedRect {
  return {
    x: rect.x * 1000,
    y: rect.y * 1000,
    width: rect.width * 1000,
    height: rect.height * 1000,
  };
}

export const RESIZE_HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
