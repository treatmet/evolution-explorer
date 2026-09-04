import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCatalogScientificPhylogeny } from './buildCatalogScientificPhylogeny';

import { runSourceRefresh } from './refreshPipeline';
import type { DatasetArtifact, RefreshPaths } from './types';

interface SourceRow {
  scientificName: string;
  commonName: string;
  briefDescriptor: string;
}

function installTopologyAndMediaFetchMock(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/v3/tnrs/match_names')) {
      const bodyRaw = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(bodyRaw) as { names?: string[] };
      const name = body.names?.[0] ?? '';

      const ottByName: Record<string, number> = {
        'Homo sapiens': 770315,
        'Panthera tigris': 563166,
        'Panthera leo': 563165
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
      const bodyRaw = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(bodyRaw) as { ott_ids?: number[] };
      const ottIds = body.ott_ids ?? [];
      const leaves = ottIds.map((id, index) => `Leaf_${index + 1}_ott${id}`);
      const newick = leaves.length > 1 ? `(${leaves.join(',')})Clade_ott304358;` : `${leaves[0]};`;

      return new Response(JSON.stringify({ newick }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (url.includes('api.gbif.org')) {
      return new Response(JSON.stringify({}), {
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

    if (url.includes('api.inaturalist.org')) {
      return new Response(JSON.stringify({ results: [] }), {
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

    if (url.includes('api.openverse.engineering')) {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (url.includes('en.wikipedia.org/api/rest_v1/page/summary/')) {
      return new Response(
        JSON.stringify({
          type: 'standard',
          title: 'Test clade',
          pageid: 99,
          extract: 'A test clade description referencing a clade.'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.includes('en.wikipedia.org/w/api.php')) {
      return new Response(
        JSON.stringify({
          parse: {
            title: 'Test clade',
            text: '<p>A test clade description referencing a <a href="/wiki/Clade" title="Clade">clade</a>.</p>'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    throw new Error(`Unexpected URL in test fetch mock: ${url}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function createRefreshPaths(): Promise<RefreshPaths> {
  const root = await mkdtemp(join(tmpdir(), 'evo-tree-refresh-'));

  const sourceDir = join(root, 'data', 'source');
  const cacheDir = join(root, 'data', 'cache');
  const candidateDir = join(root, 'data', 'candidate');
  const approvedDir = join(root, 'data', 'approved');

  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(candidateDir, { recursive: true }),
    mkdir(approvedDir, { recursive: true })
  ]);

  return {
    sourceSpeciesListPath: join(sourceDir, 'species-list.txt'),
    cacheDir,
    candidateDir,
    approvedDir
  };
}

async function writeSpeciesList(filePath: string, rows: SourceRow[]): Promise<void> {
  const content = [
    'Scientific name | Common name | Brief descriptor',
    ...rows.map((row) => `${row.scientificName} | ${row.commonName} | ${row.briefDescriptor}`)
  ].join('\n');

  await writeFile(filePath, content, 'utf8');
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

describe('runSourceRefresh', () => {
  it('writes cache snapshot, diagnostics, and approved runtime artifact in one refresh run', async () => {
    installTopologyAndMediaFetchMock();

    const paths = await createRefreshPaths();

    await writeSpeciesList(paths.sourceSpeciesListPath, [
      {
        scientificName: 'Panthera tigris',
        commonName: 'Tiger',
        briefDescriptor: 'Large striped cat'
      },
      {
        scientificName: 'Homo sapiens',
        commonName: 'Human',
        briefDescriptor: 'Modern human lineage'
      }
    ]);

    const result = await runSourceRefresh(paths, {
      now: new Date('2026-08-28T08:00:00.000Z'),
      mediaOnline: true
    });

    expect(result.summary.sourceCount).toBe(2);
    expect(result.summary.promotedToApproved).toBe(true);
    expect(result.summary.media.online).toBe(true);
    expect(result.summary.media.reconstructionQueueCount).toBeGreaterThan(0);

    const candidate = await readJson<DatasetArtifact>(result.summary.candidateArtifactPath);
    expect(candidate.manifest.validationStatus).toBe('candidate');
    expect(candidate.manifest.datasetVersion).toBe(result.summary.candidateVersion);
    expect(candidate.scientificPhylogeny.rootId).toBe('luca');
    expect(candidate.manifest.nodeCount).toBe(
      Object.keys(candidate.scientificPhylogeny.nodesById).length
    );
    expect(candidate.manifest.nodeCount).toBeGreaterThan(candidate.targets.length);
    expect(candidate.mediaEnrichment?.targetDifficultyMetadata.length).toBe(2);
    expect(candidate.mediaEnrichment?.reconstructionQueue.length).toBeGreaterThan(0);
    expect(candidate.mediaEnrichment?.reconstructionQueue[0]?.status).toBe('generated');

    const report = await readFile(result.summary.diffReportPath, 'utf8');
    expect(report).toContain('Added targets: 2');

    const approvedLatest = await readJson<{
      datasetVersion: string;
      fileName: string;
    }>(join(paths.approvedDir, 'latest.json'));

    const promoted = await readJson<DatasetArtifact>(join(paths.approvedDir, approvedLatest.fileName));
    expect(promoted.manifest.validationStatus).toBe('approved');
  });

  it('diffs against approved baseline and always updates approved artifacts', async () => {
    installTopologyAndMediaFetchMock();

    const paths = await createRefreshPaths();

    const baselineApproved: DatasetArtifact = {
      manifest: {
        datasetVersion: '2026.08.27.1',
        generatedAt: '2026-08-27T08:00:00.000Z',
        sourceSnapshots: [],
        speciesCount: 2,
        nodeCount: 4,
        validationStatus: 'approved'
      },
      scientificPhylogeny: buildCatalogScientificPhylogeny(
        [
          {
            id: 'panthera-tigris',
            scientificName: 'Panthera tigris',
            scientificNameNormalized: 'Panthera tigris',
            commonName: 'Tiger',
            briefDescriptor: 'Largest living cat'
          },
          {
            id: 'panthera-leo',
            scientificName: 'Panthera leo',
            scientificNameNormalized: 'Panthera leo',
            commonName: 'Lion',
            briefDescriptor: 'Social big cat'
          }
        ],
        {
          datasetVersion: 'compiled-2026.08.27.1'
        }
      ),
      targets: [
        {
          id: 'panthera-tigris',
          scientificName: 'Panthera tigris',
          scientificNameNormalized: 'Panthera tigris',
          commonName: 'Tiger',
          briefDescriptor: 'Largest living cat'
        },
        {
          id: 'panthera-leo',
          scientificName: 'Panthera leo',
          scientificNameNormalized: 'Panthera leo',
          commonName: 'Lion',
          briefDescriptor: 'Social big cat'
        }
      ]
    };

    await writeFile(
      join(paths.approvedDir, 'dataset-2026.08.27.1.json'),
      JSON.stringify(baselineApproved, null, 2),
      'utf8'
    );

    await writeFile(
      join(paths.approvedDir, 'latest.json'),
      JSON.stringify(
        {
          datasetVersion: '2026.08.27.1',
          fileName: 'dataset-2026.08.27.1.json',
          generatedAt: '2026-08-27T08:00:00.000Z'
        },
        null,
        2
      ),
      'utf8'
    );

    await writeSpeciesList(paths.sourceSpeciesListPath, [
      {
        scientificName: 'Panthera tigris',
        commonName: 'Tiger',
        briefDescriptor: 'Striped apex predator'
      },
      {
        scientificName: 'Homo sapiens',
        commonName: 'Human',
        briefDescriptor: 'Modern human lineage'
      }
    ]);

    const result = await runSourceRefresh(
      paths,
      {
        now: new Date('2026-08-28T09:15:00.000Z'),
        mediaOnline: true
      }
    );

    expect(result.summary.diff.added).toBe(1);
    expect(result.summary.diff.removed).toBe(1);
    expect(result.summary.diff.changed).toBe(1);
    expect(result.summary.promotedToApproved).toBe(true);
    expect(result.summary.approvedArtifactPath).toBeTruthy();
    expect(result.summary.media.reconstructionQueueCount).toBeGreaterThan(0);

    const approvedLatest = await readJson<{
      datasetVersion: string;
      fileName: string;
    }>(join(paths.approvedDir, 'latest.json'));

    expect(approvedLatest.datasetVersion).toBe(result.summary.candidateVersion);

    const promoted = await readJson<DatasetArtifact>(join(paths.approvedDir, approvedLatest.fileName));
    expect(promoted.manifest.validationStatus).toBe('approved');
    expect(promoted.targets.length).toBe(2);
    expect(promoted.scientificPhylogeny.rootId).toBe('luca');
    expect(promoted.mediaEnrichment?.targetDifficultyMetadata.length).toBe(2);
  });
});
