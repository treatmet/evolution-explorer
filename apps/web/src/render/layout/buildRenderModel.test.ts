import { describe, expect, it } from 'vitest';

import type { ScientificPhylogeny } from '@evo-tree/domain';

import { buildRenderModel } from './buildRenderModel';

function makeTreeWithExtinctTerminal(): ScientificPhylogeny {
  return {
    datasetVersion: 'test',
    rootId: 'root',
    nodesById: {
      root: {
        id: 'root',
        parentId: null,
        childIds: ['extinct-tip', 'extant-tip'],
        kind: 'ancestral',
        displayName: 'Root',
        isGameEndpoint: false,
        isTargetEligible: false,
        navigationOnly: false,
        extant: false,
        divergenceAgeMa: 300,
        traits: [],
        confidence: 'high',
        provenance: []
      },
      'extinct-tip': {
        id: 'extinct-tip',
        parentId: 'root',
        childIds: [],
        kind: 'named-taxon',
        displayName: 'Extinct tip',
        isGameEndpoint: true,
        isTargetEligible: true,
        navigationOnly: false,
        extant: false,
        divergenceAgeMa: 100,
        extinctionAgeMa: 65,
        traits: [],
        confidence: 'medium',
        provenance: []
      },
      'extant-tip': {
        id: 'extant-tip',
        parentId: 'root',
        childIds: [],
        kind: 'named-taxon',
        displayName: 'Extant tip',
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

describe('buildRenderModel', () => {
  it('maps geological time to X with older nodes on the left', () => {
    const tree = makeTreeWithExtinctTerminal();
    const model = buildRenderModel(tree, {
      currentNodeId: 'root',
      hoveredNodeId: null,
      visitedNodeIds: ['root']
    });

    const root = model.nodes.find((node) => node.id === 'root');
    const extant = model.nodes.find((node) => node.id === 'extant-tip');

    expect(root && extant).toBeTruthy();
    expect((root?.worldX ?? 0) < (extant?.worldX ?? 0)).toBe(true);
  });

  it('stops extinct terminal nodes at extinction age', () => {
    const tree = makeTreeWithExtinctTerminal();
    const model = buildRenderModel(tree, {
      currentNodeId: 'root',
      hoveredNodeId: null,
      visitedNodeIds: ['root']
    });

    const extinct = model.nodes.find((node) => node.id === 'extinct-tip');
    const extant = model.nodes.find((node) => node.id === 'extant-tip');

    expect(extinct && extant).toBeTruthy();
    expect((extinct?.worldX ?? 0) < (extant?.worldX ?? 0)).toBe(true);
  });
});
