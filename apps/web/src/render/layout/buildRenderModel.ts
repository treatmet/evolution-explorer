import type { ScientificPhylogeny } from '@evo-tree/domain';
import { resolveNodeLabel, type NodeNameForm } from '@evo-tree/domain';
import type { RenderNode } from '@evo-tree/renderer-contracts';

import { applySemanticFisheye } from './fisheye';

export interface RenderModelBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface BuildRenderModelOptions {
  currentNodeId: string;
  hoveredNodeId: string | null;
  visitedNodeIds: ReadonlyArray<string>;
  visibleNodeIds?: ReadonlyArray<string>;
  focusNodeId?: string | null;
  focusStrength?: number;
  nodeImageById?: Readonly<Record<string, string>>;
  nameForm?: NodeNameForm;
}

interface StaticNodeMetrics {
  id: string;
  parentId: string | null;
  childIds: string[];
  worldX: number;
  baseWorldY: number;
  subtreeMinY: number;
  subtreeMaxY: number;
  descendantLeafCount: number;
  label: string;
  semanticImportance: number;
}

interface RenderModelResult {
  nodes: RenderNode[];
  bounds: RenderModelBounds;
}

const BASE_LAYER_HORIZONTAL_SPACING = 320;
const TARGET_TREE_ASPECT_RATIO = 2.2;
const MIN_LEAF_VERTICAL_SPACING = 4;
const MAX_LEAF_VERTICAL_SPACING = 220;

export function buildRenderModel(
  tree: ScientificPhylogeny,
  options: BuildRenderModelOptions
): RenderModelResult {
  const metricsById = computeStaticMetrics(tree, options.nameForm);

  const visitedSet = new Set(options.visitedNodeIds);
  const visibleSet = options.visibleNodeIds ? new Set(options.visibleNodeIds) : null;

  const baseNodes: RenderNode[] = Object.values(metricsById)
    .filter((metric) => visibleSet === null || visibleSet.has(metric.id))
    .map((metric) => {
    const isCurrent = metric.id === options.currentNodeId;
    const isHovered = metric.id === options.hoveredNodeId;
    const isOnVisitedPath = visitedSet.has(metric.id);

    return {
      id: metric.id,
      parentId: metric.parentId,
      childIds: metric.childIds,
      worldX: metric.worldX,
      baseWorldY: metric.baseWorldY,
      fisheyeTargetY: metric.baseWorldY,
      renderedWorldY: metric.baseWorldY,
      subtreeMinY: metric.subtreeMinY,
      subtreeMaxY: metric.subtreeMaxY,
      descendantLeafCount: metric.descendantLeafCount,
      label: metric.label,
      labelPriority: computeLabelPriority(metric.semanticImportance, isCurrent, isHovered),
      semanticImportance: metric.semanticImportance,
      ...(options.nodeImageById?.[metric.id] ? { imageUrl: options.nodeImageById[metric.id] } : {}),
      fallbackMonogram: monogramFromLabel(metric.label),
      isCurrent,
      isHovered,
      isOnVisitedPath
    };
    });

  const fisheyeNodes = applySemanticFisheye(
    baseNodes,
    options.focusNodeId ?? options.currentNodeId,
    options.focusStrength ?? 0.45
  );

  const bounds = computeBounds(fisheyeNodes);
  return {
    nodes: fisheyeNodes,
    bounds
  };
}

