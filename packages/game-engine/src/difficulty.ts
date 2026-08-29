import type { DifficultyConfig } from '@evo-tree/domain';

export function deriveAdvancedDifficulty(master: number): DifficultyConfig {
  const d = Math.max(0, Math.min(1, master));

  return {
    masterDifficulty: d,
    evolutionDepth: Math.round(10 + d * 20),
    targetFamiliarity: d,
    maxChoicesPerDecision: d < 0.75 ? 4 : 5,
    backtrackingEnabled: true
  };
}

export function defaultDifficulty(): DifficultyConfig {
  return deriveAdvancedDifficulty(0.5);
}
