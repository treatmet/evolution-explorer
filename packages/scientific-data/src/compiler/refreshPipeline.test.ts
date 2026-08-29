import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCatalogScientificPhylogeny } from './buildCatalogScientificPhylogeny';

import { runSourceRefresh } from './refreshPipeline';
import type { DatasetArtifact, RefreshPaths } from './types';

interface SourceRow {
  scientificName: string;
  commonName: string;
  briefDescriptor: string;
}

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
  it('writes cache snapshot, candidate artifact, and report without mutating approved by default', async () => {
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
      now: new Date('2026-08-28T08:00:00.000Z')
    });

    expect(result.summary.sourceCount).toBe(2);
    expect(result.summary.promotedToApproved).toBe(false);
    expect(result.summary.media.online).toBe(false);
    expect(result.summary.media.reconstructionQueueCount).toBeGreaterThan(0);

    const candidate = await readJson<DatasetArtifact>(result.summary.candidateArtifactPath);
    expect(candidate.manifest.validationStatus).toBe('candidate');
    expect(candidate.manifest.datasetVersion).toBe(result.summary.candidateVersion);
    expect(candidate.scientificPhylogeny.rootId).toBe('luca');
    expect(candidate.manifest.nodeCount).toBe(
      Object.keys(candidate.scientificPhylogeny.nodesById).length
    );
    expect(candidate.manifest.nodeCount).toBeGreaterThan(candidate.targets.length);
    expect(candidate.scientificPhylogeny.nodesById['target-catalog-root']?.navigationOnly).toBe(
      true
    );
    expect(candidate.mediaEnrichment?.targetDifficultyMetadata.length).toBe(2);
    expect(candidate.mediaEnrichment?.reconstructionQueue.length).toBeGreaterThan(0);

    const report = await readFile(result.summary.diffReportPath, 'utf8');
    expect(report).toContain('Added targets: 2');

    await expect(readFile(join(paths.approvedDir, 'latest.json'), 'utf8')).rejects.toThrow();
  });

  it('diffs against approved baseline and promotes when requested', async () => {
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
        promoteToApproved: true
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
    expect(promoted.scientificPhylogeny.nodesById['target-catalog-root']?.navigationOnly).toBe(
      true
    );
    expect(promoted.mediaEnrichment?.targetDifficultyMetadata.length).toBe(2);
  });
});