function computeStaticMetrics(
  tree: ScientificPhylogeny,
  nameForm?: NodeNameForm
): Record<string, StaticNodeMetrics> {
  const metrics: Record<string, StaticNodeMetrics> = {};
  const nodeDepthById = new Map<string, number>();
  const alignedDepthById = new Map<string, number>();
  const leafYById: Record<string, number> = {};

  const layoutStats = gatherLayoutStats(tree, tree.rootId, 0, nodeDepthById);
  const layerHorizontalSpacing = computeLayerHorizontalSpacing(
    layoutStats.maxDepth,
    layoutStats.leafCount
  );
  const leafVerticalSpacing = computeLeafVerticalSpacing(
    layoutStats.maxDepth,
    layoutStats.leafCount,
    layerHorizontalSpacing
  );

  for (const [nodeId, depth] of nodeDepthById.entries()) {
    const node = tree.nodesById[nodeId];
    if (!node) {
      alignedDepthById.set(nodeId, depth);
      continue;
    }

    if (node.childIds.length === 0 && node.extant) {
      alignedDepthById.set(nodeId, layoutStats.maxLeafDepth);
      continue;
    }

    alignedDepthById.set(nodeId, depth);
  }

  let leafCounter = 0;

  const assignLeafPositions = (nodeId: string): void => {
    const node = tree.nodesById[nodeId];
    if (!node) {
      return;
    }

    if (node.childIds.length === 0) {
      leafYById[nodeId] = leafCounter * leafVerticalSpacing;
      leafCounter += 1;
      return;
    }

    for (const childId of node.childIds) {
      assignLeafPositions(childId);
    }
  };

  assignLeafPositions(tree.rootId);

  const buildNode = (nodeId: string): StaticNodeMetrics | null => {
    const node = tree.nodesById[nodeId];
    if (!node) {
      return null;
    }

    const childMetrics = node.childIds
      .map((childId) => buildNode(childId))
      .filter((value): value is StaticNodeMetrics => value !== null);

    const isLeaf = childMetrics.length === 0;

    const baseWorldY = isLeaf
      ? leafYById[nodeId] ?? 0
      : average(childMetrics.map((child) => child.baseWorldY));

    const subtreeMinY = isLeaf
      ? baseWorldY
      : Math.min(...childMetrics.map((child) => child.subtreeMinY));

    const subtreeMaxY = isLeaf
      ? baseWorldY
      : Math.max(...childMetrics.map((child) => child.subtreeMaxY));

    const descendantLeafCount = isLeaf
      ? 1
      : childMetrics.reduce((sum, child) => sum + child.descendantLeafCount, 0);

    const alignedDepth = alignedDepthById.get(nodeId) ?? 0;
    const worldX = alignedDepth * layerHorizontalSpacing;

    const metric: StaticNodeMetrics = {
      id: node.id,
      parentId: node.parentId,
      childIds: [...node.childIds],
      worldX,
      baseWorldY,
      subtreeMinY,
      subtreeMaxY,
      descendantLeafCount,
      label: resolveNodeLabel(node, nameForm),
      semanticImportance: computeSemanticImportance(nodeId, tree, descendantLeafCount)
    };

    metrics[nodeId] = metric;
    return metric;
  };

  const rootMetric = buildNode(tree.rootId);
  if (rootMetric) {
    normalizeVerticalScale(metrics, rootMetric, layoutStats.maxDepth, layerHorizontalSpacing);
  }

  return metrics;
}

function normalizeVerticalScale(
  metricsById: Record<string, StaticNodeMetrics>,
  rootMetric: StaticNodeMetrics,
  maxDepth: number,
  layerHorizontalSpacing: number
): void {
  const currentSpan = Math.max(1, rootMetric.subtreeMaxY - rootMetric.subtreeMinY);
  const targetSpan = Math.max(220, (maxDepth * layerHorizontalSpacing) / TARGET_TREE_ASPECT_RATIO);
  const scale = targetSpan / currentSpan;

  if (Math.abs(scale - 1) < 0.01) {
    return;
  }

  const centerY = (rootMetric.subtreeMinY + rootMetric.subtreeMaxY) / 2;
  for (const metric of Object.values(metricsById)) {
    metric.baseWorldY = (metric.baseWorldY - centerY) * scale + centerY;
    metric.subtreeMinY = (metric.subtreeMinY - centerY) * scale + centerY;
    metric.subtreeMaxY = (metric.subtreeMaxY - centerY) * scale + centerY;
  }
}

