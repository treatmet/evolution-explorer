import type { DifficultyConfig, ScientificPhylogeny } from './types';

export function getLineage(tree: ScientificPhylogeny, nodeId: string): string[] {
  const lineage: string[] = [];
  let currentId: string | null = nodeId;

  while (currentId) {
    const currentNode: ScientificPhylogeny['nodesById'][string] | undefined =
      tree.nodesById[currentId];
    if (!currentNode) {
      return [];
    }

    lineage.push(currentNode.id);
    currentId = currentNode.parentId;
  }

  return lineage.reverse();
}

export function findMostRecentCommonAncestor(
  tree: ScientificPhylogeny,
  nodeAId: string,
  nodeBId: string
): string | null {
  const lineageA = getLineage(tree, nodeAId);
  const lineageB = getLineage(tree, nodeBId);

  if (lineageA.length === 0 || lineageB.length === 0) {
    return null;
  }

  const shortest = Math.min(lineageA.length, lineageB.length);
  let mrca: string | null = null;

  for (let i = 0; i < shortest; i += 1) {
    if (lineageA[i] !== lineageB[i]) {
      break;
    }

    mrca = lineageA[i] ?? null;
  }

  return mrca;
}

export function getSharedLineage(
  tree: ScientificPhylogeny,
  nodeAId: string,
  nodeBId: string
): string[] {
  const lineageA = getLineage(tree, nodeAId);
  const lineageB = getLineage(tree, nodeBId);
  const shared: string[] = [];
  const shortest = Math.min(lineageA.length, lineageB.length);

  for (let i = 0; i < shortest; i += 1) {
    if (lineageA[i] !== lineageB[i]) {
      break;
    }

    const id = lineageA[i];
    if (id) {
      shared.push(id);
    }
  }

  return shared;
}

export function estimateDivergenceFromMrca(
  tree: ScientificPhylogeny,
  nodeAId: string,
  nodeBId: string
): number | null {
  const mrcaId = findMostRecentCommonAncestor(tree, nodeAId, nodeBId);
  if (!mrcaId) {
    return null;
  }

  const mrcaNode = tree.nodesById[mrcaId];
  return mrcaNode?.divergenceAgeMa ?? null;
}

export function deriveAdvancedDifficulty(master: number): DifficultyConfig {
  const clamped = Math.max(0, Math.min(1, master));

  return {
    masterDifficulty: clamped,
    evolutionDepth: Math.round(10 + clamped * 20),
    targetFamiliarity: clamped,
    maxChoicesPerDecision: clamped < 0.75 ? 4 : 5,
    backtrackingEnabled: true
  };
}
