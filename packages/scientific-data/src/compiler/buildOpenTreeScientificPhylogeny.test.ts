import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TargetSpecies } from '../types';
import { buildOpenTreeScientificPhylogeny } from './buildOpenTreeScientificPhylogeny';

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
    briefDescriptor: 'Large striped cat'
  },
  {
    id: 'unknown-target',
    scientificName: 'Unknown species',
    scientificNameNormalized: 'Unknown species',
    commonName: 'Unknown',
    briefDescriptor: 'Unknown'
  }
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildOpenTreeScientificPhylogeny', () => {
  it('builds internal clade topology from OpenTree and isolates unresolved targets', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/v3/tnrs/match_names')) {
        const bodyRaw = typeof init?.body === 'string' ? init.body : '{}';
        const body = JSON.parse(bodyRaw) as { names?: string[] };
        const name = body.names?.[0] ?? '';

        const ottByName: Record<string, number> = {
          'Homo sapiens': 770315,
          'Panthera tigris': 563166
        };

        const ott = ottByName[name];
        if (!ott) {
          return new Response(JSON.stringify({ results: [{ matches: [] }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }

        return new Response(
          JSON.stringify({
            results: [
              {
                matches: [
                  {
                    score: 1,
                    taxon: {
                      ott_id: ott,
                      unique_name: name
                    }
                  }
                ]
              }
            ]
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }

      if (url.includes('/v3/tree_of_life/induced_subtree')) {
        return new Response(
          JSON.stringify({
            newick: '((Homo_sapiens_ott770315,Panthera_tigris_ott563166)Mammalia_ott244265);'
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }

      throw new Error(`Unexpected URL in test fetch mock: ${url}`);
    });

    const cacheDir = await mkdtemp(join(tmpdir(), 'evo-tree-opentree-topology-'));
    const result = await buildOpenTreeScientificPhylogeny(targets, {
      datasetVersion: 'compiled-test-1',
      cacheDir,
      online: true,
      retries: 0,
      timeoutMs: 4000
    });

    expect(result.usedOpenTreeTopology).toBe(true);
    expect(result.resolvedTargetCount).toBe(2);
    expect(result.unresolvedTargetCount).toBe(1);

    const nodes = Object.values(result.scientificPhylogeny.nodesById);
    const internalHydrated = nodes.filter(
      (node) =>
        node.childIds.length > 0 &&
        !node.navigationOnly &&
        node.provenance.some((source) => source.sourceType === 'open-tree')
    );

    expect(internalHydrated.length).toBeGreaterThan(0);

    const unresolvedRoot = result.scientificPhylogeny.nodesById['target-catalog-root'];
    expect(unresolvedRoot?.navigationOnly).toBe(true);

    const human = result.scientificPhylogeny.nodesById['homo-sapiens'];
    expect(human?.taxonId).toBe('ott:770315');
    expect(human?.provenance.some((source) => source.sourceType === 'open-tree')).toBe(true);
  });

  it('throws when OpenTree topology cannot be resolved', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ results: [{ matches: [] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const cacheDir = await mkdtemp(join(tmpdir(), 'evo-tree-opentree-topology-fail-'));

    await expect(
      buildOpenTreeScientificPhylogeny(targets, {
        datasetVersion: 'compiled-test-fail',
        cacheDir,
        online: true,
        retries: 0,
        timeoutMs: 4000
      })
    ).rejects.toThrow('OpenTree topology unavailable');
  });
});