import { describe, expect, it } from 'vitest';

import { fixtureScientificPhylogeny } from '@evo-tree/domain';

import { defaultDifficulty } from './difficulty';
import { listEligibleTargetIds, selectTargetFromTree } from './targetSelection';

function makeRng(seed: number): () => number {
  let value = seed;

  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

describe('target selection', () => {
  it('lists target-eligible nodes from scientific tree', () => {
    const ids = listEligibleTargetIds(fixtureScientificPhylogeny);

    expect(ids).toContain('homo-sapiens');
    expect(ids).toContain('panthera-leo');
    expect(ids).toContain('panthera-tigris');
  });

  it('biases toward familiar targets on low familiarity setting', () => {
    const lowDifficulty = {
      ...defaultDifficulty(),
      targetFamiliarity: 0
    };

    const highDifficulty = {
      ...defaultDifficulty(),
      targetFamiliarity: 1
    };

    const lowRng = makeRng(7);
    const highRng = makeRng(7);

    let lowFamiliarCount = 0;
    let highFamiliarCount = 0;

    for (let i = 0; i < 300; i += 1) {
      const lowChoice = selectTargetFromTree(
        {
          ...fixtureScientificPhylogeny,
          nodesById: {
            familiar: {
              ...fixtureScientificPhylogeny.nodesById['homo-sapiens']!,
              id: 'familiar',
              childIds: [],
              isTargetEligible: true,
              scientificName: 'Familiar species'
            },
            obscure: {
              ...fixtureScientificPhylogeny.nodesById['panthera-tigris']!,
              id: 'obscure',
              childIds: [],
              isTargetEligible: true,
              scientificName: 'Obscure species'
            }
          },
          rootId: 'familiar'
        },
        lowDifficulty,
        [
          { speciesId: 'familiar', familiarityScore: 1 },
          { speciesId: 'obscure', familiarityScore: 0 }
        ],
        lowRng
      );

      const highChoice = selectTargetFromTree(
        {
          ...fixtureScientificPhylogeny,
          nodesById: {
            familiar: {
              ...fixtureScientificPhylogeny.nodesById['homo-sapiens']!,
              id: 'familiar',
              childIds: [],
              isTargetEligible: true,
              scientificName: 'Familiar species'
            },
            obscure: {
              ...fixtureScientificPhylogeny.nodesById['panthera-tigris']!,
              id: 'obscure',
              childIds: [],
              isTargetEligible: true,
              scientificName: 'Obscure species'
            }
          },
          rootId: 'familiar'
        },
        highDifficulty,
        [
          { speciesId: 'familiar', familiarityScore: 1 },
          { speciesId: 'obscure', familiarityScore: 0 }
        ],
        highRng
      );

      if (lowChoice === 'familiar') {
        lowFamiliarCount += 1;
      }

      if (highChoice === 'familiar') {
        highFamiliarCount += 1;
      }
    }

    expect(lowFamiliarCount).toBeGreaterThan(highFamiliarCount);
  });
});
