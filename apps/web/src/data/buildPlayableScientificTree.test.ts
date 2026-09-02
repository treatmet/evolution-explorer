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

  it('removes pass-through unary internals so nodes represent branch decisions', () => {
    const tree: ScientificPhylogeny = {
      datasetVersion: 'test',
      rootId: 'root',
      nodesById: {
        root: {
          id: 'root',
          parentId: null,
          childIds: ['pass-through-a'],
          kind: 'ancestral',
          displayName: 'Root',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: false,
          extant: false,
          divergenceAgeMa: 100,
          traits: [],
          confidence: 'medium',
          provenance: []
        },
        'pass-through-a': {
          id: 'pass-through-a',
          parentId: 'root',
          childIds: ['pass-through-b'],
          kind: 'named-taxon',
          displayName: 'Supergroup A',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 80,
          traits: [],
          confidence: 'medium',
          provenance: []
        },
        'pass-through-b': {
          id: 'pass-through-b',
          parentId: 'pass-through-a',
          childIds: ['left-endpoint', 'right-endpoint'],
          kind: 'named-taxon',
          displayName: 'Group B',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 60,
          traits: [],
          confidence: 'medium',
          provenance: []
        },
        'left-endpoint': {
          id: 'left-endpoint',
          parentId: 'pass-through-b',
          childIds: [],
          kind: 'named-taxon',
          displayName: 'Left endpoint',
          isGameEndpoint: true,
          isTargetEligible: true,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 0,
          traits: [],
          confidence: 'high',
          provenance: []
        },
        'right-endpoint': {
          id: 'right-endpoint',
          parentId: 'pass-through-b',
          childIds: [],
          kind: 'named-taxon',
          displayName: 'Right endpoint',
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

    const result = buildPlayableScientificTree(tree);

    expect(result.tree.nodesById['pass-through-b']).toBeUndefined();
    expect(result.tree.nodesById['pass-through-a']?.childIds).toEqual([
      'left-endpoint',
      'right-endpoint'
    ]);
  });

  it('splices unresolved non-informative nodes into the previous decision as fallback', () => {
    const tree: ScientificPhylogeny = {
      datasetVersion: 'test',
      rootId: 'root',
      nodesById: {
        root: {
          id: 'root',
          parentId: null,
          childIds: ['eukaryota'],
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
        eukaryota: {
          id: 'eukaryota',
          parentId: 'root',
          childIds: ['mrca-bridge', 'chloroplastida'],
          kind: 'named-taxon',
          displayName: 'Eukaryota',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 2000,
          traits: [],
          confidence: 'medium',
          provenance: []
        },
        'mrca-bridge': {
          id: 'mrca-bridge',
          parentId: 'eukaryota',
          childIds: ['holozoa', 'nucletmycea'],
          kind: 'unnamed-clade',
          displayName: 'mrca',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 1200,
          traits: [
            {
              id: 'mrca-bridge-trait',
              name: 'Synthetic branch placeholder',
              description: 'Retained for splice fallback test coverage.',
              traitType: 'inferred',
              confidence: 'low',
              provenance: []
            }
          ],
          confidence: 'medium',
          provenance: []
        },
        holozoa: {
          id: 'holozoa',
          parentId: 'mrca-bridge',
          childIds: ['human'],
          kind: 'named-taxon',
          displayName: 'Holozoa',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 800,
          traits: [],
          confidence: 'medium',
          provenance: []
        },
        nucletmycea: {
          id: 'nucletmycea',
          parentId: 'mrca-bridge',
          childIds: ['mold'],
          kind: 'named-taxon',
          displayName: 'Nucletmycea',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 800,
          traits: [],
          confidence: 'medium',
          provenance: []
        },
        chloroplastida: {
          id: 'chloroplastida',
          parentId: 'eukaryota',
          childIds: ['dandelion'],
          kind: 'named-taxon',
          displayName: 'Chloroplastida',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 900,
          traits: [],
          confidence: 'medium',
          provenance: []
        },
        human: {
          id: 'human',
          parentId: 'holozoa',
          childIds: [],
          kind: 'named-taxon',
          displayName: 'Human',
          isGameEndpoint: true,
          isTargetEligible: true,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 0,
          traits: [],
          confidence: 'high',
          provenance: []
        },
        mold: {
          id: 'mold',
          parentId: 'nucletmycea',
          childIds: [],
          kind: 'named-taxon',
          displayName: 'Pin mold',
          isGameEndpoint: true,
          isTargetEligible: true,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 0,
          traits: [],
          confidence: 'high',
          provenance: []
        },
        dandelion: {
          id: 'dandelion',
          parentId: 'chloroplastida',
          childIds: [],
          kind: 'named-taxon',
          displayName: 'Common dandelion',
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

    const result = buildPlayableScientificTree(tree);

    expect(result.tree.nodesById['mrca-bridge']).toBeUndefined();
    expect(result.splicedNonInformativeNodeCount).toBeGreaterThan(0);
    expect(result.tree.nodesById.eukaryota?.childIds).toEqual([
      'holozoa',
      'nucletmycea',
      'chloroplastida'
    ]);
  });

  it('preserves major priority clades in unary chains', () => {
    const tree: ScientificPhylogeny = {
      datasetVersion: 'test',
      rootId: 'root',
      nodesById: {
        root: {
          id: 'root',
          parentId: null,
          childIds: ['nucletmycea'],
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
        nucletmycea: {
          id: 'nucletmycea',
          parentId: 'root',
          childIds: ['fungi'],
          kind: 'named-taxon',
          displayName: 'Nucletmycea',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 800,
          traits: [],
          confidence: 'medium',
          provenance: []
        },
        fungi: {
          id: 'fungi',
          parentId: 'nucletmycea',
          childIds: ['mold'],
          kind: 'named-taxon',
          displayName: 'Fungi',
          isGameEndpoint: false,
          isTargetEligible: false,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 700,
          traits: [],
          confidence: 'medium',
          provenance: []
        },
        mold: {
          id: 'mold',
          parentId: 'fungi',
          childIds: [],
          kind: 'named-taxon',
          displayName: 'Pin mold',
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

    const result = buildPlayableScientificTree(tree);

    expect(result.tree.nodesById.fungi).toBeDefined();
    expect(result.tree.nodesById.fungi?.parentId).toBe('nucletmycea');
    expect(result.tree.nodesById.nucletmycea?.childIds).toEqual(['fungi']);
  });
});