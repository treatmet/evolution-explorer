import type {
  GameProjectionOptions,
  PhyloNode,
  ScientificPhylogeny
} from '@evo-tree/domain';

export interface ProjectionDiagnostics {
  requestedDecisionCount: number;
  actualDecisionCount: number;
  navigationNodesInserted: number;
  highDegreeScientificNodes: string[];
  warnings: string[];
}

export interface GameProjectionNode {
  id: string;
  sourceNodeIds: string[];
  childIds: string[];
  navigationOnly: boolean;
  displayName: string;
  description?: string;
}

export interface GameProjectionResult {
  rootId: string;
  nodesById: Record<string, GameProjectionNode>;
  diagnostics: ProjectionDiagnostics;
}

export function projectScientificTree(
  tree: ScientificPhylogeny,
  _targetId: string,
  options: GameProjectionOptions
): GameProjectionResult {
  const projectedNodes: Record<string, GameProjectionNode> = {};

  for (const node of Object.values(tree.nodesById)) {
    projectedNodes[node.id] = projectNodeIdentity(node);
  }

  return {
    rootId: tree.rootId,
    nodesById: projectedNodes,
    diagnostics: {
      requestedDecisionCount: options.desiredDecisionCount,
      actualDecisionCount: countDecisionDepth(tree),
      navigationNodesInserted: 0,
      highDegreeScientificNodes: findHighDegreeNodes(tree, options.maxChoicesPerDecision),
      warnings: [
        'Projection currently keeps identity mapping; navigation-only grouping insertion remains pending in a later milestone.'
      ]
    }
  };
}

function projectNodeIdentity(node: PhyloNode): GameProjectionNode {
  return {
    id: node.id,
    sourceNodeIds: [node.id],
    childIds: [...node.childIds],
    navigationOnly: node.navigationOnly,
    displayName: node.displayName,
    ...(node.navigationExplanation
      ? { description: node.navigationExplanation }
      : {})
  };
}

function countDecisionDepth(tree: ScientificPhylogeny): number {
  let maxDepth = 0;

  const visit = (nodeId: string, depth: number): void => {
    const node = tree.nodesById[nodeId];
    if (!node) {
      return;
    }

    maxDepth = Math.max(maxDepth, depth);
    for (const childId of node.childIds) {
      visit(childId, depth + 1);
    }
  };

  visit(tree.rootId, 0);
  return maxDepth;
}

function findHighDegreeNodes(
  tree: ScientificPhylogeny,
  maxChoicesPerDecision: number
): string[] {
  return Object.values(tree.nodesById)
    .filter((node) => node.childIds.length > maxChoicesPerDecision)
    .map((node) => node.id);
}
