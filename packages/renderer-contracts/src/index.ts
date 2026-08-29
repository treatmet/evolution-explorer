export interface Vec2 {
  x: number;
  y: number;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface RenderNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  worldX: number;
  baseWorldY: number;
  fisheyeTargetY: number;
  renderedWorldY: number;
  subtreeMinY: number;
  subtreeMaxY: number;
  descendantLeafCount: number;
  label: string;
  labelPriority: number;
  semanticImportance: number;
  isCurrent: boolean;
  isHovered: boolean;
  isOnVisitedPath: boolean;
}

export interface TreeRenderer {
  mount(canvas: HTMLCanvasElement): void;
  resize(width: number, height: number, dpr: number): void;
  setNodes(nodes: ReadonlyArray<RenderNode>): void;
  setCamera(camera: CameraState): void;
  hitTest(screenX: number, screenY: number): string | null;
  render(nowMs: number): void;
  destroy(): void;
}
