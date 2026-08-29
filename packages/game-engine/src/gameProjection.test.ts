import { describe, expect, it } from 'vitest';

import { fixtureScientificPhylogeny } from '@evo-tree/domain';

import { projectScientificTree } from './gameProjection';

describe('projectScientificTree', () => {
  it('returns a projection that preserves scientific topology in milestone 1', () => {
    const result = projectScientificTree(fixtureScientificPhylogeny, 'panthera-tigris', {
      desiredDecisionCount: 12,
      maxChoicesPerDecision: 4,
      preserveScientificallyImportantNodes: true,
      preserveUncertainNodes: true
    });

    expect(result.rootId).toBe('luca');
    expect(result.nodesById['panthera-tigris']?.sourceNodeIds).toEqual(['panthera-tigris']);
    expect(result.diagnostics.navigationNodesInserted).toBe(0);
  });
});
