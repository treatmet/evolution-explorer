import type {
  CameraState,
  RenderNode,
  TreeRenderer
} from '@evo-tree/renderer-contracts';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class CanvasTreeRenderer implements TreeRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private nodes: RenderNode[] = [];
  private nodesById = new Map<string, RenderNode>();
  private timelineMaxWorldX = 1;
  private camera: CameraState = {
    x: 0,
    y: 0,
    zoom: 1,
    viewportWidth: 1,
    viewportHeight: 1
  };
  private lastFrameMs = 0;
  private labelHitRects: Array<{ nodeId: string; rect: Rect }> = [];

  mount(canvas: HTMLCanvasElement): void {
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas2D context unavailable.');
    }

    this.canvas = canvas;
    this.context = context;
    this.context.imageSmoothingEnabled = true;
  }

  resize(width: number, height: number, dpr: number): void {
    if (!this.canvas || !this.context) {
      return;
    }

    this.dpr = Math.max(1, dpr);
    this.canvas.width = Math.max(1, Math.floor(width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(height * this.dpr));

    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.camera = {
      ...this.camera,
      viewportWidth: width,
      viewportHeight: height
    };
  }

  setNodes(nodes: ReadonlyArray<RenderNode>): void {
    const previousRenderedY = new Map(this.nodes.map((node) => [node.id, node.renderedWorldY]));

    this.nodes = nodes.map((node) => ({
      ...node,
      renderedWorldY: previousRenderedY.get(node.id) ?? node.renderedWorldY
    }));

    this.nodesById = new Map(this.nodes.map((node) => [node.id, node]));
    this.timelineMaxWorldX = Math.max(
      1,
      ...this.nodes.map((node) => node.worldX)
    );
    this.labelHitRects = [];
  }

  setCamera(camera: CameraState): void {
    this.camera = {
      ...camera
    };
  }

  hitTest(screenX: number, screenY: number): string | null {
    for (let index = this.labelHitRects.length - 1; index >= 0; index -= 1) {
      const entry = this.labelHitRects[index];
      if (entry && pointInRect(screenX, screenY, entry.rect)) {
        return entry.nodeId;
      }
    }

    let bestDistance = Number.POSITIVE_INFINITY;
    let bestId: string | null = null;

    for (const node of this.nodes) {
      if (!this.shouldDrawNode(node)) {
        continue;
      }

      const x = this.worldToScreenX(node.worldX);
      const y = this.worldToScreenY(node.renderedWorldY);
      const dx = x - screenX;
      const dy = y - screenY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const hitRadius = node.isCurrent ? 14 : 11;

      if (distance <= hitRadius && distance < bestDistance) {
        bestDistance = distance;
        bestId = node.id;
      }
    }

    return bestId;
  }

  render(nowMs: number): void {
    if (!this.context) {
      return;
    }

    const dtMs = this.lastFrameMs > 0 ? nowMs - this.lastFrameMs : 16;
    this.lastFrameMs = nowMs;

    this.interpolateRenderedY(dtMs);

    const ctx = this.context;
    const width = this.camera.viewportWidth;
    const height = this.camera.viewportHeight;

    ctx.clearRect(0, 0, width, height);

    this.drawGeologicalGrid(ctx, width, height);
    this.drawBranches(ctx, width, height);
    this.drawNodes(ctx, width, height);
    this.drawLabels(ctx, width, height);
  }

  destroy(): void {
    this.nodes = [];
    this.nodesById.clear();
    this.context = null;
    this.canvas = null;
    this.lastFrameMs = 0;
    this.labelHitRects = [];
  }

  private interpolateRenderedY(dtMs: number): void {
    const interpolation = 1 - Math.exp(-Math.max(0.001, dtMs) / 120);

    this.nodes = this.nodes.map((node) => ({
      ...node,
      renderedWorldY:
        node.renderedWorldY +
        (node.fisheyeTargetY - node.renderedWorldY) * interpolation
    }));

    this.nodesById = new Map(this.nodes.map((node) => [node.id, node]));
  }

  private drawGeologicalGrid(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    const geologicalMarks = [0, 50, 100, 250, 500, 1000, 2000, 3000, 4000];

    ctx.save();
    ctx.strokeStyle = 'rgba(174, 207, 214, 0.12)';
    ctx.fillStyle = 'rgba(194, 217, 224, 0.55)';
    ctx.font = '11px Space Grotesk, sans-serif';
    ctx.textAlign = 'center';

    for (const ageMa of geologicalMarks) {
      const worldX = this.timelineMaxWorldX - ageMa;
      const screenX = this.worldToScreenX(worldX);

      if (screenX < -80 || screenX > width + 80) {
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(screenX, 0);
      ctx.lineTo(screenX, height);
      ctx.stroke();

      if (this.camera.zoom > 0.08) {
        const ageLabel = ageMa >= 1000 ? `${ageMa / 1000} Ga` : `${ageMa} Ma`;
        ctx.fillText(ageMa === 0 ? 'Today' : ageLabel, screenX, 14);
      }
    }

    ctx.restore();
  }

  private drawBranches(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const node of this.nodes) {
      if (!node.parentId) {
        continue;
      }

      const parent = this.nodesById.get(node.parentId);
      if (!parent) {
        continue;
      }

      const x1 = this.worldToScreenX(parent.worldX);
      const y1 = this.worldToScreenY(parent.renderedWorldY);
      const x2 = this.worldToScreenX(node.worldX);
      const y2 = this.worldToScreenY(node.renderedWorldY);

      if (!isSegmentVisible(x1, y1, x2, y2, width, height, 80)) {
        continue;
      }

      ctx.strokeStyle = node.isOnVisitedPath
        ? 'rgba(109, 229, 176, 0.75)'
        : 'rgba(120, 160, 170, 0.38)';

      ctx.lineWidth = node.isOnVisitedPath
        ? clamp(1.5, 4, 2.2 * this.camera.zoom + 1)
        : clamp(0.8, 2.6, 1.2 * this.camera.zoom + 0.8);

      const controlX = (x1 + x2) / 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(controlX, y1, controlX, y2, x2, y2);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawNodes(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    ctx.save();

    for (const node of this.nodes) {
      if (!this.shouldDrawNode(node)) {
        continue;
      }

      const x = this.worldToScreenX(node.worldX);
      const y = this.worldToScreenY(node.renderedWorldY);

      if (!isPointVisible(x, y, width, height, 50)) {
        continue;
      }

      const subtreeSpanPx = Math.max(0, (node.subtreeMaxY - node.subtreeMinY) * this.camera.zoom);
      const shouldDrawBundle =
        subtreeSpanPx < 10 && node.descendantLeafCount >= 4 && !node.isCurrent && !node.isHovered;

      if (shouldDrawBundle) {
        ctx.fillStyle = 'rgba(126, 173, 179, 0.5)';
        ctx.fillRect(x - 2, y - 6, 4, 12);
        continue;
      }

      const radius = node.isCurrent ? 6.2 : node.isHovered ? 5 : 3.3;
      ctx.fillStyle = node.isCurrent
        ? '#74e8bf'
        : node.isHovered
          ? '#f1dd9b'
        : node.isOnVisitedPath
          ? 'rgba(139, 227, 188, 0.88)'
          : 'rgba(160, 198, 206, 0.8)';

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    const fontPx = clamp(10, 18, 11 + Math.log2(Math.max(this.camera.zoom, 0.08)) * 2.4);
    ctx.save();
    ctx.font = `${fontPx}px Space Grotesk, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    this.labelHitRects = [];

    const candidates = this.nodes
      .filter((node) => this.shouldShowLabel(node))
      .map((node) => {
        const x = this.worldToScreenX(node.worldX);
        const y = this.worldToScreenY(node.renderedWorldY);
        return {
          node,
          x,
          y
        };
      })
      .filter((candidate) => isPointVisible(candidate.x, candidate.y, width, height, 80))
      .sort((left, right) => right.node.labelPriority - left.node.labelPriority);

    const gridSize = 42;
    const grid = new Map<string, Rect[]>();
    const labelUseCounts = new Map<string, number>();
    const maxRepeatsPerLabel = this.maxLabelRepeatsForZoom();

    for (const candidate of candidates) {
      const labelKey = candidate.node.label.trim().toLowerCase();
      const usedCount = labelUseCounts.get(labelKey) ?? 0;
      if (!candidate.node.isCurrent && !candidate.node.isHovered && usedCount >= maxRepeatsPerLabel) {
        continue;
      }

      const textWidth = ctx.measureText(candidate.node.label).width;
      const textHeight = fontPx + 4;

      const anchors = [
        { x: candidate.x + 9, y: candidate.y - textHeight / 2 },
        { x: candidate.x - textWidth - 14, y: candidate.y - textHeight / 2 },
        { x: candidate.x + 6, y: candidate.y - textHeight - 9 },
        { x: candidate.x + 6, y: candidate.y + 8 }
      ];

      for (const anchor of anchors) {
        const box: Rect = {
          x: anchor.x,
          y: anchor.y,
          width: textWidth + 10,
          height: textHeight
        };

        if (!rectFitsViewport(box, width, height)) {
          continue;
        }

        if (!canPlaceRect(box, grid, gridSize)) {
          continue;
        }

        addRectToGrid(box, grid, gridSize);

        ctx.fillStyle = 'rgba(8, 18, 23, 0.82)';
        ctx.fillRect(box.x, box.y, box.width, box.height);

        ctx.fillStyle = candidate.node.isCurrent
          ? '#d2ffe8'
          : candidate.node.isHovered
            ? '#fff2be'
            : '#d6e7ea';

        ctx.fillText(candidate.node.label, box.x + 5, box.y + box.height / 2);
        this.labelHitRects.push({ nodeId: candidate.node.id, rect: box });
        labelUseCounts.set(labelKey, usedCount + 1);
        break;
      }
    }

    ctx.restore();
  }

  private shouldShowLabel(node: RenderNode): boolean {
    if (node.isCurrent || node.isHovered) {
      return true;
    }

    const isLeaf = node.childIds.length === 0;

    if (this.camera.zoom < 0.2) {
      return node.semanticImportance >= 8;
    }

    if (this.camera.zoom < 0.55) {
      return node.semanticImportance >= 6 && !isLeaf;
    }

    if (this.camera.zoom < 0.95) {
      return node.semanticImportance >= 4 || !isLeaf;
    }

    return true;
  }

  private shouldDrawNode(node: RenderNode): boolean {
    if (node.isCurrent || node.isHovered || node.isOnVisitedPath) {
      return true;
    }

    const isInternal = node.childIds.length > 0;

    if (this.camera.zoom < 0.08) {
      return node.semanticImportance >= 11 && isInternal;
    }

    if (this.camera.zoom < 0.13) {
      return node.semanticImportance >= 9 && isInternal;
    }

    if (this.camera.zoom < 0.2) {
      return node.semanticImportance >= 7 && isInternal;
    }

    if (this.camera.zoom < 0.32) {
      return node.semanticImportance >= 5 || isInternal;
    }

    return true;
  }

  private maxLabelRepeatsForZoom(): number {
    if (this.camera.zoom < 0.25) {
      return 1;
    }

    if (this.camera.zoom < 0.7) {
      return 2;
    }

    if (this.camera.zoom < 1.2) {
      return 3;
    }

    return 5;
  }

  private worldToScreenX(worldX: number): number {
    return (worldX - this.camera.x) * this.camera.zoom + this.camera.viewportWidth / 2;
  }

  private worldToScreenY(worldY: number): number {
    return (worldY - this.camera.y) * this.camera.zoom + this.camera.viewportHeight / 2;
  }
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

function isSegmentVisible(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  height: number,
  margin: number
): boolean {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  return !(maxX < -margin || minX > width + margin || maxY < -margin || minY > height + margin);
}

function isPointVisible(
  x: number,
  y: number,
  width: number,
  height: number,
  margin: number
): boolean {
  return !(x < -margin || x > width + margin || y < -margin || y > height + margin);
}

function rectFitsViewport(rect: Rect, width: number, height: number): boolean {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= width &&
    rect.y + rect.height <= height
  );
}

function pointInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function canPlaceRect(rect: Rect, grid: Map<string, Rect[]>, gridSize: number): boolean {
  const keys = keysForRect(rect, gridSize);

  for (const key of keys) {
    const bucket = grid.get(key);
    if (!bucket) {
      continue;
    }

    for (const existing of bucket) {
      if (rectIntersects(rect, existing)) {
        return false;
      }
    }
  }

  return true;
}

function addRectToGrid(rect: Rect, grid: Map<string, Rect[]>, gridSize: number): void {
  const keys = keysForRect(rect, gridSize);

  for (const key of keys) {
    const bucket = grid.get(key);
    if (bucket) {
      bucket.push(rect);
      continue;
    }

    grid.set(key, [rect]);
  }
}

function keysForRect(rect: Rect, gridSize: number): string[] {
  const minCol = Math.floor(rect.x / gridSize);
  const maxCol = Math.floor((rect.x + rect.width) / gridSize);
  const minRow = Math.floor(rect.y / gridSize);
  const maxRow = Math.floor((rect.y + rect.height) / gridSize);

  const keys: string[] = [];

  for (let row = minRow - 1; row <= maxRow + 1; row += 1) {
    for (let col = minCol - 1; col <= maxCol + 1; col += 1) {
      keys.push(`${row}:${col}`);
    }
  }

  return keys;
}

function rectIntersects(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}
