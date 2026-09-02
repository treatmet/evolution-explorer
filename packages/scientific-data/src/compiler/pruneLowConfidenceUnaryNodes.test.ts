import { describe, expect, it } from 'vitest';

import type { ScientificPhylogeny } from '@evo-tree/domain';

import { pruneLowConfidenceUnaryNodes } from './pruneLowConfidenceUnaryNodes';

describe('pruneLowConfidenceUnaryNodes', () => {
  it('removes unary low-confidence and navigation-only internal nodes', () => {
    const tree: ScientificPhylogeny = {
      datasetVersion: 'test',
      rootId: 'luca',
      nodesById: {
        luca: {
          id: 'luca',
          parentId: null,
          childIds: ['nav-1'],
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
        'nav-1': {
          id: 'nav-1',
          parentId: 'luca',
          childIds: ['clade-1'],
          kind: 'navigation',
          displayName: 'Nav',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: true,
          extant: false,
          divergenceAgeMa: 200,
          traits: [],
          confidence: 'low',
          provenance: []
        },
        'clade-1': {
          id: 'clade-1',
          parentId: 'nav-1',
          childIds: ['homo-sapiens', 'panthera-tigris'],
          kind: 'unnamed-clade',
          displayName: 'Clade',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 150,
          traits: [],
          confidence: 'medium',
          provenance: []
        },
        'homo-sapiens': {
          id: 'homo-sapiens',
          parentId: 'clade-1',
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
          parentId: 'clade-1',
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

    const result = pruneLowConfidenceUnaryNodes(tree);

    expect(result.prunedNodeCount).toBe(1);
    expect(result.tree.nodesById['nav-1']).toBeUndefined();
    expect(result.tree.nodesById.luca?.childIds).toEqual(['clade-1']);
    expect(result.tree.nodesById['clade-1']?.parentId).toBe('luca');
  });
});
