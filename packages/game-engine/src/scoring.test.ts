import { describe, expect, it } from 'vitest';

import { fixtureScientificPhylogeny } from '@evo-tree/domain';

import { computeRelatednessScore, scoreNodeAgainstTarget } from './scoring';

describe('scoring', () => {
  it('ranks closer relatives with higher relatedness scores', () => {
    const tigerVsLion = computeRelatednessScore(
      fixtureScientificPhylogeny,
      'panthera-tigris',
      'panthera-leo'
    );

    const tigerVsHuman = computeRelatednessScore(
      fixtureScientificPhylogeny,
      'panthera-tigris',
      'homo-sapiens'
    );

    expect(tigerVsLion).toBeGreaterThan(tigerVsHuman);
  });

  it('returns full comparison payload for result views', () => {
    const result = scoreNodeAgainstTarget(
      fixtureScientificPhylogeny,
      'homo-sapiens',
      'panthera-tigris',
      'quit-score-now'
    );

    expect(result.arrivedNodeId).toBe('homo-sapiens');
    expect(result.targetId).toBe('panthera-tigris');
    expect(result.mrcaId).toBe('mammalia');
    expect(result.sharedLineageIds).toContain('mammalia');
    expect(result.genomicSimilarity.status).toBe('unavailable');
  });
});
