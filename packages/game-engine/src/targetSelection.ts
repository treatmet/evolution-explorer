import type {
  DifficultyConfig,
  ScientificPhylogeny,
  TargetDifficultyMetadata
} from '@evo-tree/domain';

export interface TargetCandidate {
  id: string;
  familiarityScore: number;
  difficultyWeight: number;
}

export function listEligibleTargetIds(tree: ScientificPhylogeny): string[] {
  return Object.values(tree.nodesById)
    .filter((node) => node.isTargetEligible)
    .map((node) => node.id);
}

export function selectTargetFromTree(
  tree: ScientificPhylogeny,
  difficulty: DifficultyConfig,
  targetMetadata: TargetDifficultyMetadata[] = [],
  rng: () => number = Math.random
): string {
  const metadataById = new Map(targetMetadata.map((item) => [item.speciesId, item]));

  const candidates: TargetCandidate[] = listEligibleTargetIds(tree).map((id) => {
    const metadata = metadataById.get(id);

    return {
      id,
      familiarityScore: clamp01(metadata?.familiarityScore ?? 0.5),
      difficultyWeight: metadata?.difficultyWeight ?? 1
    };
  });

  return sampleTargetCandidate(candidates, difficulty, rng).id;
}

export function sampleTargetCandidate(
  candidates: TargetCandidate[],
  difficulty: DifficultyConfig,
  rng: () => number = Math.random
): TargetCandidate {
  if (candidates.length === 0) {
    throw new Error('No target candidates available.');
  }

  const targetFamiliarity = clamp01(difficulty.targetFamiliarity);

  const weighted = candidates.map((candidate) => {
    const familiarityBias = 0.2 + clamp01(candidate.familiarityScore) * 0.8;
    const blendedWeight = lerp(familiarityBias, 1, targetFamiliarity);
    const weight = Math.max(0.0001, blendedWeight * Math.max(0.0001, candidate.difficultyWeight));

    return {
      candidate,
      weight
    };
  });

  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  const target = rng() * totalWeight;

  let cumulative = 0;
  for (const item of weighted) {
    cumulative += item.weight;
    if (target <= cumulative) {
      return item.candidate;
    }
  }

  return weighted[weighted.length - 1]!.candidate;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}
