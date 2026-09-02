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

interface NodeRenderPlacement {
  node: RenderNode;
  x: number;
  y: number;
  radius: number;
  priority: number;
}

export class CanvasTreeRenderer implements TreeRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private nodes: RenderNode[] = [];
  private nodesById = new Map<string, RenderNode>();
  private imageCache = new Map<string, HTMLImageElement>();
  private failedImageUrls = new Set<string>();
  private camera: CameraState = {
    x: 0,
    y: 0,
    zoom: 1,
    viewportWidth: 1,
    viewportHeight: 1
  };
  private lastFrameMs = 0;
  private labelHitRects: Array<{ nodeId: string; rect: Rect }> = [];
  private lastNodePlacements: NodeRenderPlacement[] = [];

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
    this.labelHitRects = [];
    this.lastNodePlacements = [];
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

    for (const placement of this.lastNodePlacements) {
      const dx = placement.x - screenX;
      const dy = placement.y - screenY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const hitRadius = placement.radius + 6;

      if (distance <= hitRadius && distance < bestDistance) {
        bestDistance = distance;
        bestId = placement.node.id;
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

    this.drawBranches(ctx, width, height);

    const placements = this.computeNodePlacements(width, height);
    this.lastNodePlacements = placements;

    this.drawNodes(ctx, placements);
    this.drawLabels(ctx, width, height, placements);
  }

  destroy(): void {
    this.nodes = [];
    this.nodesById.clear();
    this.imageCache.clear();
    this.failedImageUrls.clear();
    this.context = null;
    this.canvas = null;
    this.lastFrameMs = 0;
    this.labelHitRects = [];
    this.lastNodePlacements = [];
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

      if (!isSegmentVisible(x1, y1, x2, y2, width, height, 120)) {
        continue;
      }

      const forwardDelta = Math.max(24, Math.abs(x2 - x1) * 0.45);
      const controlX1 = x1 + forwardDelta;
      const controlX2 = x2 - forwardDelta;

      ctx.strokeStyle = node.isOnVisitedPath
        ? 'rgba(126, 255, 211, 0.8)'
        : 'rgba(111, 149, 160, 0.45)';

      ctx.lineWidth = node.isOnVisitedPath
        ? clamp(1.8, 5, 1.5 + this.camera.zoom * 2.6)
        : clamp(1, 2.8, 0.8 + this.camera.zoom * 1.2);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(controlX1, y1, controlX2, y2, x2, y2);
      ctx.stroke();
    }

    ctx.restore();
  }

  private computeNodePlacements(width: number, height: number): NodeRenderPlacement[] {
    const candidates: NodeRenderPlacement[] = [];

    for (const node of this.nodes) {
      const x = this.worldToScreenX(node.worldX);
      const y = this.worldToScreenY(node.renderedWorldY);

      if (!isPointVisible(x, y, width, height, 140)) {
        continue;
      }

      candidates.push({
        node,
        x,
        y,
        radius: this.nodeRadius(node),
        priority: this.nodePriority(node)
      });
    }

    candidates.sort((left, right) => right.priority - left.priority);

    const selected: NodeRenderPlacement[] = [];
    const gridSize = 88;
    const grid = new Map<string, NodeRenderPlacement[]>();

    for (const candidate of candidates) {
      const collisions = this.findPlacementCollisions(candidate, grid, gridSize);
      if (collisions.length > 0) {
        if (!this.shouldDrawNodeUnderZoomPressure(candidate.node)) {
          continue;
        }

        const hasHigherOrEqualPriorityCollision = collisions.some(
          (entry) => entry.priority >= candidate.priority
        );

        if (
          hasHigherOrEqualPriorityCollision &&
          !candidate.node.isCurrent &&
          !candidate.node.isHovered
        ) {
          continue;
        }
      }

      selected.push(candidate);
      this.addPlacementToGrid(candidate, grid, gridSize);
    }

    return selected;
  }

  private drawNodes(ctx: CanvasRenderingContext2D, placements: ReadonlyArray<NodeRenderPlacement>): void {
    ctx.save();

    const renderOrder = [...placements].sort((left, right) => left.priority - right.priority);

    for (const placement of renderOrder) {
      const node = placement.node;
      const x = placement.x;
      const y = placement.y;
      const radius = placement.radius;
      const innerRadius = Math.max(5, radius - 2.6);

      if (node.isCurrent) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120, 255, 210, 0.18)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(8, 18, 25, 0.95)';
      ctx.fill();

      ctx.lineWidth = node.isCurrent ? 3 : node.isHovered ? 2.6 : node.isOnVisitedPath ? 2.1 : 1.6;
      ctx.strokeStyle = node.isCurrent
        ? '#89ffd0'
        : node.isHovered
          ? '#ffe199'
          : node.isOnVisitedPath
            ? '#9ef1d2'
            : 'rgba(163, 199, 210, 0.52)';
      ctx.stroke();

      const image = node.imageUrl ? this.getLoadedImage(node.imageUrl) : null;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, innerRadius, 0, Math.PI * 2);
      ctx.clip();

      if (image) {
        ctx.drawImage(image, x - innerRadius, y - innerRadius, innerRadius * 2, innerRadius * 2);
      } else {
        const gradient = ctx.createLinearGradient(x - innerRadius, y - innerRadius, x + innerRadius, y + innerRadius);
        gradient.addColorStop(0, 'rgba(78, 130, 158, 0.95)');
        gradient.addColorStop(1, 'rgba(45, 79, 97, 0.95)');
        ctx.fillStyle = gradient;
        ctx.fillRect(x - innerRadius, y - innerRadius, innerRadius * 2, innerRadius * 2);

        ctx.fillStyle = 'rgba(240, 247, 249, 0.92)';
        ctx.font = `${Math.max(8, Math.round(innerRadius * 0.72))}px Space Grotesk, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.fallbackMonogram ?? '?', x, y + 1);
      }

      ctx.restore();
    }

    ctx.restore();
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    placements: ReadonlyArray<NodeRenderPlacement>
  ): void {
    const fontPx = clamp(9, 15, 10 + Math.log2(Math.max(this.camera.zoom, 0.12)) * 1.8);
    ctx.save();
    ctx.font = `${fontPx}px Space Grotesk, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    this.labelHitRects = [];

    const candidates = placements
      .filter((placement) => this.shouldShowLabel(placement.node))
      .sort((left, right) => right.priority - left.priority);

    const gridSize = 44;
    const grid = new Map<string, Rect[]>();
    const labelUseCounts = new Map<string, number>();
    const maxRepeatsPerLabel = this.maxLabelRepeatsForZoom();

    for (const candidate of candidates) {
      const labelKey = candidate.node.label.trim().toLowerCase();
      const usedCount = labelUseCounts.get(labelKey) ?? 0;
      if (!candidate.node.isCurrent && !candidate.node.isHovered && usedCount >= maxRepeatsPerLabel) {
        continue;
      }

      const text = candidate.node.label;
      const textWidth = ctx.measureText(text).width;
      const textHeight = fontPx + 6;

      const box: Rect = {
        x: candidate.x - textWidth / 2 - 6,
        y: candidate.y + candidate.radius + 7,
        width: textWidth + 12,
        height: textHeight
      };

      if (!rectFitsViewport(box, width, height)) {
        continue;
      }

      const isPriority = candidate.node.isCurrent || candidate.node.isHovered;
      if (!isPriority && !canPlaceRect(box, grid, gridSize)) {
        continue;
      }

      addRectToGrid(box, grid, gridSize);

      ctx.fillStyle = candidate.node.isCurrent
        ? '#d9ffe9'
        : candidate.node.isHovered
          ? '#fff0bf'
          : 'rgba(216, 233, 238, 0.92)';
      ctx.fillText(text, box.x + 6, box.y + box.height / 2);

      this.labelHitRects.push({ nodeId: candidate.node.id, rect: box });
      labelUseCounts.set(labelKey, usedCount + 1);
    }

    ctx.restore();
  }

  private shouldShowLabel(node: RenderNode): boolean {
    if (node.isCurrent || node.isHovered) {
      return true;
    }

    const isInternal = node.childIds.length > 0;

    if (this.camera.zoom < 0.18) {
      return node.semanticImportance >= 8 && isInternal;
    }

    if (this.camera.zoom < 0.32) {
      return node.semanticImportance >= 6 && isInternal;
    }

    if (this.camera.zoom < 0.6) {
      return node.semanticImportance >= 4 || node.isOnVisitedPath;
    }

    if (this.camera.zoom < 0.9) {
      return node.semanticImportance >= 4 || isInternal;
    }

    return true;
  }

  private shouldDrawNodeUnderZoomPressure(node: RenderNode): boolean {
    if (node.isCurrent || node.isHovered || node.isOnVisitedPath) {
      return true;
    }

    const isInternal = node.childIds.length > 0;

    if (this.camera.zoom < 0.12) {
      return node.semanticImportance >= 8 && isInternal;
    }

    if (this.camera.zoom < 0.2) {
      return node.semanticImportance >= 6 && isInternal;
    }

    if (this.camera.zoom < 0.32) {
      return node.semanticImportance >= 4 || isInternal;
    }

    if (this.camera.zoom < 0.46) {
      return node.semanticImportance >= 4 || isInternal;
    }

    return true;
  }

  private maxLabelRepeatsForZoom(): number {
    if (this.camera.zoom < 0.24) {
      return 1;
    }

    if (this.camera.zoom < 0.62) {
      return 2;
    }

    if (this.camera.zoom < 1.2) {
      return 3;
    }

    return 5;
  }

  private findPlacementCollisions(
    placement: NodeRenderPlacement,
    grid: Map<string, NodeRenderPlacement[]>,
    gridSize: number
  ): NodeRenderPlacement[] {
    const searchRect: Rect = {
      x: placement.x - placement.radius - 2,
      y: placement.y - placement.radius - 2,
      width: placement.radius * 2 + 4,
      height: placement.radius * 2 + 4
    };

    const keys = keysForRect(searchRect, gridSize);
    const seen = new Set<string>();
    const collisions: NodeRenderPlacement[] = [];

    for (const key of keys) {
      const bucket = grid.get(key);
      if (!bucket) {
        continue;
      }

      for (const existing of bucket) {
        if (seen.has(existing.node.id)) {
          continue;
        }
        seen.add(existing.node.id);

        const dx = placement.x - existing.x;
        const dy = placement.y - existing.y;
        const minDistance = placement.radius + existing.radius + 3;

        if (dx * dx + dy * dy < minDistance * minDistance) {
          collisions.push(existing);
        }
      }
    }

    return collisions;
  }

  private addPlacementToGrid(
    placement: NodeRenderPlacement,
    grid: Map<string, NodeRenderPlacement[]>,
    gridSize: number
  ): void {
    const rect: Rect = {
      x: placement.x - placement.radius,
      y: placement.y - placement.radius,
      width: placement.radius * 2,
      height: placement.radius * 2
    };

    const keys = keysForRect(rect, gridSize);
    for (const key of keys) {
      const bucket = grid.get(key);
      if (bucket) {
        bucket.push(placement);
      } else {
        grid.set(key, [placement]);
      }
    }
  }

  private nodePriority(node: RenderNode): number {
    let priority = node.labelPriority + node.semanticImportance * 6;

    if (node.childIds.length > 0) {
      priority += 120;
    }

    if (node.isOnVisitedPath) {
      priority += 250;
    }

    if (node.isHovered) {
      priority += 900;
    }

    if (node.isCurrent) {
      priority += 1200;
    }

    return priority;
  }

  private worldToScreenX(worldX: number): number {
    return (worldX - this.camera.x) * this.camera.zoom + this.camera.viewportWidth / 2;
  }

  private worldToScreenY(worldY: number): number {
    return (worldY - this.camera.y) * this.camera.zoom + this.camera.viewportHeight / 2;
  }

  private nodeRadius(node: RenderNode): number {
    const base = node.isCurrent ? 25 : node.isHovered ? 22 : node.isOnVisitedPath ? 19 : 16;
    const zoomScale = clamp(0.56, 1.08, 0.56 + this.camera.zoom * 0.34);
    return base * zoomScale;
  }

  private getLoadedImage(url: string): HTMLImageElement | null {
    if (this.failedImageUrls.has(url)) {
      return null;
    }

    const cached = this.imageCache.get(url);
    if (cached) {
      if (cached.complete && cached.naturalWidth > 0) {
        return cached;
      }
      return null;
    }

    const image = new Image();
    image.decoding = 'async';
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      // no-op; next render frame will pick up this image from cache.
    };
    image.onerror = () => {
      this.failedImageUrls.add(url);
      this.imageCache.delete(url);
    };
    image.src = url;

    this.imageCache.set(url, image);
    return null;
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
