import {
  estimateDivergenceFromMrca,
  findMostRecentCommonAncestor,
  getLineage,
  getSharedLineage,
  type ScientificConfidence,
  type ScientificPhylogeny
} from '@evo-tree/domain';

export type ScoreTerminationReason = 'terminal-node' | 'quit-score-now';

export interface GenomicSimilarityResult {
  status: 'available' | 'estimated' | 'unavailable';
  confidence: ScientificConfidence;
  provenanceNote: string;
  valuePercent?: number;
}

export interface GameScoreResult {
  targetId: string;
  arrivedNodeId: string;
  mrcaId: string | null;
  divergenceMa: number | null;
  sharedLineageIds: string[];
  sharedTraitNames: string[];
  phylogeneticRelatednessScore: number;
  genomicSimilarity: GenomicSimilarityResult;
  reason: ScoreTerminationReason;
}

export function scoreNodeAgainstTarget(
  tree: ScientificPhylogeny,
  arrivedNodeId: string,
  targetId: string,
  reason: ScoreTerminationReason
): GameScoreResult {
  const mrcaId = findMostRecentCommonAncestor(tree, arrivedNodeId, targetId);
  const divergenceMa = estimateDivergenceFromMrca(tree, arrivedNodeId, targetId);
  const sharedLineageIds = getSharedLineage(tree, arrivedNodeId, targetId);
  const sharedTraitNames = collectSharedTraitNames(tree, sharedLineageIds);

  return {
    targetId,
    arrivedNodeId,
    mrcaId,
    divergenceMa,
    sharedLineageIds,
    sharedTraitNames,
    phylogeneticRelatednessScore: computeRelatednessScore(tree, arrivedNodeId, targetId),
    genomicSimilarity: {
      status: 'unavailable',
      confidence: 'low',
      provenanceNote:
        'Genomic similarity data is not compiled in Milestone 2; status is intentionally unavailable.'
    },
    reason
  };
}

export function computeRelatednessScore(
  tree: ScientificPhylogeny,
  nodeAId: string,
  nodeBId: string
): number {
  if (nodeAId === nodeBId) {
    return 100;
  }

  const lineageA = getLineage(tree, nodeAId);
  const lineageB = getLineage(tree, nodeBId);

  if (lineageA.length === 0 || lineageB.length === 0) {
    return 0;
  }

  const shared = getSharedLineage(tree, nodeAId, nodeBId);
  const topologySimilarity = shared.length / Math.max(lineageA.length, lineageB.length);

  const divergenceMa = estimateDivergenceFromMrca(tree, nodeAId, nodeBId);
  const rootAgeMa = tree.nodesById[tree.rootId]?.divergenceAgeMa ?? 4000;

  const divergenceFactor =
    divergenceMa === null
      ? 0.5
      : 1 - Math.min(1, Math.max(0, divergenceMa) / Math.max(1, rootAgeMa));

  const weightedScore = (0.7 * topologySimilarity + 0.3 * divergenceFactor) * 100;

  return Math.max(0, Math.min(100, Math.round(weightedScore)));
}

function collectSharedTraitNames(
  tree: ScientificPhylogeny,
  sharedLineageIds: string[]
): string[] {
  const traitNames = new Set<string>();

  for (const nodeId of sharedLineageIds) {
    const node = tree.nodesById[nodeId];
    if (!node) {
      continue;
    }

    for (const trait of node.traits) {
      traitNames.add(trait.name);
    }
  }

  return [...traitNames].sort((a, b) => a.localeCompare(b));
}
