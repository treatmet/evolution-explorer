import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('hydrates selectable internal node descriptions from Wikipedia summaries', async () => {
    const tree = makeTree();
    const internalNode = tree.nodesById['branch-1'];
    if (!internalNode) {
      throw new Error('Expected internal test node.');
    }
    internalNode.displayName = 'Eukaryota';
    internalNode.scientificName = 'Eukaryota';
    internalNode.kind = 'named-taxon';
    internalNode.navigationOnly = false;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('en.wikipedia.org') && url.includes('Eukaryota')) {
        return new Response(
          JSON.stringify({
            type: 'standard',
            pageid: 24536543,
            extract: 'Eukaryotes are organisms whose cells have a membrane-bound nucleus.',
            content_urls: {
              desktop: { page: 'https://en.wikipedia.org/wiki/Eukaryote' }
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.includes('api.inaturalist.org')) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }

      if (url.includes('paleobiodb.org')) {
        return new Response(JSON.stringify({ records: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }

      if (url.includes('api.phylopic.org')) {
        return new Response(JSON.stringify({ _embedded: { images: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const { tree: enrichedTree } = await enrichMediaForScientificTree(tree, targets, {
      cacheDir: await mkdtemp(join(tmpdir(), 'evo-tree-description-')),
      online: true,
      maxTargets: 1,
      retries: 0
    });

    const eukaryota = enrichedTree.nodesById['branch-1'];
    expect(eukaryota?.description).toBe(
      'Eukaryotes are organisms whose cells have a membrane-bound nucleus.'
    );
    expect(
      eukaryota?.provenance.some(
        (source) => source.sourceId === 'wikipedia-page-summary'
      )
    ).toBe(true);
  });

  it('embeds Wikipedia lead-section hyperlinks into description segments', async () => {
    const tree = makeTree();
    const internalNode = tree.nodesById['branch-1'];
    if (!internalNode) {
      throw new Error('Expected internal test node.');
    }
    internalNode.displayName = 'Opisthokont';
    internalNode.scientificName = 'Opisthokont';
    internalNode.kind = 'named-taxon';
    internalNode.navigationOnly = false;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/api/rest_v1/page/summary/')) {
        return new Response(
          JSON.stringify({
            type: 'standard',
            title: 'Opisthokont',
            pageid: 1234,
            extract:
              'The opisthokonts are a broad group of eukaryotes, including both the animal and fungus kingdoms.'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.includes('/w/api.php') && url.includes('action=parse')) {
        return new Response(
          JSON.stringify({
            parse: {
              title: 'Opisthokont',
              text:
                '<p>The <b>opisthokonts</b> are a broad group of ' +
                '<a href="/wiki/Eukaryote" title="Eukaryote">eukaryotes</a>, including both the ' +
                '<a href="/wiki/Animal" title="Animal">animal</a> and ' +
                '<a href="/wiki/Fungus" title="Fungus">fungus</a> kingdoms. ' +
                '<a href="/wiki/File:Example.jpg"><img src="x"/></a></p>'
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      const emptyPayload = url.includes('paleobiodb.org')
        ? { records: [] }
        : url.includes('api.phylopic.org')
          ? { _embedded: { images: [] } }
          : { results: [] };
      return new Response(JSON.stringify(emptyPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const { tree: enrichedTree } = await enrichMediaForScientificTree(tree, targets, {
      cacheDir: await mkdtemp(join(tmpdir(), 'evo-tree-links-')),
      online: true,
      maxTargets: 1,
      retries: 0
    });

    const segments = enrichedTree.nodesById['branch-1']?.descriptionSegments;
    expect(segments).toBeDefined();

    const linked = (segments ?? []).filter((segment) => segment.href);
    expect(linked.map((segment) => segment.text)).toEqual(['eukaryotes', 'animal', 'fungus']);
    expect(linked[0]?.href).toBe('https://en.wikipedia.org/wiki/Eukaryote');
    expect(linked[0]?.articleTitle).toBe('Eukaryote');

    const rebuilt = (segments ?? []).map((segment) => segment.text).join('');
    expect(rebuilt).toBe(enrichedTree.nodesById['branch-1']?.description);
  });

  it('limits descriptions to complete sentences within the configured character count', async () => {
    const tree = makeTree();
    const internalNode = tree.nodesById['branch-1'];
    if (!internalNode) {
      throw new Error('Expected internal test node.');
    }
    internalNode.displayName = 'Bacteria';
    internalNode.scientificName = 'Bacteria';
    internalNode.kind = 'named-taxon';
    internalNode.navigationOnly = false;

    const bacteriaSummary =
      "Bacteria are ubiquitous, mostly free-living organisms often consisting of one biological cell. They constitute a large domain of prokaryotic microorganisms. Typically a few micrometres in length, bacteria were among the first life forms to appear on Earth, and are present in most of its habitats. Bacteria inhabit the air, soil, water, acidic hot springs, radioactive waste, and the deep biosphere of Earth's crust. Bacteria play a vital role in many stages of the nutrient cycle by recycling nutrients and the fixation of nitrogen from the atmosphere. The study of bacteria is known as bacteriology, a branch of microbiology.";

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('en.wikipedia.org') && url.includes('Bacteria')) {
        return new Response(
          JSON.stringify({
            type: 'standard',
            pageid: 4260,
            extract: bacteriaSummary
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      const emptyPayload = url.includes('paleobiodb.org')
        ? { records: [] }
        : url.includes('api.phylopic.org')
          ? { _embedded: { images: [] } }
          : { results: [] };
      return new Response(JSON.stringify(emptyPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const progressPhases: string[] = [];
    const cacheDir = await mkdtemp(join(tmpdir(), 'evo-tree-description-limit-'));
    const { tree: enrichedTree } = await enrichMediaForScientificTree(tree, targets, {
      cacheDir,
      online: true,
      maxTargets: 1,
      retries: 0,
      descriptionMaxChars: 500,
      onProgress: ({ phase }) => progressPhases.push(phase)
    });

    const description = enrichedTree.nodesById['branch-1']?.description;
    expect(description).toBeTruthy();
    expect(description?.length).toBeLessThanOrEqual(500);
    expect(description).toMatch(/[.!?]$/);
    expect(bacteriaSummary.startsWith(description ?? '')).toBe(true);
    expect(description).not.toContain('The study of bacteria');
    expect(progressPhases).toContain('node-descriptions');
  });
});
