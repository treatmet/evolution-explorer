import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScientificPhylogeny } from '@evo-tree/domain';

import type { TargetSpecies } from '../types';
import { normalizeNodeNames } from '../naming/normalizeNodeNames';
import { resolveNodeLabel } from '@evo-tree/domain';
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

const cacheDirectories: string[] = [];

async function createCacheDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'evo-tree-media-'));
  cacheDirectories.push(path);
  return path;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cacheDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const targets: TargetSpecies[] = [
  {
    id: 'homo-sapiens',
    scientificName: 'Homo sapiens',
    scientificNameNormalized: 'Homo sapiens',
  },
  {
    id: 'panthera-tigris',
    scientificName: 'Panthera tigris',
    scientificNameNormalized: 'Panthera tigris',
  }
];

describe('enrichMediaForScientificTree', () => {
  it.each([
    {
      genus: 'Tyrannosaurus',
      species: 'Tyrannosaurus rex',
      summary: 'Tyrannosaurus is a genus of large theropod dinosaur. The type species Tyrannosaurus rex is one of the best represented theropods.'
    },
    {
      genus: 'Fungia',
      species: 'Fungia fungites',
      summary: 'Fungia is a genus of corals in the family Fungiidae. It is monotypic with the single species Fungia fungites, which grows on Indo-Pacific reefs.'
    }
  ])('retains descriptions and images for $species when its genus shares the article', async ({ genus, species, summary }) => {
    const tree = makeTree();
    const genusNode = tree.nodesById['branch-1']!;
    genusNode.navigationOnly = false;
    genusNode.kind = 'named-taxon';
    genusNode.displayName = genus;
    genusNode.scientificName = genus;
    const endpoint = tree.nodesById['homo-sapiens']!;
    endpoint.displayName = species;
    endpoint.scientificName = species;
    const unsupported = tree.nodesById['panthera-tigris']!;
    unsupported.displayName = `${species}ensis`;
    unsupported.scientificName = `${species}ensis`;
    const selectedTargets: TargetSpecies[] = [
      { id: endpoint.id, scientificName: species, scientificNameNormalized: species },
      { id: unsupported.id, scientificName: unsupported.scientificName, scientificNameNormalized: unsupported.scientificName }
    ];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/page/summary/')) {
        return jsonResponse({
          title: genus,
          extract: summary,
          originalimage: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Shared.jpg' }
        });
      }
      if (url.includes('commons.wikimedia.org')) {
        return jsonResponse({ query: { pages: [{ imageinfo: [{ extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          Artist: { value: 'Test photographer' }
        } }] }] } });
      }
      return jsonResponse({ build: 560, results: [] });
    });
    const cacheDir = await createCacheDirectory();
    const enriched = await enrichMediaForScientificTree(tree, selectedTargets, {
      cacheDir, online: true, retries: 0, descriptionMaxChars: 60
    });
    for (const id of [genusNode.id, endpoint.id]) {
      const hydrated = enriched.tree.nodesById[id]!;
      expect(hydrated.description).toBe(summary.split('. ')[0] + '.');
      expect(hydrated.description!.length).toBeLessThanOrEqual(60);
      expect(hydrated.descriptionSource?.articleTitle).toBe(genus);
      const assetId = enriched.result.media.nodeMediaByNodeId[id]?.primaryAssetId;
      expect(assetId).toBeTruthy();
      expect(enriched.result.media.assetsById[assetId!]?.kind).toBe('representative-image');
    }
    // A name prefix alone must not qualify a different species for the shared article.
    expect(enriched.tree.nodesById[unsupported.id]?.description).toBeUndefined();
    expect(enriched.tree.nodesById[unsupported.id]?.descriptionSource).toBeUndefined();
    expect(enriched.result.media.nodeMediaByNodeId[unsupported.id]).toBeUndefined();
    expect(enriched.result.media.coverage.targets.withDescription).toBe(1);
    expect(enriched.result.media.coverage.targets.withImage).toBe(1);
    expect(enriched.result.warnings.some((warning) => warning.includes(`${species}ensis -> ${genus}`))).toBe(true);

    fetchMock.mockClear();
    const offline = await enrichMediaForScientificTree(tree, selectedTargets, {
      cacheDir, online: false, descriptionMaxChars: 60
    });
    expect(offline.tree.nodesById[endpoint.id]?.description).toBe(enriched.tree.nodesById[endpoint.id]?.description);
    expect(offline.result.media.coverage).toEqual(enriched.result.media.coverage);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hydrates exact-match common names independently of photo licensing and reuses the taxon cache', async () => {
    const tree = makeTree();
    const human = tree.nodesById['homo-sapiens']!;
    delete human.commonName;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.inaturalist.org')) {
        expect(url).toContain('locale=en');
        return jsonResponse({ results: [
          { name: 'Homo', preferred_common_name: 'Wrong genus name' },
          { name: 'Homo sapiens', preferred_common_name: 'human being', default_photo: {
            license_code: 'cc-by-nc', medium_url: 'https://example.org/nc.jpg'
          } }
        ] });
      }
      if (url.includes('/page/summary/')) {
        const title = decodeURIComponent(url.split('/').at(-1)!);
        return jsonResponse({ title, extract: `${title} is a taxon.` });
      }
      return jsonResponse({ build: 560, results: [] });
    });
    const cacheDir = await createCacheDirectory();
    const selectedTargets = targets.slice(0, 1);
    const { tree: hydrated, result } = await enrichMediaForScientificTree(tree, selectedTargets, {
      cacheDir, online: true, retries: 0
    });
    expect(hydrated.nodesById['homo-sapiens']?.commonName).toBe('human being');
    const namedTree = normalizeNodeNames(hydrated, selectedTargets).tree;
    expect(resolveNodeLabel(namedTree.nodesById['homo-sapiens']!)).toBe('Human being');
    expect(hydrated.nodesById['homo-sapiens']?.scientificName).toBe('Homo sapiens');
    expect(Object.values(result.media.assetsById).some((asset) => asset.url === 'https://example.org/nc.jpg')).toBe(false);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('q=Homo%20sapiens'))).toHaveLength(1);

    fetchMock.mockClear();
    const offline = await enrichMediaForScientificTree(tree, selectedTargets, { cacheDir, online: false });
    expect(offline.tree.nodesById['homo-sapiens']?.commonName).toBe('human being');
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
    expect(enrichedTree.nodesById['luca']?.reconstruction).toBeUndefined();
    expect(enrichedTree.nodesById['branch-1']?.reconstruction?.reviewStatus).toBe('generated');
    const reconstructionAssetId = enrichedTree.nodesById['branch-1']?.reconstruction?.assetId;
    expect(reconstructionAssetId).toBeTruthy();
    expect(reconstructionAssetId ? result.media.assetsById[reconstructionAssetId] : undefined).toBeTruthy();
    expect(result.warnings.some((warning) => warning.includes('offline mode'))).toBe(true);
  });

  it('resolves PhyloPic silhouettes from embedded node items using the current build', async () => {
    const tree = makeTree();
    const requestedUrls: string[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url === 'https://api.phylopic.org/') {
        return new Response(JSON.stringify({ build: 560 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }

      if (url.includes('api.phylopic.org/nodes') && url.includes('filter_name=homo%20sapiens')) {
        return new Response(
          JSON.stringify({
            _embedded: {
              items: [
                {
                  _embedded: {
                    primaryImage: {
                      uuid: 'abc-123',
                      attribution: 'Test Artist',
                      _links: {
                        license: { href: 'https://creativecommons.org/licenses/by/3.0/' },
                        rasterFiles: [
                          { href: 'https://images.phylopic.org/images/abc-123/raster/1024x1024.png', sizes: '1024x1024' },
                          { href: 'https://images.phylopic.org/images/abc-123/raster/512x512.png', sizes: '512x512' }
                        ]
                      }
                    }
                  }
                }
              ]
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const { result } = await enrichMediaForScientificTree(tree, targets.slice(0, 1), {
      cacheDir: await createCacheDirectory(),
      online: true,
      maxTargets: 1,
      retries: 0
    });

    const silhouette = Object.values(result.media.assetsById).find((asset) => asset.kind === 'silhouette');
    expect(silhouette?.url).toBe('https://images.phylopic.org/images/abc-123/raster/1024x1024.png');
    expect(silhouette?.thumbnailUrl).toBe('https://images.phylopic.org/images/abc-123/raster/512x512.png');
    expect(silhouette?.attribution.attributionText).toBe('Test Artist');
    expect(silhouette?.attribution.licenseUrl).toBe('https://creativecommons.org/licenses/by/3.0/');
    expect(
      requestedUrls.some((url) => url.includes('build=560') && url.includes('filter_name=homo%20sapiens'))
    ).toBe(true);
  });

  it('uses Wikipedia first and accepts only exact-name, commercial-compatible iNaturalist fallbacks', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('api.inaturalist.org/v1/taxa') && url.includes('q=Homo%20sapiens')) {
        return jsonResponse({
          results: [
            { name: 'Homo', default_photo: { license_code: 'cc0', medium_url: 'https://example.org/genus.jpg' } },
            { name: 'Homo sapiens', default_photo: { license_code: 'cc-by-nc', medium_url: 'https://example.org/noncommercial.jpg' } },
            {
              name: 'Homo sapiens',
              default_photo: {
                license_code: 'cc-by',
                medium_url: 'https://static.inaturalist.org/photos/1/medium.jpg',
                attribution: '(c) Photographer'
              }
            }
          ]
        });
      }

      if (url.includes('api.inaturalist.org/v1/taxa') && url.includes('q=Panthera%20tigris')) {
        return jsonResponse({ results: [] });
      }

      if (url.includes('en.wikipedia.org/api/rest_v1/page/summary/Panthera%20tigris')) {
        return jsonResponse({
          title: 'Tiger',
          extract: 'The tiger is a large cat.',
          originalimage: {
            source: 'https://upload.wikimedia.org/wikipedia/commons/b/b0/Bengal_tiger_%28female%29.jpg'
          }
        });
      }

      if (url.includes('commons.wikimedia.org/w/api.php') && url.includes('Bengal_tiger')) {
        return jsonResponse({
          query: {
            pages: [
              {
                imageinfo: [
                  {
                    extmetadata: {
                      LicenseShortName: { value: 'CC BY-SA 4.0' },
                      LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
                      Artist: { value: '<a href="x">Jane Doe</a>' }
                    }
                  }
                ]
              }
            ]
          }
        });
      }

      return jsonResponse({});
    });

    const { result } = await enrichMediaForScientificTree(makeTree(), targets, {
      cacheDir: await createCacheDirectory(),
      online: true,
      maxTargets: 2,
      retries: 0
    });

    const photos = Object.values(result.media.assetsById);
    const inat = photos.find((asset) => asset.attribution.providerId === 'inaturalist');
    expect(inat?.url).toBe('https://static.inaturalist.org/photos/1/medium.jpg');
    expect(inat?.attribution.licenseCode).toBe('cc-by');

    const wiki = photos.find((asset) => asset.attribution.providerId === 'wikimedia-commons');
    expect(wiki?.url).toBe('https://upload.wikimedia.org/wikipedia/commons/b/b0/Bengal_tiger_%28female%29.jpg');
    expect(wiki?.attribution.licenseCode).toBe('cc-by-sa');
    expect(wiki?.attribution.attributionText).toBe('Jane Doe');
    expect(wiki?.kind).toBe('representative-image');
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
        return new Response(JSON.stringify({ build: 560, _embedded: { items: [] } }), {
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
      cacheDir: await createCacheDirectory(),
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
          ? { build: 560, _embedded: { items: [] } }
          : { results: [] };
      return new Response(JSON.stringify(emptyPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const { tree: enrichedTree } = await enrichMediaForScientificTree(tree, targets, {
      cacheDir: await createCacheDirectory(),
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
          ? { build: 560, _embedded: { items: [] } }
          : { results: [] };
      return new Response(JSON.stringify(emptyPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const progressPhases: string[] = [];
    const cacheDir = await createCacheDirectory();
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

  it('hydrates targets, extinct endpoints and intermediary taxa identically and reuses the article cache offline', async () => {
    const tree = makeTree();
    const internal = tree.nodesById['branch-1']!;
    internal.navigationOnly = false;
    internal.kind = 'named-taxon';
    internal.scientificName = 'Mammalia';
    const human = tree.nodesById['homo-sapiens']!;
    human.description = 'Old authored descriptor must be replaced.';
    tree.nodesById['panthera-tigris']!.extant = false;
    const requests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/page/summary/')) {
        const name = decodeURIComponent(url.split('/').at(-1)!);
        return jsonResponse({
          title: name,
          extract: `${name} is a taxon represented in this tree.`,
          originalimage: { source: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name.replaceAll(' ', '_')}.jpg` },
          thumbnail: { source: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name.replaceAll(' ', '_')}.jpg/320px-image.jpg` }
        });
      }
      if (url.includes('commons.wikimedia.org/w/api.php')) {
        return jsonResponse({ query: { pages: [{ imageinfo: [{ extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 3.0' },
          Artist: { value: '<a href="https://example.org">Photographer &amp; team</a>' }
        } }] }] } });
      }
      return jsonResponse({});
    });
    const cacheDir = await createCacheDirectory();
    const options = { cacheDir, online: true, retries: 0, maxTargets: 1, now: new Date('2026-10-22T12:00:00Z') };
    const first = await enrichMediaForScientificTree(tree, targets, options);
    for (const id of ['homo-sapiens', 'panthera-tigris', 'branch-1']) {
      const node = first.tree.nodesById[id]!;
      expect(node.description).toContain('is a taxon represented in this tree.');
      expect(node.descriptionSource?.licenseCode).toBe('cc-by-sa-4.0');
      const assetId = first.result.media.nodeMediaByNodeId[id]?.primaryAssetId;
      const asset = assetId ? first.result.media.assetsById[assetId] : undefined;
      expect(asset?.kind).toBe('representative-image');
      expect(asset?.attribution.licenseUrl).toBe('https://creativecommons.org/licenses/by-sa/3.0/');
      expect(asset?.attribution.attributionText).toBe('Photographer & team');
      expect(node.reconstruction).toBeUndefined();
    }
    expect(first.result.media.coverage.targets).toMatchObject({ total: 2, withDescription: 2, withImage: 2 });
    expect(first.result.media.coverage.intermediaries).toMatchObject({ total: 2, withDescription: 2, withImage: 2 });
    expect(requests.filter((url) => url.includes('/page/summary/Homo%20sapiens'))).toHaveLength(1);
    expect(requests.some((url) => /phylopic|openverse/.test(url))).toBe(false);
    expect(requests.filter((url) => url.includes('api.inaturalist.org'))).toHaveLength(1);
    expect((await readdir(join(cacheDir, 'external-media', 'wikipedia-summary'))).length).toBeGreaterThan(0);
    expect(tree.nodesById['homo-sapiens']?.description).toBe('Old authored descriptor must be replaced.');

    fetchMock.mockClear();
    const offline = await enrichMediaForScientificTree(tree, targets, { ...options, online: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(offline.result.media.coverage).toEqual(first.result.media.coverage);
    expect(offline.result.media.assetsById).toMatchObject(first.result.media.assetsById);
  });

  it.each(['CC BY-NC 4.0', 'CC BY-ND 4.0', 'Unknown'])('rejects %s Commons images and reports missing coverage', async (license) => {
    const tree = makeTree();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/page/summary/')) {
        const name = decodeURIComponent(url.split('/').at(-1)!);
        return jsonResponse({
          title: name,
          extract: `${name} is a named taxon.`,
          originalimage: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Test.jpg' }
        });
      }
      if (url.includes('commons.wikimedia.org')) {
        return jsonResponse({ query: { pages: [{ imageinfo: [{ extmetadata: {
          LicenseShortName: { value: license }, Artist: { value: 'Artist' }
        } }] }] } });
      }
      return jsonResponse({ build: 560, results: [] });
    });
    const { result } = await enrichMediaForScientificTree(tree, targets, {
      cacheDir: await createCacheDirectory(), online: true, retries: 0
    });
    expect(Object.values(result.media.assetsById).some((asset) => asset.kind !== 'reconstruction')).toBe(false);
    expect(result.media.coverage.targets).toMatchObject({ total: 2, withDescription: 2, withImage: 0 });
    expect(result.media.coverage.targets.missingImageNodeIds).toEqual(['homo-sapiens', 'panthera-tigris']);
    expect(result.warnings.some((warning) => warning.includes('No commercially reusable image'))).toBe(true);
  });

  it('accepts Commons thumbnail-host URLs and preserves jurisdiction-specific license URLs', async () => {
    const image = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Example.jpg/330px-Example.jpg?utm_source=en.wikipedia.org';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/page/summary/')) {
        const name = decodeURIComponent(url.split('/').at(-1)!);
        return jsonResponse({ title: name, extract: `${name} is a taxon.`, thumbnail: { source: image } });
      }
      if (url.includes('commons.wikimedia.org')) {
        expect(url).toContain('File%3AExample.jpg');
        return jsonResponse({ query: { pages: [{ imageinfo: [{ extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 2.0 de' },
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/2.0/de/deed.en' },
          Artist: { value: 'Photographer' }
        } }] }] } });
      }
      return jsonResponse({});
    });
    const { result } = await enrichMediaForScientificTree(makeTree(), targets, {
      cacheDir: await createCacheDirectory(), online: true, retries: 0
    });
    const assetId = result.media.nodeMediaByNodeId['homo-sapiens']?.primaryAssetId;
    const asset = assetId ? result.media.assetsById[assetId] : undefined;
    expect(asset?.url).toBe(image);
    expect(asset?.attribution.licenseUrl).toBe('https://creativecommons.org/licenses/by-sa/2.0/de/deed.en');
    expect(fetchMock.mock.calls.some(([input]) => /phylopic|openverse/.test(String(input)))).toBe(false);
  });

  it('uses only commercial-compatible PhyloPic and Openverse fallbacks for extinct endpoints', async () => {
    const tree = makeTree();
    tree.nodesById['homo-sapiens']!.extant = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://api.phylopic.org/') {
        return jsonResponse({ build: 560 });
      }
      if (url.includes('api.phylopic.org/nodes')) {
        return jsonResponse({ _embedded: { items: [{ _embedded: { primaryImage: {
          _links: {
            license: { href: 'https://creativecommons.org/licenses/by-nc/4.0/' },
            rasterFiles: [{ href: 'https://example.org/noncommercial.png' }]
          }
        } } }] } });
      }
      if (url.includes('api.openverse.engineering')) {
        return jsonResponse({ results: [
          { url: 'https://example.org/nc.jpg', license: 'cc-by-nc' },
          { url: 'https://example.org/unknown.jpg' },
          { url: 'https://example.org/valid.jpg', license: 'cc-by-sa', license_version: '3.0', creator: 'Artist' }
        ] });
      }
      return jsonResponse({});
    });
    const { result } = await enrichMediaForScientificTree(tree, targets, {
      cacheDir: await createCacheDirectory(), online: true, retries: 0
    });
    const assets = Object.values(result.media.assetsById).filter((asset) => asset.kind !== 'reconstruction');
    expect(assets).toHaveLength(1);
    expect(assets[0]?.url).toBe('https://example.org/valid.jpg');
    expect(assets[0]?.attribution.licenseUrl).toBe('https://creativecommons.org/licenses/by-sa/3.0/');
  });

  it('does not apply the former default 180-target hydration cap', async () => {
    const tree = makeTree();
    const template = tree.nodesById['homo-sapiens']!;
    const manyTargets: TargetSpecies[] = Array.from({ length: 181 }, (_, index) => ({
      id: `taxon-${index}`, scientificName: `Taxon ${index}`, scientificNameNormalized: `Taxon ${index}`
    }));
    for (const target of manyTargets) {
      tree.nodesById[target.id] = { ...template, id: target.id, scientificName: target.scientificName };
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { result } = await enrichMediaForScientificTree(tree, manyTargets, {
      cacheDir: await createCacheDirectory(), online: false
    });
    expect(result.media.targetDifficultyMetadata).toHaveLength(181);
    expect(result.media.coverage.targets.total).toBe(181);
    expect(result.warnings.some((warning) => warning.includes('target limit applied'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
