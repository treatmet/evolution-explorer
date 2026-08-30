import { describe, expect, it } from 'vitest';

import type { ScientificPhylogeny } from '@evo-tree/domain';

import { buildPlayableScientificTree } from './buildPlayableScientificTree';

function makeTreeWithPlaceholderInternal(): ScientificPhylogeny {
  return {
    datasetVersion: 'test',
    rootId: 'root',
    nodesById: {
      root: {
        id: 'root',
        parentId: null,
        childIds: ['mrca-node', 'named-clade'],
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
      'mrca-node': {
        id: 'mrca-node',
        parentId: 'root',
        childIds: ['wolf'],
        kind: 'unnamed-clade',
        displayName: 'mrca',
        isGameEndpoint: false,
        isTargetEligible: false,
        navigationOnly: false,
        extant: false,
        divergenceAgeMa: 120,
        traits: [],
        confidence: 'low',
        provenance: []
      },
      'named-clade': {
        id: 'named-clade',
        parentId: 'root',
        childIds: ['tiger'],
        kind: 'named-taxon',
        displayName: 'Mammalia',
        scientificName: 'Mammalia',
        isGameEndpoint: false,
        isTargetEligible: false,
        navigationOnly: false,
        extant: false,
        divergenceAgeMa: 200,
        traits: [],
        confidence: 'medium',
        provenance: []
      },
      wolf: {
        id: 'wolf',
        parentId: 'mrca-node',
        childIds: [],
        kind: 'named-taxon',
        displayName: 'Wolf',
        scientificName: 'Canis lupus',
        isGameEndpoint: true,
        isTargetEligible: true,
        navigationOnly: false,
        extant: true,
        divergenceAgeMa: 0,
        traits: [],
        confidence: 'medium',
        provenance: []
      },
      tiger: {
        id: 'tiger',
        parentId: 'named-clade',
        childIds: [],
        kind: 'named-taxon',
        displayName: 'Tiger',
        scientificName: 'Panthera tigris',
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

describe('buildPlayableScientificTree', () => {
  it('collapses non-informative placeholder internal nodes', () => {
    const sourceTree = makeTreeWithPlaceholderInternal();
    const result = buildPlayableScientificTree(sourceTree);

    expect(result.skippedNodeCount).toBeGreaterThan(0);
    expect(result.tree.nodesById['mrca-node']).toBeUndefined();
    expect(result.tree.nodesById.root?.childIds.includes('wolf')).toBe(true);
  });

  it('hydrates retained nodes with inferred fallback traits when missing', () => {
    const sourceTree = makeTreeWithPlaceholderInternal();
    const result = buildPlayableScientificTree(sourceTree);

    const mammalia = result.tree.nodesById['named-clade'];
    const tiger = result.tree.nodesById.tiger;

    expect(result.inferredTraitNodeCount).toBeGreaterThan(0);
    expect(mammalia?.traits.length).toBeGreaterThan(0);
    expect(tiger?.traits.length).toBeGreaterThan(0);
    expect(mammalia?.traits[0]?.traitType).toBe('inferred');
  });
});