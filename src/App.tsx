import {
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
  type WheelEvent as ReactWheelEvent,
  startTransition,
  useEffect,
  useDeferredValue,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";
import {
  buildDefaultOutputPath,
  buildGifExportRequest,
  buildGifPreviewRequest,
  renderMarkupOverlayPng,
} from "./lib/export";
import {
  clientPointToNormalized,
  deltaBetweenPoints,
  getZoomedViewport,
  moveNormalizedRect,
  normalizedRectToStyle,
  RESIZE_HANDLES,
  resizeNormalizedRect,
  type NormalizedRect,
  type Point,
  type ResizeHandle,
} from "./lib/editor";
import {
  buildArrowGeometryFromShape,
  createShapeRenderSpace,
  getShapeRect,
  getShapeRenderCornerRadius,
  getShapeRenderRect,
  getShapeSelectionRect,
  getShapeRenderStrokeWidth,
  type ShapeRenderSpace,
} from "./lib/shape-geometry";
import {
  EXPORT_PRESETS,
  addMarkupShape,
  applyInspectionToProject,
  buildDraftProject,
  clampCrop,
  clampShape,
  clampTrim,
  estimateGifSizeBytes,
  getOutputDimensions,
  getSourceOutputDimensions,
  updateExportPreset,
} from "./lib/project";
import {
  exportGif,
  getPreviewUrlForPath,
  inspectVideoPath,
  isDesktopApp,
  loadFfmpegStatus,
  pickGifOutputPath,
  pickVideoPath,
  renderGifPreview,
} from "./lib/native";
import type {
  CropRegion,
  EditorProject,
  FfmpegStatus,
  GifExportResult,
  GifPreviewResult,
  MarkupShape,
  ShapeKind,
  TrimRange,
  VideoInspection,
} from "./types";

const AUTO_TEST_SOURCE_PATH =
  import.meta.env.VITE_WINDGIFS_TEST_SOURCE_PATH?.trim().replace(/^"(.*)"$/, "$1") || null;

type EditorMode = "crop" | "shape";
type ArrowEndpoint = "start" | "end";

type InteractionState =
  | {
      kind: "crop-move";
      startPoint: Point;
      startRect: NormalizedRect;
    }
  | {
      kind: "crop-resize";
      handle: ResizeHandle;
      startPoint: Point;
      startRect: NormalizedRect;
    }
  | {
      kind: "shape-move";
      shapeId: string;
      startPoint: Point;
      startRect: NormalizedRect;
    }
  | {
      kind: "shape-resize";
      handle: ResizeHandle;
      shapeId: string;
      startPoint: Point;
      startRect: NormalizedRect;
    }
  | {
      kind: "arrow-endpoint";
      endpoint: ArrowEndpoint;
      shapeId: string;
      startPoint: Point;
      startRect: NormalizedRect;
    };

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) {
    return "Unknown";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatSeconds(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) {
    return "0.0s";
  }

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toFixed(1)}s`;
}

function formatTimelineTime(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) {
    return "0:00.0";
  }

  const wholeMinutes = Math.floor(seconds / 60);
  const remainder = seconds - wholeMinutes * 60;
  const remainderLabel =
    remainder >= 10 ? remainder.toFixed(1) : `0${remainder.toFixed(1)}`;

  return `${wholeMinutes}:${remainderLabel}`;
}

function asNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function truncateMiddle(value: string | null | undefined, head = 30, tail = 22): string {
  if (!value) {
    return "None";
  }

  if (value.length <= head + tail + 3) {
    return value;
  }

  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function buildHtmlVideoInspection(
  project: EditorProject,
  element: HTMLVideoElement,
): VideoInspection | null {
  if (!element.videoWidth || !element.videoHeight || !Number.isFinite(element.duration)) {
    return null;
  }

  return {
    sourcePath: project.source.sourcePath,
    fileName: project.source.fileName,
    fileSizeBytes: project.source.fileSizeBytes,
    width: element.videoWidth,
    height: element.videoHeight,
    durationSeconds: element.duration,
    frameRate: project.inspection?.frameRate ?? null,
    hasAudio: project.inspection?.hasAudio ?? null,
    videoCodec: project.inspection?.videoCodec ?? null,
    formatName: project.inspection?.formatName ?? null,
    metadataSource: project.inspection?.metadataSource ?? "html-video",
  };
}

function shouldReuseProjectForInspection(
  previousProject: EditorProject | null,
  inspection: VideoInspection,
): boolean {
  if (!previousProject) {
    return false;
  }

  if (
    previousProject.source.sourcePath &&
    previousProject.source.sourcePath === inspection.sourcePath
  ) {
    return true;
  }

  return (
    !previousProject.source.sourcePath &&
    previousProject.source.fileName === inspection.fileName &&
    previousProject.source.fileSizeBytes === inspection.fileSizeBytes
  );
}

function rectFromCrop(crop: CropRegion): NormalizedRect {
  return {
    x: crop.x,
    y: crop.y,
    width: crop.width,
    height: crop.height,
  };
}

function getVisibleCropRegion(project: EditorProject | null, useOutputView: boolean): CropRegion {
  if (useOutputView && project?.crop.enabled) {
    return project.crop;
  }

  return {
    enabled: false,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };
}

function projectRectToVisibleCrop(
  rect: NormalizedRect,
  visibleCrop: CropRegion,
): NormalizedRect {
  return {
    x: (rect.x - visibleCrop.x) / visibleCrop.width,
    y: (rect.y - visibleCrop.y) / visibleCrop.height,
    width: rect.width / visibleCrop.width,
    height: rect.height / visibleCrop.height,
  };
}

function projectShapeToVisibleCrop(
  shape: MarkupShape,
  visibleCrop: CropRegion,
): MarkupShape {
  const projectedRect = projectRectToVisibleCrop(getShapeRect(shape), visibleCrop);

  return {
    ...shape,
    ...projectedRect,
  };
}

function resolveHandlePosition(rect: NormalizedRect, handle: ResizeHandle): Point {
  const horizontal =
    handle.includes("w") ? rect.x : handle.includes("e") ? rect.x + rect.width : rect.x + rect.width / 2;
  const vertical =
    handle.includes("n") ? rect.y : handle.includes("s") ? rect.y + rect.height : rect.y + rect.height / 2;

  return {
    x: horizontal,
    y: vertical,
  };
}

function buildHandleStyle(rect: NormalizedRect, handle: ResizeHandle): CSSProperties {
  const point = resolveHandlePosition(rect, handle);

  return {
    left: `${point.x * 100}%`,
    top: `${point.y * 100}%`,
  };
}

function buildSelectionHandleStyle(handle: ResizeHandle): CSSProperties {
  return buildHandleStyle({ x: 0, y: 0, width: 1, height: 1 }, handle);
}

function buildSelectionOutlineStyle(
  shape: MarkupShape,
  renderSpace: ShapeRenderSpace | null,
): CSSProperties | undefined {
  if (shape.kind !== "rect" || !renderSpace) {
    return undefined;
  }

  const halfStroke = getShapeRenderStrokeWidth(shape, renderSpace) / 2;
  const radius = getShapeRenderCornerRadius(shape, renderSpace) + halfStroke;

  return {
    borderRadius: `${radius}px`,
  };
}

function buildSurfaceHint(
  project: EditorProject | null,
  editorMode: EditorMode,
  selectedShape: MarkupShape | null,
): string {
  if (!project) {
    return "Open a video to start.";
  }

  if (editorMode === "crop") {
    return project.crop.enabled ? "Drag to move crop. Use handles to resize." : "Enable crop to edit it.";
  }

  if (selectedShape) {
    return selectedShape.kind === "arrow"
      ? "Drag the arrow or move its endpoints."
      : "Drag the layer or use the handles to resize.";
  }

  return "Select or add a shape.";
}

function resolveQualityPreviewFrameTime(
  project: EditorProject | null,
  frameTimeSeconds: number | null,
): number | null {
  const inspection = project?.inspection;
  if (!inspection) {
    return null;
  }

  const trimStart = project.trim.start;
  const trimEnd = project.trim.end || inspection.durationSeconds;
  const fallbackTime = Math.min(trimEnd, Math.max(trimStart, trimStart + 0.1));
  const requestedTime = frameTimeSeconds ?? fallbackTime;

  return Math.min(trimEnd, Math.max(trimStart, requestedTime));
}

function getArrowStartPoint(rect: NormalizedRect): Point {
  return {
    x: rect.x,
    y: rect.y + rect.height,
  };
}

function getArrowEndPoint(rect: NormalizedRect): Point {
  return {
    x: rect.x + rect.width,
    y: rect.y,
  };
}

function buildPointStyle(point: Point): CSSProperties {
  return {
    left: `${point.x * 100}%`,
    top: `${point.y * 100}%`,
  };
}

function buildCropEdgeStyle(crop: NormalizedRect, handle: "n" | "e" | "s" | "w"): CSSProperties {
  if (handle === "n") {
    return {
      left: `calc(${crop.x * 100}% + 14px)`,
      top: `${crop.y * 100}%`,
      width: `max(0px, calc(${crop.width * 100}% - 28px))`,
      height: "24px",
      transform: "translateY(-50%)",
    };
  }

  if (handle === "s") {
    return {
      left: `calc(${crop.x * 100}% + 14px)`,
      top: `${(crop.y + crop.height) * 100}%`,
      width: `max(0px, calc(${crop.width * 100}% - 28px))`,
      height: "24px",
      transform: "translateY(-50%)",
    };
  }

  if (handle === "e") {
    return {
      left: `${(crop.x + crop.width) * 100}%`,
      top: `calc(${crop.y * 100}% + 14px)`,
      width: "24px",
      height: `max(0px, calc(${crop.height * 100}% - 28px))`,
      transform: "translateX(-50%)",
    };
  }

  return {
    left: `${crop.x * 100}%`,
    top: `calc(${crop.y * 100}% + 14px)`,
    width: "24px",
    height: `max(0px, calc(${crop.height * 100}% - 28px))`,
    transform: "translateX(-50%)",
  };
}

function renderShapeHitTarget(
  shape: MarkupShape,
  rect: NormalizedRect,
  renderSpace: ShapeRenderSpace,
  onPointerDown: (event: ReactPointerEvent<SVGElement>) => void,
) {
  if (shape.kind === "rect") {
    return (
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        rx={getShapeRenderCornerRadius(shape, renderSpace)}
        fill="rgba(0, 0, 0, 0.001)"
        stroke="none"
        pointerEvents="all"
        onPointerDown={onPointerDown}
      />
    );
  }

  if (shape.kind === "ellipse") {
    return (
      <ellipse
        cx={rect.x + rect.width / 2}
        cy={rect.y + rect.height / 2}
        rx={rect.width / 2}
        ry={rect.height / 2}
        fill="rgba(0, 0, 0, 0.001)"
        stroke="none"
        pointerEvents="all"
        onPointerDown={onPointerDown}
      />
    );
  }

  return null;
}

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);
  const qualityPreviewRequestIdRef = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const lastAutoOutputPathRef = useRef("");
  const didAutoLoadTestSourceRef = useRef(false);
  const [project, setProject] = useState<EditorProject | null>(null);
  const [ffmpegStatus, setFfmpegStatus] = useState<FfmpegStatus | null>(null);
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [pathState, setPathState] = useState<"idle" | "loading">("idle");
  const [dragActive, setDragActive] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [lastExportResult, setLastExportResult] = useState<GifExportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("shape");
  const [interaction, setInteraction] = useState<InteractionState | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [qualityPreview, setQualityPreview] = useState<GifPreviewResult | null>(null);
  const [qualityPreviewFrameTime, setQualityPreviewFrameTime] = useState<number | null>(null);
  const [isRenderingQualityPreview, setIsRenderingQualityPreview] = useState(false);
  const [qualityPreviewFailed, setQualityPreviewFailed] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const deferredPreviewProject = useDeferredValue(project);

  useEffect(() => {
    let cancelled = false;

    void loadFfmpegStatus().then((status) => {
      if (!cancelled) {
        setFfmpegStatus(status);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!project) {
      return;
    }

    const autoPath = buildDefaultOutputPath(project.source.sourcePath, project.source.fileName);

    setOutputPath((previousPath) => {
      if (!previousPath || previousPath === lastAutoOutputPathRef.current) {
        return autoPath;
      }

      return previousPath;
    });

    lastAutoOutputPathRef.current = autoPath;
  }, [project?.source.fileName, project?.source.sourcePath]);

  useEffect(() => {
    if (
      !AUTO_TEST_SOURCE_PATH ||
      didAutoLoadTestSourceRef.current ||
      project ||
      pathState === "loading"
    ) {
      return;
    }

    didAutoLoadTestSourceRef.current = true;
    setManualPath(AUTO_TEST_SOURCE_PATH);
    void loadSourcePath(AUTO_TEST_SOURCE_PATH);
  }, [pathState, project]);

  useEffect(() => {
    if (selectedShapeId && !project?.markup.some((shape) => shape.id === selectedShapeId)) {
      setSelectedShapeId(null);
    }
  }, [project?.markup, selectedShapeId]);

  useEffect(() => {
    qualityPreviewRequestIdRef.current += 1;
    setQualityPreview(null);
    setQualityPreviewFailed(false);
    setQualityPreviewFrameTime(null);
    setIsRenderingQualityPreview(false);
    setPreviewZoom(1);
    setPlaybackTime(0);
    setIsPlaying(false);
  }, [project?.source.fileName, project?.source.previewUrl, project?.source.sourcePath]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) {
      return;
    }

    const updateStageSize = () => {
      setStageSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    };

    updateStageSize();

    const observer = new ResizeObserver(updateStageSize);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  const handleWindowDrop = useEffectEvent((event: { payload: { type: string; paths?: string[] } }) => {
    if (event.payload.type !== "drop") {
      return;
    }

    const firstPath = event.payload.paths?.[0];
    if (!firstPath) {
      return;
    }

    setManualPath(firstPath);
    void loadSourcePath(firstPath);
  });

  useEffect(() => {
    if (!isDesktopApp()) {
      return;
    }

    let cleanup: (() => void) | undefined;

    void getCurrentWindow()
      .onDragDropEvent(handleWindowDrop)
      .then((unlisten) => {
        cleanup = unlisten;
      })
      .catch(() => {
        setInfoMessage("Window drop listening is unavailable in this preview session.");
      });

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (
      !deferredPreviewProject?.inspection ||
      !deferredPreviewProject.source.sourcePath ||
      !ffmpegStatus?.available ||
      isExporting
    ) {
      setIsRenderingQualityPreview(false);
      return;
    }

    const frameTime = resolveQualityPreviewFrameTime(
      deferredPreviewProject,
      qualityPreviewFrameTime,
    );
    if (frameTime === null) {
      return;
    }

    const requestId = qualityPreviewRequestIdRef.current + 1;
    qualityPreviewRequestIdRef.current = requestId;
    let disposed = false;
    const timeoutId = window.setTimeout(() => {
      if (disposed) {
        return;
      }

      setIsRenderingQualityPreview(true);

      void (async () => {
        try {
          const overlayPngDataUrl = renderMarkupOverlayPng(deferredPreviewProject);
          const result = await renderGifPreview(
            buildGifPreviewRequest(deferredPreviewProject, frameTime, overlayPngDataUrl),
          );

          if (disposed || qualityPreviewRequestIdRef.current !== requestId) {
            return;
          }

          startTransition(() => {
            setQualityPreview(result);
            setQualityPreviewFailed(false);
          });
        } catch {
          if (disposed || qualityPreviewRequestIdRef.current !== requestId) {
            return;
          }

          startTransition(() => {
            setQualityPreviewFailed(true);
          });
        } finally {
          if (!disposed && qualityPreviewRequestIdRef.current === requestId) {
            setIsRenderingQualityPreview(false);
          }
        }
      })();
    }, 180);

    return () => {
      disposed = true;
      clearTimeout(timeoutId);
    };
  }, [deferredPreviewProject, ffmpegStatus?.available, isExporting, qualityPreviewFrameTime]);

  function replacePreviewObjectUrl(nextUrl: string | null) {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }

    previewObjectUrlRef.current = nextUrl;
  }

  function createPreviewProject(file: File) {
    replacePreviewObjectUrl(URL.createObjectURL(file));
    const sourcePath = project?.source.sourcePath ?? (manualPath.trim() || null);

    const nextProject = buildDraftProject({
      fileName: file.name,
      previewUrl: previewObjectUrlRef.current,
      sourcePath,
      fileSizeBytes: file.size,
    });

    setProject(nextProject);
    setSelectedShapeId(null);
    setErrorMessage(null);
    setInfoMessage("Preview loaded.");
  }

  function importPreviewFile(file: File | null | undefined) {
    if (!file) {
      return;
    }

    if (!file.type.startsWith("video/")) {
      setErrorMessage("Drop or select a real video file such as MP4, MOV, WEBM, or MKV.");
      return;
    }

    createPreviewProject(file);
  }

  function onFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    importPreviewFile(event.currentTarget.files?.[0]);
    event.currentTarget.value = "";
  }

  function onDropZoneDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(true);
  }

  function onDropZoneDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
  }

  function onDropZoneDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);

    const files = Array.from(event.dataTransfer.files);
    const videoFile = files.find((file) => file.type.startsWith("video/"));
    importPreviewFile(videoFile);
  }

  async function loadSourcePath(pathToLoad: string) {
    const trimmedPath = pathToLoad.trim();
    if (!trimmedPath) {
      setErrorMessage("Paste a full Windows path before loading the source.");
      return;
    }

    setPathState("loading");
    setErrorMessage(null);

    try {
      const inspection = await inspectVideoPath(trimmedPath);

      setProject((previousProject) => {
        const draft =
          shouldReuseProjectForInspection(previousProject, inspection) && previousProject
            ? {
                ...previousProject,
                source: {
                  ...previousProject.source,
                  sourcePath: inspection.sourcePath,
                  fileName: inspection.fileName,
                  fileSizeBytes:
                    inspection.fileSizeBytes ?? previousProject.source.fileSizeBytes,
                },
              }
            : buildDraftProject({
                fileName: inspection.fileName,
                previewUrl: null,
                sourcePath: inspection.sourcePath,
                fileSizeBytes: inspection.fileSizeBytes ?? null,
              });

        return applyInspectionToProject(draft, inspection);
      });

      setManualPath(inspection.sourcePath ?? trimmedPath);
      setLastExportResult(null);
      setInfoMessage("Source metadata loaded.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to inspect the selected source.";
      setErrorMessage(message);
    } finally {
      setPathState("idle");
    }
  }

  async function onOpenVideoSource() {
    if (!isDesktopApp()) {
      fileInputRef.current?.click();
      return;
    }

    try {
      const selectedPath = await pickVideoPath();
      if (!selectedPath) {
        return;
      }

      setManualPath(selectedPath);
      await loadSourcePath(selectedPath);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not open the video picker.";
      setErrorMessage(message);
    }
  }

  async function onChooseOutputPath() {
    if (!project) {
      return;
    }

    try {
      const selectedPath = await pickGifOutputPath(
        outputPath.trim() || buildDefaultOutputPath(project.source.sourcePath, project.source.fileName),
      );

      if (selectedPath) {
        setOutputPath(selectedPath);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not open the GIF save picker.";
      setErrorMessage(message);
    }
  }

  async function onExportGif() {
    if (!project?.source.sourcePath) {
      setErrorMessage("Load a real source path before exporting.");
      return;
    }

    if (!ffmpegStatus?.available) {
      setErrorMessage("FFmpeg and ffprobe need to be available before export can run.");
      return;
    }

    const resolvedOutputPath =
      outputPath.trim() || buildDefaultOutputPath(project.source.sourcePath, project.source.fileName);

    setIsExporting(true);
    setErrorMessage(null);
    setInfoMessage(project.markup.length > 0 ? "Exporting GIF with overlay..." : "Exporting GIF...");

    try {
      const overlayPngDataUrl = renderMarkupOverlayPng(project);
      const result = await exportGif(
        buildGifExportRequest(project, resolvedOutputPath, overlayPngDataUrl),
      );

      setOutputPath(result.outputPath);
      setLastExportResult(result);
      setInfoMessage(`Exported ${formatBytes(result.fileSizeBytes)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "GIF export failed.";
      setErrorMessage(message);
    } finally {
      setIsExporting(false);
    }
  }

  async function onRevealExport() {
    if (!lastExportResult?.outputPath || !isDesktopApp()) {
      return;
    }

    try {
      await revealItemInDir(lastExportResult.outputPath);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not reveal the exported GIF.";
      setErrorMessage(message);
    }
  }

  function togglePlayback() {
    const videoElement = previewVideoRef.current;
    if (!videoElement) {
      return;
    }

    if (videoElement.paused) {
      void videoElement.play().catch(() => {
        setErrorMessage("Could not start preview playback.");
      });
      return;
    }

    videoElement.pause();
  }

  function seekPlayback(timeSeconds: number) {
    const videoElement = previewVideoRef.current;
    if (!videoElement) {
      return;
    }

    const safeTime = Math.max(0, Math.min(timeSeconds, project?.inspection?.durationSeconds ?? timeSeconds));
    videoElement.currentTime = safeTime;
    setPlaybackTime(safeTime);
    setQualityPreviewFrameTime(safeTime);
  }

  function onStageWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!project?.inspection) {
      return;
    }

    event.preventDefault();

    setPreviewZoom((currentZoom) => {
      const zoomDelta = event.deltaY < 0 ? 0.12 : -0.12;
      const nextZoom = Math.max(1, Math.min(4, Number((currentZoom + zoomDelta).toFixed(2))));
      return nextZoom;
    });
  }

  const syncQualityPreviewFrameTime = useEffectEvent(() => {
    const nextTime = resolveQualityPreviewFrameTime(project, previewVideoRef.current?.currentTime ?? null);
    if (nextTime !== null) {
      setQualityPreviewFrameTime(nextTime);
    }
  });

  const handleVideoMetadata = useEffectEvent((event: SyntheticEvent<HTMLVideoElement>) => {
    const videoElement = event.currentTarget;

    setProject((previousProject) => {
      if (!previousProject) {
        return previousProject;
      }

      const inspection = buildHtmlVideoInspection(previousProject, videoElement);
      if (!inspection) {
        return previousProject;
      }

      return applyInspectionToProject(previousProject, inspection);
    });

    const nextTime = resolveQualityPreviewFrameTime(project, videoElement.currentTime);
    if (nextTime !== null) {
      setQualityPreviewFrameTime(nextTime);
    }
    setPlaybackTime(videoElement.currentTime || 0);
  });

  function updateCrop(patch: Partial<CropRegion>) {
    setProject((previousProject) => {
      if (!previousProject) {
        return previousProject;
      }

      return {
        ...previousProject,
        crop: clampCrop({
          ...previousProject.crop,
          ...patch,
        }),
      };
    });
  }

  function updateTrim(patch: Partial<TrimRange>) {
    setProject((previousProject) => {
      if (!previousProject || !previousProject.inspection) {
        return previousProject;
      }

      return {
        ...previousProject,
        trim: clampTrim(
          {
            ...previousProject.trim,
            ...patch,
          },
          previousProject.inspection.durationSeconds,
        ),
      };
    });
  }

  function updateExport<K extends keyof EditorProject["export"]>(
    key: K,
    value: EditorProject["export"][K],
  ) {
    setProject((previousProject) => {
      if (!previousProject) {
        return previousProject;
      }

      return {
        ...previousProject,
        export: {
          ...previousProject.export,
          [key]: value,
        },
      };
    });
  }

  function updateShapeById(
    shapeId: string,
    patch: Partial<Omit<MarkupShape, "id" | "kind">>,
  ) {
    setProject((previousProject) => {
      if (!previousProject) {
        return previousProject;
      }

      return {
        ...previousProject,
        markup: previousProject.markup.map((shape) =>
          shape.id === shapeId ? clampShape({ ...shape, ...patch }) : shape,
        ),
      };
    });
  }

  function addShape(kind: ShapeKind) {
    setProject((previousProject) => {
      if (!previousProject) {
        return previousProject;
      }

      const nextProject = addMarkupShape(previousProject, kind);
      setSelectedShapeId(nextProject.markup[nextProject.markup.length - 1]?.id ?? null);
      setEditorMode("shape");
      return nextProject;
    });
  }

  function removeSelectedShape() {
    setProject((previousProject) => {
      if (!previousProject || !selectedShapeId) {
        return previousProject;
      }

      return {
        ...previousProject,
        markup: previousProject.markup.filter((shape) => shape.id !== selectedShapeId),
      };
    });

    setSelectedShapeId(null);
  }

  const outputDimensions = project ? getOutputDimensions(project) : null;
  const sourceOutputDimensions = project ? getSourceOutputDimensions(project) : null;
  const estimatedGifBytes = project ? estimateGifSizeBytes(project) : null;
  const canPrepareExport =
    Boolean(project?.inspection) &&
    Boolean(project?.source.sourcePath) &&
    Boolean(ffmpegStatus?.available);
  const selectedShape =
    project?.markup.find((shape) => shape.id === selectedShapeId) ?? null;
  const previewUrl =
    project?.source.previewUrl ?? getPreviewUrlForPath(project?.source.sourcePath ?? null);
  const showQualityPreview =
    Boolean(project?.inspection) && Boolean(ffmpegStatus?.available) && Boolean(outputDimensions);
  const isOutputStage = editorMode === "shape" && Boolean(qualityPreview?.dataUrl) && !isPlaying;
  const visibleCrop = getVisibleCropRegion(project, isOutputStage);
  const stageMediaDimensions = isOutputStage
    ? qualityPreview ?? outputDimensions ?? sourceOutputDimensions
    : project?.inspection
      ? { width: project.inspection.width, height: project.inspection.height }
      : null;
  const stageViewport = getZoomedViewport(
    stageSize.width,
    stageSize.height,
    stageMediaDimensions?.width ?? null,
    stageMediaDimensions?.height ?? null,
    previewZoom,
  );
  const previewRenderSpace = stageViewport
    ? createShapeRenderSpace(stageViewport.width, stageViewport.height)
    : null;
  const cropRect = project?.crop.enabled
    ? rectFromCrop(project.crop)
    : { x: 0, y: 0, width: 1, height: 1 };
  const cropFrameStyle = normalizedRectToStyle(cropRect);
  const selectedShapeRect = selectedShape
    ? getShapeRect(projectShapeToVisibleCrop(selectedShape, visibleCrop))
    : null;
  const selectedShapeFrameRect =
    selectedShape && selectedShape.kind !== "arrow" && previewRenderSpace
      ? getShapeSelectionRect(projectShapeToVisibleCrop(selectedShape, visibleCrop), previewRenderSpace)
      : null;
  const selectedShapeFrameStyle = selectedShapeFrameRect
    ? normalizedRectToStyle(selectedShapeFrameRect)
    : null;
  const selectedShapeOutlineStyle =
    selectedShape && selectedShape.kind !== "arrow"
      ? buildSelectionOutlineStyle(projectShapeToVisibleCrop(selectedShape, visibleCrop), previewRenderSpace)
      : undefined;
  const selectedArrowGeometry =
    selectedShape?.kind === "arrow" && previewRenderSpace
      ? buildArrowGeometryFromShape(projectShapeToVisibleCrop(selectedShape, visibleCrop), previewRenderSpace)
      : null;
  const selectedArrowStartPoint =
    selectedArrowGeometry && previewRenderSpace
      ? {
          x: selectedArrowGeometry.start.x / previewRenderSpace.width,
          y: selectedArrowGeometry.start.y / previewRenderSpace.height,
        }
      : null;
  const selectedArrowEndPoint =
    selectedArrowGeometry && previewRenderSpace
      ? {
          x: selectedArrowGeometry.end.x / previewRenderSpace.width,
          y: selectedArrowGeometry.end.y / previewRenderSpace.height,
        }
      : null;
  const surfaceHint = buildSurfaceHint(project, editorMode, selectedShape);
  const targetFileSizeBytes =
    project?.export.targetFileSizeEnabled && project.export.targetFileSizeMb > 0
      ? Math.round(project.export.targetFileSizeMb * 1024 * 1024)
      : null;
  const stageFrameTime = resolveQualityPreviewFrameTime(project, playbackTime);

  useEffect(() => {
    const element = stageRef.current;
    if (!element || !stageViewport) {
      return;
    }

    const nextScrollLeft = Math.max(0, (stageViewport.contentWidth - stageSize.width) / 2);
    const nextScrollTop = Math.max(0, (stageViewport.contentHeight - stageSize.height) / 2);
    element.scrollLeft = nextScrollLeft;
    element.scrollTop = nextScrollTop;
  }, [
    previewZoom,
    stageSize.height,
    stageSize.width,
    stageViewport?.contentHeight,
    stageViewport?.contentWidth,
  ]);

  const readNormalizedPointer = useEffectEvent((clientX: number, clientY: number) => {
    if (!stageRef.current || !stageViewport) {
      return null;
    }

    const bounds = stageRef.current.getBoundingClientRect();
    const visiblePoint = clientPointToNormalized(clientX, clientY, {
      left: bounds.left + stageViewport.left - stageRef.current.scrollLeft,
      top: bounds.top + stageViewport.top - stageRef.current.scrollTop,
      width: stageViewport.width,
      height: stageViewport.height,
    });

    return {
      x: visibleCrop.x + visiblePoint.x * visibleCrop.width,
      y: visibleCrop.y + visiblePoint.y * visibleCrop.height,
    };
  });

  const applyInteraction = useEffectEvent(
    (activeInteraction: InteractionState, currentPoint: Point) => {
      let nextRect: NormalizedRect;

      if (activeInteraction.kind === "arrow-endpoint") {
        const startPoint = getArrowStartPoint(activeInteraction.startRect);
        const endPoint = getArrowEndPoint(activeInteraction.startRect);

        if (activeInteraction.endpoint === "start") {
          const nextStart = {
            x: Math.min(currentPoint.x, endPoint.x - 0.05),
            y: Math.max(currentPoint.y, endPoint.y + 0.05),
          };

          nextRect = {
            x: nextStart.x,
            y: endPoint.y,
            width: endPoint.x - nextStart.x,
            height: nextStart.y - endPoint.y,
          };
        } else {
          const nextEnd = {
            x: Math.max(currentPoint.x, startPoint.x + 0.05),
            y: Math.min(currentPoint.y, startPoint.y - 0.05),
          };

          nextRect = {
            x: startPoint.x,
            y: nextEnd.y,
            width: nextEnd.x - startPoint.x,
            height: startPoint.y - nextEnd.y,
          };
        }
      } else {
        const delta = deltaBetweenPoints(activeInteraction.startPoint, currentPoint);
        nextRect =
          activeInteraction.kind === "crop-move" || activeInteraction.kind === "shape-move"
            ? moveNormalizedRect(activeInteraction.startRect, delta)
            : resizeNormalizedRect(activeInteraction.startRect, activeInteraction.handle, delta);
      }

      if (activeInteraction.kind === "crop-move" || activeInteraction.kind === "crop-resize") {
        setProject((previousProject) => {
          if (!previousProject) {
            return previousProject;
          }

          return {
            ...previousProject,
            crop: clampCrop({
              ...previousProject.crop,
              enabled: true,
              ...nextRect,
            }),
          };
        });

        return;
      }

      updateShapeById(activeInteraction.shapeId, nextRect);
    },
  );

  useEffect(() => {
    if (!interaction) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const point = readNormalizedPointer(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      applyInteraction(interaction, point);
    };

    const clearInteraction = () => {
      setInteraction(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", clearInteraction);
    window.addEventListener("pointercancel", clearInteraction);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", clearInteraction);
      window.removeEventListener("pointercancel", clearInteraction);
    };
  }, [interaction]);

  function beginCropMove(event: ReactPointerEvent<HTMLElement>) {
    if (!project) {
      return;
    }

    const point = readNormalizedPointer(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setEditorMode("crop");
    setInteraction({
      kind: "crop-move",
      startPoint: point,
      startRect: cropRect,
    });
  }

  function beginCropResize(handle: ResizeHandle, event: ReactPointerEvent<HTMLElement>) {
    if (!project) {
      return;
    }

    const point = readNormalizedPointer(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setEditorMode("crop");
    setInteraction({
      kind: "crop-resize",
      handle,
      startPoint: point,
      startRect: cropRect,
    });
  }

  function beginShapeMove(shapeId: string, event: ReactPointerEvent<Element>) {
    const targetShape = project?.markup.find((shape) => shape.id === shapeId);
    if (!targetShape) {
      return;
    }

    const point = readNormalizedPointer(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setSelectedShapeId(shapeId);
    setEditorMode("shape");
    setInteraction({
      kind: "shape-move",
      shapeId,
      startPoint: point,
      startRect: getShapeRect(targetShape),
    });
  }

  function beginShapeResize(
    shapeId: string,
    handle: ResizeHandle,
    event: ReactPointerEvent<HTMLElement>,
  ) {
    const targetShape = project?.markup.find((shape) => shape.id === shapeId);
    if (!targetShape) {
      return;
    }

    const point = readNormalizedPointer(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setSelectedShapeId(shapeId);
    setEditorMode("shape");
    setInteraction({
      kind: "shape-resize",
      shapeId,
      handle,
      startPoint: point,
      startRect: getShapeRect(targetShape),
    });
  }

  function beginArrowEndpointResize(
    shapeId: string,
    endpoint: ArrowEndpoint,
    event: ReactPointerEvent<HTMLElement>,
  ) {
    const targetShape = project?.markup.find((shape) => shape.id === shapeId);
    if (!targetShape) {
      return;
    }

    const point = readNormalizedPointer(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setSelectedShapeId(shapeId);
    setEditorMode("shape");
    setInteraction({
      kind: "arrow-endpoint",
      endpoint,
      shapeId,
      startPoint: point,
      startRect: getShapeRect(targetShape),
    });
  }

  function onSurfacePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (editorMode === "shape" && event.target === event.currentTarget) {
      setSelectedShapeId(null);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block compact-brand">
          <h1>WindGifs</h1>
        </div>
        <div className="topbar-status compact-status">
          <div className={`status-pill ${ffmpegStatus?.available ? "ok" : "warn"}`}>
            {ffmpegStatus?.available ? "FFmpeg ready" : "FFmpeg unavailable"}
          </div>
        </div>
      </header>

      {(errorMessage || infoMessage) && (
        <section className="banner-strip">
          {errorMessage && <div className="banner error">{errorMessage}</div>}
          {!errorMessage && infoMessage && <div className="banner info">{infoMessage}</div>}
        </section>
      )}

      <section className="studio-layout">
        <section className="card stage-card">
          <div className="stage-toolbar">
            <div className="stage-toolbar-actions">
              <button
                type="button"
                className="primary-button"
                onClick={onOpenVideoSource}
                disabled={pathState === "loading"}
              >
                {pathState === "loading" ? "Loading..." : "Open"}
              </button>

              {project && (
                <>
                  <div className="segmented-control">
                    <button
                      type="button"
                      className={editorMode === "crop" ? "selected" : ""}
                      onClick={() => {
                        setEditorMode("crop");
                        if (!project.crop.enabled) {
                          updateCrop({ enabled: true });
                        }
                      }}
                    >
                      Crop
                    </button>
                    <button
                      type="button"
                      className={editorMode === "shape" ? "selected" : ""}
                      onClick={() => setEditorMode("shape")}
                    >
                      Shapes
                    </button>
                  </div>

                  {editorMode === "shape" && (
                    <div className="shape-toolbar">
                      <button type="button" className="ghost-button" onClick={() => addShape("rect")}>
                        Rect
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => addShape("ellipse")}
                      >
                        Ellipse
                      </button>
                      <button type="button" className="ghost-button" onClick={() => addShape("arrow")}>
                        Arrow
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <div ref={stageRef} className="preview-stage" onWheel={onStageWheel}>
            {previewUrl ? (
              <>
                <div
                  className="preview-canvas"
                  style={{
                    width: `${stageViewport?.contentWidth ?? stageSize.width}px`,
                    height: `${stageViewport?.contentHeight ?? stageSize.height}px`,
                  }}
                >
                  <video
                    ref={previewVideoRef}
                    key={previewUrl}
                    className={`preview-video ${isOutputStage ? "is-hidden" : ""}`}
                    src={previewUrl}
                    preload="metadata"
                    style={
                      stageViewport
                        ? {
                            left: `${stageViewport.left}px`,
                            top: `${stageViewport.top}px`,
                            width: `${stageViewport.width}px`,
                            height: `${stageViewport.height}px`,
                          }
                        : undefined
                    }
                    onLoadedMetadata={handleVideoMetadata}
                    onLoadedData={syncQualityPreviewFrameTime}
                    onPause={() => {
                      setIsPlaying(false);
                      syncQualityPreviewFrameTime();
                    }}
                    onPlay={() => setIsPlaying(true)}
                    onTimeUpdate={() => {
                      const nextTime = previewVideoRef.current?.currentTime ?? 0;
                      setPlaybackTime(nextTime);
                    }}
                    onSeeked={() => {
                      syncQualityPreviewFrameTime();
                      setPlaybackTime(previewVideoRef.current?.currentTime ?? 0);
                    }}
                    onEnded={() => setIsPlaying(false)}
                    onError={() => {
                      setErrorMessage(
                        "The video opened, but the Windows webview could not render this preview format.",
                      );
                    }}
                  />

                  {showQualityPreview && qualityPreview?.dataUrl && (
                    <img
                      className={`preview-image ${isOutputStage ? "is-visible" : ""}`}
                      src={qualityPreview.dataUrl}
                      alt="Output preview"
                      style={
                        stageViewport
                          ? {
                              left: `${stageViewport.left}px`,
                              top: `${stageViewport.top}px`,
                              width: `${stageViewport.width}px`,
                              height: `${stageViewport.height}px`,
                            }
                          : undefined
                      }
                    />
                  )}

                  {stageViewport && (
                    <div
                      className={`editor-surface mode-${editorMode}`}
                      style={{
                        left: `${stageViewport.left}px`,
                        top: `${stageViewport.top}px`,
                        width: `${stageViewport.width}px`,
                        height: `${stageViewport.height}px`,
                      }}
                      onPointerDown={onSurfacePointerDown}
                    >
                    {editorMode === "crop" && project?.crop.enabled && (
                      <>
                        <div className="crop-mask crop-top" style={{ height: cropFrameStyle.top }} />
                        <div
                          className="crop-mask crop-left"
                          style={{
                            top: cropFrameStyle.top,
                            width: cropFrameStyle.left,
                            height: cropFrameStyle.height,
                          }}
                        />
                        <div
                          className="crop-mask crop-right"
                          style={{
                            top: cropFrameStyle.top,
                            left: `calc(${cropFrameStyle.left} + ${cropFrameStyle.width})`,
                            width: `calc(100% - (${cropFrameStyle.left} + ${cropFrameStyle.width}))`,
                            height: cropFrameStyle.height,
                          }}
                        />
                        <div
                          className="crop-mask crop-bottom"
                          style={{
                            top: `calc(${cropFrameStyle.top} + ${cropFrameStyle.height})`,
                            height: `calc(100% - (${cropFrameStyle.top} + ${cropFrameStyle.height}))`,
                          }}
                        />
                      </>
                    )}

                    {editorMode === "crop" && (
                      <div
                        className={`crop-frame ${editorMode === "crop" ? "is-active" : ""} ${
                          project?.crop.enabled ? "" : "is-disabled"
                        }`}
                        style={cropFrameStyle}
                        onPointerDown={beginCropMove}
                      />
                    )}

                    <svg
                      className={`markup-layer ${editorMode === "shape" ? "is-editable" : ""}`}
                      viewBox={`0 0 ${previewRenderSpace?.width ?? 1} ${previewRenderSpace?.height ?? 1}`}
                      preserveAspectRatio="none"
                    >
                      {(project?.markup ?? []).map((shape) => {
                        if (!previewRenderSpace) {
                          return null;
                        }

                        const projectedShape = projectShapeToVisibleCrop(shape, visibleCrop);
                        const rect = getShapeRenderRect(projectedShape, previewRenderSpace);
                        const arrowGeometry =
                          shape.kind === "arrow"
                            ? buildArrowGeometryFromShape(projectedShape, previewRenderSpace)
                            : null;
                        const isSelected = selectedShapeId === shape.id;

                        return (
                          <g key={shape.id} className={isSelected ? "shape-group is-selected" : "shape-group"}>
                            {editorMode === "shape" &&
                              renderShapeHitTarget(projectedShape, rect, previewRenderSpace, (event) =>
                                beginShapeMove(shape.id, event),
                              )}

                            {shape.kind === "rect" && (
                              <rect
                                x={rect.x}
                                y={rect.y}
                                width={rect.width}
                                height={rect.height}
                                rx={getShapeRenderCornerRadius(projectedShape, previewRenderSpace)}
                                fill="none"
                                stroke={shape.color}
                                strokeWidth={getShapeRenderStrokeWidth(projectedShape, previewRenderSpace)}
                                opacity={shape.opacity}
                                className={isSelected ? "selected-shape" : ""}
                              />
                            )}

                            {shape.kind === "ellipse" && (
                              <ellipse
                                cx={rect.x + rect.width / 2}
                                cy={rect.y + rect.height / 2}
                                rx={rect.width / 2}
                                ry={rect.height / 2}
                                fill="none"
                                stroke={shape.color}
                                strokeWidth={getShapeRenderStrokeWidth(projectedShape, previewRenderSpace)}
                                opacity={shape.opacity}
                                className={isSelected ? "selected-shape" : ""}
                              />
                            )}

                            {shape.kind === "arrow" && arrowGeometry && (
                              <>
                                <line
                                  x1={arrowGeometry.start.x}
                                  y1={arrowGeometry.start.y}
                                  x2={arrowGeometry.end.x}
                                  y2={arrowGeometry.end.y}
                                  stroke={shape.color}
                                  strokeWidth={getShapeRenderStrokeWidth(projectedShape, previewRenderSpace)}
                                  opacity={shape.opacity}
                                  className={isSelected ? "selected-shape" : ""}
                                />
                                <polygon
                                  points={`${arrowGeometry.end.x},${arrowGeometry.end.y} ${arrowGeometry.headLeft.x},${arrowGeometry.headLeft.y} ${arrowGeometry.headRight.x},${arrowGeometry.headRight.y}`}
                                  fill={shape.color}
                                  opacity={shape.opacity}
                                  className={isSelected ? "selected-shape" : ""}
                                />
                                {editorMode === "shape" && (
                                  <>
                                    <line
                                      x1={arrowGeometry.start.x}
                                      y1={arrowGeometry.start.y}
                                      x2={arrowGeometry.end.x}
                                      y2={arrowGeometry.end.y}
                                      stroke="rgba(0, 0, 0, 0.001)"
                                      strokeWidth={Math.max(
                                        28,
                                        getShapeRenderStrokeWidth(projectedShape, previewRenderSpace) * 3,
                                      )}
                                      pointerEvents="stroke"
                                      onPointerDown={(event) => beginShapeMove(shape.id, event)}
                                    />
                                    <polygon
                                      points={`${arrowGeometry.end.x},${arrowGeometry.end.y} ${arrowGeometry.headLeft.x},${arrowGeometry.headLeft.y} ${arrowGeometry.headRight.x},${arrowGeometry.headRight.y}`}
                                      fill="rgba(0, 0, 0, 0.001)"
                                      pointerEvents="all"
                                      onPointerDown={(event) => beginShapeMove(shape.id, event)}
                                    />
                                  </>
                                )}
                              </>
                            )}
                          </g>
                        );
                      })}

                    </svg>

                    {editorMode === "crop" && (
                      <>
                        {(["n", "e", "s", "w"] as const).map((handle) => (
                          <button
                            key={`edge-${handle}`}
                            type="button"
                            className={`crop-edge-hit handle-${handle}`}
                            style={buildCropEdgeStyle(cropRect, handle)}
                            onPointerDown={(event) => beginCropResize(handle, event)}
                            aria-label={`Resize crop from ${handle}`}
                          />
                        ))}

                        {RESIZE_HANDLES.map((handle) => (
                          <button
                            key={handle}
                            type="button"
                            className={`editor-handle crop-handle handle-${handle}`}
                            style={buildHandleStyle(cropRect, handle)}
                            onPointerDown={(event) => beginCropResize(handle, event)}
                            aria-label={`Resize crop from ${handle}`}
                          />
                        ))}
                      </>
                    )}

                    {selectedShape &&
                      selectedShape.kind === "arrow" &&
                      selectedArrowGeometry &&
                      selectedArrowStartPoint &&
                      selectedArrowEndPoint &&
                      editorMode === "shape" && (
                        <>
                          <svg
                            className="selection-line-layer"
                            viewBox={`0 0 ${previewRenderSpace?.width ?? 1} ${previewRenderSpace?.height ?? 1}`}
                            preserveAspectRatio="none"
                          >
                            <line
                              className="arrow-selection-line"
                              x1={selectedArrowGeometry.start.x}
                              y1={selectedArrowGeometry.start.y}
                              x2={selectedArrowGeometry.end.x}
                              y2={selectedArrowGeometry.end.y}
                            />
                            <polygon
                              className="arrow-selection-head"
                              points={`${selectedArrowGeometry.end.x},${selectedArrowGeometry.end.y} ${selectedArrowGeometry.headLeft.x},${selectedArrowGeometry.headLeft.y} ${selectedArrowGeometry.headRight.x},${selectedArrowGeometry.headRight.y}`}
                            />
                          </svg>

                          <button
                            type="button"
                            className="editor-handle arrow-point-handle"
                            style={buildPointStyle(selectedArrowStartPoint)}
                            onPointerDown={(event) =>
                              beginArrowEndpointResize(selectedShape.id, "start", event)
                            }
                            aria-label="Move arrow start"
                          />
                          <button
                            type="button"
                            className="editor-handle arrow-point-handle"
                            style={buildPointStyle(selectedArrowEndPoint)}
                            onPointerDown={(event) =>
                              beginArrowEndpointResize(selectedShape.id, "end", event)
                            }
                            aria-label="Move arrow end"
                          />
                        </>
                      )}

                    {selectedShape &&
                      selectedShapeRect &&
                      selectedShapeFrameRect &&
                      selectedShape.kind !== "arrow" &&
                      selectedShapeFrameStyle &&
                      editorMode === "shape" && (
                        <div
                          className="shape-selection-frame"
                          style={selectedShapeFrameStyle}
                          onPointerDown={(event) => beginShapeMove(selectedShape.id, event)}
                        >
                          <div
                            className={`shape-selection-outline-frame ${
                              selectedShape.kind === "ellipse" ? "is-ellipse" : "is-rect"
                            }`}
                            style={selectedShapeOutlineStyle}
                          />
                          {RESIZE_HANDLES.map((handle) => (
                            <button
                              key={handle}
                              type="button"
                              className={`editor-handle shape-handle handle-${handle}`}
                              style={buildSelectionHandleStyle(handle)}
                              onPointerDown={(event) =>
                                beginShapeResize(selectedShape.id, handle, event)
                              }
                              aria-label={`Resize ${selectedShape.kind} from ${handle}`}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="stage-status-row">
                    <div className="preview-mode-pill">
                      {isOutputStage ? "Output preview" : "Source preview"}
                    </div>
                    <div className="preview-mode-note">
                      {isPlaying
                        ? "Pause to refresh the output frame."
                        : isRenderingQualityPreview
                          ? "Refreshing output preview..."
                          : qualityPreviewFailed
                            ? "Output preview unavailable."
                            : stageFrameTime !== null
                              ? `Frame ${formatTimelineTime(stageFrameTime)}`
                              : ""}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-preview">
                <p>Open a video.</p>
              </div>
            )}
          </div>

          <div className="stage-footer">
            <div className="stage-footer-row">
              <p className="surface-hint">{surfaceHint}</p>

              {project?.inspection && (
                <div className="preview-controls">
                  <button
                    type="button"
                    className="ghost-button preview-control-button"
                    onClick={togglePlayback}
                  >
                    {isPlaying ? "Pause" : "Play"}
                  </button>
                  <input
                    className="preview-timeline"
                    type="range"
                    min={0}
                    max={project.inspection.durationSeconds}
                    step={0.05}
                    value={playbackTime}
                    onChange={(event) => seekPlayback(asNumber(event.currentTarget.value, playbackTime))}
                  />
                  <span className="preview-time-label">
                    {formatTimelineTime(playbackTime)} /{" "}
                    {formatTimelineTime(project.inspection.durationSeconds)}
                  </span>
                  <span className="preview-zoom-label">{Math.round(previewZoom * 100)}%</span>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="sidebar">
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="hidden-input"
            onChange={onFileInputChange}
          />

          <section className="card side-card editor-card">
            <div className="side-head compact-head">
              <h2>Editor</h2>
              {selectedShape && (
                <button type="button" className="ghost-button danger" onClick={removeSelectedShape}>
                  Delete
                </button>
              )}
            </div>

            <div
              className={`source-strip ${dragActive ? "active" : ""}`}
              onDragOver={onDropZoneDragOver}
              onDragLeave={onDropZoneDragLeave}
              onDrop={onDropZoneDrop}
            >
              <strong>{project?.source.fileName ?? "No video selected"}</strong>
              <span>
                {project?.inspection
                  ? `${project.inspection.width} x ${project.inspection.height} | ${formatSeconds(
                      project.inspection.durationSeconds,
                    )} | ${formatBytes(
                      project.inspection.fileSizeBytes ?? project.source.fileSizeBytes,
                    )}`
                  : "Open a file or drop one on the preview."}
              </span>
            </div>

            {project?.source.sourcePath && (
              <div className="path-display compact-path" title={project.source.sourcePath}>
                <strong>{truncateMiddle(project.source.sourcePath)}</strong>
              </div>
            )}

            <div className="inspector-panel">
              <div className="selection-card-block">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={project?.crop.enabled ?? false}
                    onChange={(event) => updateCrop({ enabled: event.currentTarget.checked })}
                  />
                  <span>Apply crop during export</span>
                </label>

                <div className="secondary-row">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      updateCrop({ enabled: true, x: 0, y: 0, width: 1, height: 1 })
                    }
                    disabled={!project}
                  >
                    Reset crop
                  </button>
                </div>
              </div>

              {project?.markup.length ? (
                <div className="selection-card-block">
                  <div className="layer-list">
                    {project.markup.map((shape) => (
                      <button
                        key={shape.id}
                        type="button"
                        className={`layer-chip ${selectedShapeId === shape.id ? "selected" : ""}`}
                        onClick={() => {
                          setSelectedShapeId(shape.id);
                          setEditorMode("shape");
                        }}
                      >
                        {shape.kind}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="subtle-note">No shapes yet.</div>
              )}

              {selectedShape ? (
                <div className="field-grid compact-fields">
                  <label>
                    Color
                    <input
                      type="color"
                      value={selectedShape.color}
                      onChange={(event) =>
                        updateShapeById(selectedShape.id, { color: event.currentTarget.value })
                      }
                    />
                  </label>
                  <label>
                    Stroke
                    <input
                      type="number"
                      min={1}
                      max={16}
                      step={1}
                      value={selectedShape.strokeWidth}
                      onChange={(event) =>
                        updateShapeById(selectedShape.id, {
                          strokeWidth: Math.max(
                            1,
                            asNumber(event.currentTarget.value, selectedShape.strokeWidth),
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    Opacity
                    <input
                      type="number"
                      min={0.1}
                      max={1}
                      step={0.1}
                      value={selectedShape.opacity}
                      onChange={(event) =>
                        updateShapeById(selectedShape.id, {
                          opacity: Math.min(
                            1,
                            Math.max(0.1, asNumber(event.currentTarget.value, selectedShape.opacity)),
                          ),
                        })
                      }
                    />
                  </label>
                </div>
              ) : editorMode === "shape" ? (
                <div className="subtle-note">Add or select a shape from the toolbar.</div>
              ) : null}
            </div>
          </section>
        </aside>

        <section className="card export-card">
          <div className="side-head compact-head">
            <h2>Export</h2>
          </div>

          <div className="export-layout">
            <div className="export-section presets-section">
              <div className="preset-grid compact-preset-grid">
                {Object.entries(EXPORT_PRESETS).map(([presetId, preset]) => (
                  <button
                    key={presetId}
                    type="button"
                    className={`preset-card ${project?.export.presetId === presetId ? "selected" : ""}`}
                    onClick={() =>
                      setProject((previousProject) =>
                        previousProject
                          ? updateExportPreset(previousProject, presetId as keyof typeof EXPORT_PRESETS)
                          : previousProject,
                      )
                    }
                  >
                    <strong>{preset.label}</strong>
                    <span>{preset.width}px | {preset.fps} fps</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="export-section controls-section">
              <div className="field-grid export-fields">
                <label>
                  Width
                  <input
                    type="number"
                    min={120}
                    max={1920}
                    step={10}
                    value={
                      project?.export.useSourceResolution
                        ? sourceOutputDimensions?.width ?? project.export.width
                        : project?.export.width ?? 540
                    }
                    disabled={project?.export.useSourceResolution ?? false}
                    onChange={(event) =>
                      updateExport("width", Math.max(120, asNumber(event.currentTarget.value, 540)))
                    }
                  />
                </label>
                <label>
                  FPS
                  <input
                    type="number"
                    min={4}
                    max={30}
                    step={1}
                    value={project?.export.fps ?? 15}
                    onChange={(event) =>
                      updateExport("fps", Math.max(4, asNumber(event.currentTarget.value, 15)))
                    }
                  />
                </label>
                <label>
                  Colors
                  <input
                    type="number"
                    min={16}
                    max={256}
                    step={8}
                    value={project?.export.colors ?? 96}
                    onChange={(event) =>
                      updateExport(
                        "colors",
                        Math.min(256, Math.max(16, asNumber(event.currentTarget.value, 96))),
                      )
                    }
                  />
                </label>
                <label>
                  Dither
                  <select
                    value={project?.export.dither ?? "sierra2_4a"}
                    onChange={(event) =>
                      updateExport(
                        "dither",
                        event.currentTarget.value as EditorProject["export"]["dither"],
                      )
                    }
                  >
                    <option value="sierra2_4a">Sierra 2-4A</option>
                    <option value="floyd_steinberg">Floyd-Steinberg</option>
                    <option value="bayer">Bayer</option>
                    <option value="none">None</option>
                  </select>
                </label>
                <label>
                  Start
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={project?.trim.start ?? 0}
                    onChange={(event) =>
                      updateTrim({ start: Math.max(0, asNumber(event.currentTarget.value, 0)) })
                    }
                  />
                </label>
                <label>
                  End
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={project?.trim.end ?? 0}
                    onChange={(event) =>
                      updateTrim({ end: Math.max(0, asNumber(event.currentTarget.value, 0)) })
                    }
                  />
                </label>
              </div>

              <div className="toggle-stack export-toggle-stack">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={project?.export.useSourceResolution ?? false}
                    onChange={(event) =>
                      updateExport("useSourceResolution", event.currentTarget.checked)
                    }
                  />
                  <span>Source res</span>
                </label>

                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={project?.export.loop ?? true}
                    onChange={(event) => updateExport("loop", event.currentTarget.checked)}
                  />
                  <span>Loop</span>
                </label>

                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={project?.export.targetFileSizeEnabled ?? false}
                    onChange={(event) =>
                      updateExport("targetFileSizeEnabled", event.currentTarget.checked)
                    }
                  />
                  <span>Target size</span>
                </label>

                {project?.export.targetFileSizeEnabled && (
                  <label className="compression-field inline-compression-field">
                    <span>Target MB</span>
                    <input
                      type="number"
                      min={0.5}
                      max={100}
                      step={0.5}
                      value={project.export.targetFileSizeMb}
                      onChange={(event) =>
                        updateExport(
                          "targetFileSizeMb",
                          Math.max(0.5, asNumber(event.currentTarget.value, 4)),
                        )
                      }
                    />
                  </label>
                )}
              </div>
            </div>

            <div className="export-section summary-section">
              <div className="summary-box compact-summary">
                <div>
                  <span>Output</span>
                  <strong>
                    {outputDimensions ? `${outputDimensions.width} x ${outputDimensions.height}` : "Pending"}
                  </strong>
                </div>
                <div>
                  <span>{targetFileSizeBytes ? "Target" : "Estimate"}</span>
                  <strong>
                    {targetFileSizeBytes
                      ? formatBytes(targetFileSizeBytes)
                      : estimatedGifBytes
                        ? formatBytes(estimatedGifBytes)
                        : "Pending"}
                  </strong>
                </div>
              </div>

              <div className="export-path-box compact-export-path">
                <label htmlFor="output-path">Save as</label>
                <div className="path-row">
                  <input
                    id="output-path"
                    value={outputPath}
                    onChange={(event) => setOutputPath(event.currentTarget.value)}
                    placeholder="C:\\Users\\you\\Videos\\clip-windgifs.gif"
                  />
                  <button type="button" onClick={onChooseOutputPath} disabled={!project}>
                    Browse
                  </button>
                </div>
                <div className="secondary-row">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      project &&
                      setOutputPath(
                        buildDefaultOutputPath(project.source.sourcePath, project.source.fileName),
                      )
                    }
                    disabled={!project}
                  >
                    Use default
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={onRevealExport}
                    disabled={!lastExportResult}
                  >
                    Reveal
                  </button>
                </div>
              </div>

              <div className="cta-row compact-cta">
                <button
                  type="button"
                  className="primary-button"
                  onClick={onExportGif}
                  disabled={!canPrepareExport || isExporting}
                >
                  {isExporting ? "Exporting..." : "Export GIF"}
                </button>
                <p>
                  {lastExportResult
                    ? `Last export: ${formatBytes(lastExportResult.fileSizeBytes)}`
                    : canPrepareExport
                      ? "Ready."
                      : "Open a video to export."}
                </p>
              </div>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
