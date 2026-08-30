import type { ScientificPhylogeny } from '@evo-tree/domain';
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
  focusNodeId?: string | null;
  focusStrength?: number;
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

const LEAF_VERTICAL_SPACING = 1;
const TARGET_VERTICAL_TO_TIME_RATIO = 0.42;

export function buildRenderModel(
  tree: ScientificPhylogeny,
  options: BuildRenderModelOptions
): RenderModelResult {
  const maxAgeMa = computeMaxAgeMa(tree);
  const metricsById = computeStaticMetrics(tree, maxAgeMa);

  const visitedSet = new Set(options.visitedNodeIds);

  const baseNodes: RenderNode[] = Object.values(metricsById).map((metric) => {
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

function computeMaxAgeMa(tree: ScientificPhylogeny): number {
  const rootAge = tree.nodesById[tree.rootId]?.divergenceAgeMa ?? 0;
  const maxNodeAge = Object.values(tree.nodesById).reduce((max, node) => {
    const age = node.divergenceAgeMa ?? node.extinctionAgeMa ?? 0;
    return Math.max(max, age);
  }, 0);

  return Math.max(1, rootAge, maxNodeAge);
}

function computeStaticMetrics(
  tree: ScientificPhylogeny,
  maxAgeMa: number
): Record<string, StaticNodeMetrics> {
  const metrics: Record<string, StaticNodeMetrics> = {};
  const leafYById: Record<string, number> = {};
  let leafCounter = 0;

  const assignLeafPositions = (nodeId: string): void => {
    const node = tree.nodesById[nodeId];
    if (!node) {
      return;
    }

    if (node.childIds.length === 0) {
      leafYById[nodeId] = leafCounter * LEAF_VERTICAL_SPACING;
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

    const ageForX = resolveAgeForX(tree, nodeId);
    const worldX = maxAgeMa - ageForX;

    const metric: StaticNodeMetrics = {
      id: node.id,
      parentId: node.parentId,
      childIds: [...node.childIds],
      worldX,
      baseWorldY,
      subtreeMinY,
      subtreeMaxY,
      descendantLeafCount,
      label: node.displayName,
      semanticImportance: computeSemanticImportance(nodeId, tree, descendantLeafCount)
    };

    metrics[nodeId] = metric;
    return metric;
  };

  const rootMetric = buildNode(tree.rootId);
  if (rootMetric) {
    normalizeVerticalScale(metrics, rootMetric, maxAgeMa);
  }

  return metrics;
}

function normalizeVerticalScale(
  metricsById: Record<string, StaticNodeMetrics>,
  rootMetric: StaticNodeMetrics,
  maxAgeMa: number
): void {
  const currentSpan = Math.max(1, rootMetric.subtreeMaxY - rootMetric.subtreeMinY);
  const targetSpan = Math.max(220, maxAgeMa * TARGET_VERTICAL_TO_TIME_RATIO);
  const scale = Math.min(1, targetSpan / currentSpan);

  if (scale >= 0.999) {
    return;
  }

  const centerY = (rootMetric.subtreeMinY + rootMetric.subtreeMaxY) / 2;
  for (const metric of Object.values(metricsById)) {
    metric.baseWorldY = (metric.baseWorldY - centerY) * scale + centerY;
    metric.subtreeMinY = (metric.subtreeMinY - centerY) * scale + centerY;
    metric.subtreeMaxY = (metric.subtreeMaxY - centerY) * scale + centerY;
  }
}

function resolveAgeForX(tree: ScientificPhylogeny, nodeId: string): number {
  const node = tree.nodesById[nodeId];
  if (!node) {
    return 0;
  }

  if (node.childIds.length === 0 && !node.extant && node.extinctionAgeMa !== undefined) {
    return node.extinctionAgeMa;
  }

  if (node.divergenceAgeMa !== undefined) {
    return node.divergenceAgeMa;
  }

  if (node.extinctionAgeMa !== undefined) {
    return node.extinctionAgeMa;
  }

  return 0;
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