function gatherLayoutStats(
  tree: ScientificPhylogeny,
  nodeId: string,
  depth: number,
  nodeDepthById: Map<string, number>
): {
  maxDepth: number;
  maxLeafDepth: number;
  leafCount: number;
} {
  const node = tree.nodesById[nodeId];
  if (!node) {
    return {
      maxDepth: depth,
      maxLeafDepth: depth,
      leafCount: 0
    };
  }

  nodeDepthById.set(nodeId, depth);

  if (node.childIds.length === 0) {
    return {
      maxDepth: depth,
      maxLeafDepth: depth,
      leafCount: 1
    };
  }

  let maxDepth = depth;
  let maxLeafDepth = depth;
  let leafCount = 0;

  for (const childId of node.childIds) {
    const stats = gatherLayoutStats(tree, childId, depth + 1, nodeDepthById);
    maxDepth = Math.max(maxDepth, stats.maxDepth);
    maxLeafDepth = Math.max(maxLeafDepth, stats.maxLeafDepth);
    leafCount += stats.leafCount;
  }

  return {
    maxDepth,
    maxLeafDepth,
    leafCount
  };
}

function computeLayerHorizontalSpacing(maxDepth: number, leafCount: number): number {
  const depthTuning = clamp(0.9, 1.45, 1.15 + Math.log2(maxDepth + 1) * 0.06);
  const leafTuning =
    leafCount <= 24
      ? 1.25
      : leafCount <= 80
        ? 1.08
        : leafCount <= 260
          ? 1
          : 0.92;

  return Math.round(BASE_LAYER_HORIZONTAL_SPACING * depthTuning * leafTuning);
}

function computeLeafVerticalSpacing(
  maxDepth: number,
  leafCount: number,
  layerHorizontalSpacing: number
): number {
  if (leafCount <= 1) {
    return MAX_LEAF_VERTICAL_SPACING;
  }

  const targetWidth = Math.max(1, maxDepth * layerHorizontalSpacing);
  const targetHeight = targetWidth / TARGET_TREE_ASPECT_RATIO;
  const spacing = targetHeight / Math.max(1, leafCount - 1);

  return clamp(MIN_LEAF_VERTICAL_SPACING, MAX_LEAF_VERTICAL_SPACING, spacing);
}

function computeSemanticImportance(
  nodeId: string,
  tree: ScientificPhylogeny,
  descendantLeafCount: number
): number {
  const node = tree.nodesById[nodeId];
  if (!node) {
    return 1;
  }

  if (node.id === tree.rootId) {
    return 16;
  }

  const cladeWeight = Math.max(1, Math.log2(descendantLeafCount + 1) * 2.4);
  const endpointBoost = node.isGameEndpoint ? 1.5 : 0;
  const confidenceBoost =
    node.confidence === 'high' ? 1.2 : node.confidence === 'medium' ? 0.6 : 0.2;

  return cladeWeight + endpointBoost + confidenceBoost;
}

function computeLabelPriority(
  semanticImportance: number,
  isCurrent: boolean,
  isHovered: boolean
): number {
  const currentBoost = isCurrent ? 30 : 0;
  const hoverBoost = isHovered ? 20 : 0;

  return semanticImportance * 3 + currentBoost + hoverBoost;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sum = values.reduce((total, value) => total + value, 0);
  return sum / values.length;
}

function monogramFromLabel(label: string): string {
  const compact = label.trim();
  if (!compact) {
    return '?';
  }

  const words = compact.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0]?.slice(0, 2).toUpperCase() ?? '?';
  }

  const first = words[0]?.[0] ?? '';
  const second = words[1]?.[0] ?? '';
  return `${first}${second}`.toUpperCase();
}

function computeBounds(nodes: ReadonlyArray<RenderNode>): RenderModelBounds {
  if (nodes.length === 0) {
    return {
      minX: 0,
      maxX: 1,
      minY: 0,
      maxY: 1
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    minX = Math.min(minX, node.worldX);
    maxX = Math.max(maxX, node.worldX);
    minY = Math.min(minY, node.subtreeMinY);
    maxY = Math.max(maxY, node.subtreeMaxY);
  }

  return {
    minX,
    maxX,
    minY,
    maxY
  };
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}
