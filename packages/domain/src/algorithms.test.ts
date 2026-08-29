import { describe, expect, it } from 'vitest';

import {
  estimateDivergenceFromMrca,
  findMostRecentCommonAncestor,
  getLineage,
  getSharedLineage
} from './algorithms';
import { fixtureScientificPhylogeny } from './fixture';

describe('domain lineage algorithms', () => {
  it('builds a lineage from root to node', () => {
    const lineage = getLineage(fixtureScientificPhylogeny, 'panthera-tigris');

    expect(lineage).toEqual([
      'luca',
      'eukaryota',
      'opisthokonta',
      'metazoa',
      'bilateria',
      'deuterostomia',
      'chordata',
      'mammalia',
      'panthera',
      'panthera-tigris'
    ]);
  });

  it('finds MRCA for lion and tiger', () => {
    const mrca = findMostRecentCommonAncestor(
      fixtureScientificPhylogeny,
      'panthera-leo',
      'panthera-tigris'
    );

    expect(mrca).toBe('panthera');
  });

  it('finds shared lineage for human and tiger', () => {
    const shared = getSharedLineage(
      fixtureScientificPhylogeny,
      'homo-sapiens',
      'panthera-tigris'
    );

    expect(shared).toEqual([
      'luca',
      'eukaryota',
      'opisthokonta',
      'metazoa',
      'bilateria',
      'deuterostomia',
      'chordata',
      'mammalia'
    ]);
  });

  it('uses MRCA age as divergence estimate', () => {
    const divergenceMa = estimateDivergenceFromMrca(
      fixtureScientificPhylogeny,
      'panthera-leo',
      'panthera-tigris'
    );

    expect(divergenceMa).toBe(6);
  });
});
