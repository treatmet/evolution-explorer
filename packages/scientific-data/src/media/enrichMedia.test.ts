import { describe, expect, it } from 'vitest';

import type { ScientificPhylogeny } from '@evo-tree/domain';

import type { TargetSpecies } from '../types';
import { enrichMediaForScientificTree } from './enrichMedia';

function makeTree(): ScientificPhylogeny {
  return {
    datasetVersion: 'test-tree',
    rootId: 'luca',
    nodesById: {
      luca: {
        id: 'luca',
        parentId: null,
        childIds: ['branch-1'],
        kind: 'ancestral',
        displayName: 'LUCA',
        isGameEndpoint: false,
        isTargetEligible: false,
        navigationOnly: false,
        extant: false,
        divergenceAgeMa: 3900,
        traits: [],
        confidence: 'medium',
        provenance: []
      },
      'branch-1': {
        id: 'branch-1',
        parentId: 'luca',
        childIds: ['homo-sapiens', 'panthera-tigris'],
        kind: 'navigation',
        displayName: 'Branch 1',
        isGameEndpoint: false,
        isTargetEligible: false,
        navigationOnly: true,
        extant: false,
        divergenceAgeMa: 500,
        traits: [],
        confidence: 'low',
        provenance: [],
        navigationExplanation: 'Test split'
      },
      'homo-sapiens': {
        id: 'homo-sapiens',
        parentId: 'branch-1',
        childIds: [],
        kind: 'named-taxon',
        displayName: 'Human',
        scientificName: 'Homo sapiens',
        commonName: 'Human',
        isGameEndpoint: true,
        isTargetEligible: true,
        navigationOnly: false,
        extant: true,
        divergenceAgeMa: 0,
        traits: [],
        confidence: 'high',
        provenance: []
      },
      'panthera-tigris': {
        id: 'panthera-tigris',
        parentId: 'branch-1',
        childIds: [],
        kind: 'named-taxon',
        displayName: 'Tiger',
        scientificName: 'Panthera tigris',
        commonName: 'Tiger',
        isGameEndpoint: true,
        isTargetEligible: true,
        navigationOnly: false,
        extant: true,
        divergenceAgeMa: 0,
        traits: [],
        confidence: 'high',
        provenance: []
      }
    }
  };
}

const targets: TargetSpecies[] = [
  {
    id: 'homo-sapiens',
    scientificName: 'Homo sapiens',
    scientificNameNormalized: 'Homo sapiens',
    commonName: 'Human',
    briefDescriptor: 'Tool-using great ape'
  },
  {
    id: 'panthera-tigris',
    scientificName: 'Panthera tigris',
    scientificNameNormalized: 'Panthera tigris',
    commonName: 'Tiger',
    briefDescriptor: 'Striped cat'
  }
];

describe('enrichMediaForScientificTree', () => {
  it('builds reconstruction queue metadata even in offline mode', async () => {
    const tree = makeTree();

    const { tree: enrichedTree, result } = await enrichMediaForScientificTree(tree, targets, {
      cacheDir: '.tmp-cache-tests',
      online: false,
      maxTargets: 2,
      now: new Date('2026-08-28T12:00:00.000Z')
    });

    expect(result.media.reconstructionQueue.length).toBeGreaterThan(0);
    expect(result.media.targetDifficultyMetadata.length).toBe(2);
    expect(result.media.providerSnapshots.some((provider) => provider.providerId === 'openverse')).toBe(
      true
    );
    expect(enrichedTree.nodesById['luca']?.reconstruction?.reviewStatus).toBe('generated');
    const reconstructionAssetId = enrichedTree.nodesById['luca']?.reconstruction?.assetId;
    expect(reconstructionAssetId).toBeTruthy();
    expect(reconstructionAssetId ? result.media.assetsById[reconstructionAssetId] : undefined).toBeTruthy();
    expect(result.warnings.some((warning) => warning.includes('offline mode'))).toBe(true);
  });
});
