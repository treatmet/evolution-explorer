import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

import type { TargetSpecies } from '../types';
import { TxtSpeciesListAdapter, type TargetSourceAdapter } from './adapters';
import { enrichMediaForScientificTree } from '../media/enrichMedia';
import type { MediaEnrichmentOptions } from '../media/types';
import { buildOpenTreeScientificPhylogeny } from './buildOpenTreeScientificPhylogeny';
import { pruneLowConfidenceUnaryNodes } from './pruneLowConfidenceUnaryNodes';
import type {
  DatasetArtifact,
  DatasetDiff,
  RefreshOptions,
  RefreshPaths,
  RefreshResult,
  SourceSnapshot
} from './types';

interface LatestPointer {
  datasetVersion: string;
  fileName: string;
  generatedAt: string;
}

export async function runSourceRefresh(
  paths: RefreshPaths,
  options: RefreshOptions = {},
  adapter?: TargetSourceAdapter
): Promise<RefreshResult> {
  const now = options.now ?? new Date();
  const effectiveAdapter = adapter ?? new TxtSpeciesListAdapter(paths.sourceSpeciesListPath);

  await Promise.all([
    mkdir(paths.cacheDir, { recursive: true }),
    mkdir(paths.candidateDir, { recursive: true }),
    mkdir(paths.approvedDir, { recursive: true })
  ]);

  const targets = await effectiveAdapter.loadTargets();
  if (targets.length === 0) {
    throw new Error('Source compiler cannot build a dataset from zero targets.');
  }

  const generatedAt = now.toISOString();
  const datasetVersion = await nextDatasetVersion(now, [paths.candidateDir, paths.approvedDir]);
  const progressEnabled = options.progress ?? false;
  const progressIntervalPercent = Math.max(1, options.progressIntervalPercent ?? 5);

  const snapshot = await writeSourceSnapshot(paths.cacheDir, effectiveAdapter, targets, generatedAt);
  const baselineApproved = await readLatestArtifact(paths.approvedDir);
  const topologyOptions = {
    datasetVersion: `compiled-${datasetVersion}`,
    cacheDir: paths.cacheDir,
    online: options.mediaOnline ?? false,
    ...(options.mediaTimeoutMs !== undefined ? { timeoutMs: options.mediaTimeoutMs } : {}),
    ...(options.mediaRetries !== undefined ? { retries: options.mediaRetries } : {}),
    ...(options.mediaUserAgent ? { userAgent: options.mediaUserAgent } : {})
  };
  const topologyResult = await buildOpenTreeScientificPhylogeny(targets, topologyOptions);
  const pruneResult = pruneLowConfidenceUnaryNodes(topologyResult.scientificPhylogeny);
  const compiledScientificPhylogeny = pruneResult.tree;

  const mediaOptions: Partial<MediaEnrichmentOptions> & Pick<MediaEnrichmentOptions, 'cacheDir'> = {
    cacheDir: paths.cacheDir,
    online: options.mediaOnline ?? false,
    maxTargets: options.mediaTargetLimit ?? targets.length,
    ...(options.mediaTimeoutMs !== undefined ? { timeoutMs: options.mediaTimeoutMs } : {}),
    ...(options.mediaRetries !== undefined ? { retries: options.mediaRetries } : {}),
    ...(options.mediaUserAgent ? { userAgent: options.mediaUserAgent } : {}),
    ...(progressEnabled
      ? {
          onProgress: ({ processedTargets, totalTargets, percent }) => {
            console.log(
              `[data:refresh] media enrichment ${percent}% (${processedTargets}/${totalTargets})`
            );
          }
        }
      : {}),
    ...(options.progressIntervalPercent !== undefined
      ? { progressIntervalPercent: progressIntervalPercent }
      : {}),
    now
  };

  const mediaEnrichment = await enrichMediaForScientificTree(
    compiledScientificPhylogeny,
    targets,
    mediaOptions
  );

  const scientificPhylogeny = mediaEnrichment.tree;

  const candidate: DatasetArtifact = {
    manifest: {
      datasetVersion,
      generatedAt,
      sourceSnapshots: [snapshot],
      speciesCount: targets.length,
      nodeCount: Object.keys(scientificPhylogeny.nodesById).length,
      validationStatus: 'candidate'
    },
    scientificPhylogeny,
    targets,
    mediaEnrichment: mediaEnrichment.result.media
  };

  const candidateFileName = `dataset-${datasetVersion}.json`;
  const candidateArtifactPath = join(paths.candidateDir, candidateFileName);
  await writeJson(candidateArtifactPath, candidate);

  await writeJson(join(paths.candidateDir, 'latest.json'), {
    datasetVersion,
    fileName: candidateFileName,
    generatedAt
  } satisfies LatestPointer);

  const diff = computeDatasetDiff(baselineApproved?.targets ?? [], candidate.targets);

  const diffJsonPath = join(paths.candidateDir, `diff-${datasetVersion}.json`);
  await writeJson(diffJsonPath, diff);

  const diffReportPath = join(paths.candidateDir, `report-${datasetVersion}.md`);
  await writeFile(
    diffReportPath,
    buildDiffReportMarkdown(datasetVersion, generatedAt, diff, baselineApproved),
    'utf8'
  );

  const approvedFileName = `dataset-${datasetVersion}.json`;
  const approvedArtifactPath = join(paths.approvedDir, approvedFileName);

  const approvedArtifact: DatasetArtifact = {
    ...candidate,
    manifest: {
      ...candidate.manifest,
      validationStatus: 'approved'
    }
  };

  await writeJson(approvedArtifactPath, approvedArtifact);

  await writeJson(join(paths.approvedDir, 'latest.json'), {
    datasetVersion,
    fileName: approvedFileName,
    generatedAt
  } satisfies LatestPointer);

  return {
    summary: {
      sourceCount: targets.length,
      candidateVersion: datasetVersion,
      generatedAt,
      cacheSnapshotPath: snapshot.cachePath,
      candidateArtifactPath,
      diffReportPath,
      diff: {
        added: diff.addedTargetIds.length,
        removed: diff.removedTargetIds.length,
        changed: diff.changedTargetIds.length,
        unchanged: diff.unchangedTargetIds.length
      },
      media: {
        online: options.mediaOnline ?? false,
        assetCount: Object.keys(mediaEnrichment.result.media.assetsById).length,
        nodesWithMedia: Object.keys(mediaEnrichment.result.media.nodeMediaByNodeId).length,
        reconstructionQueueCount: mediaEnrichment.result.media.reconstructionQueue.length,
        providerRequestCount: mediaEnrichment.result.media.providerSnapshots.reduce(
          (sum, provider) => sum + provider.requests,
          0
        ),
        providerFailureCount: mediaEnrichment.result.media.providerSnapshots.reduce(
          (sum, provider) => sum + provider.failures,
          0
        )
      },
      promotedToApproved: true,
      approvedArtifactPath,
      warnings: [
        `Scientific phylogeny compiled from OpenTree induced subtree for ${topologyResult.resolvedTargetCount} target placements.`,
        `Targets unresolved in OpenTree placement: ${topologyResult.unresolvedTargetCount}.`,
        pruneResult.prunedNodeCount > 0
          ? `Pruned ${pruneResult.prunedNodeCount} unary low-confidence/navigation internal nodes before artifact publication.`
          : 'No unary low-confidence/navigation internal nodes required pruning.',
        'External media/taxonomy enrichment runs with cache-first provider adapters and provenance capture.',
        ...topologyResult.warnings,
        ...mediaEnrichment.result.warnings
      ]
    },
    candidate,
    baselineApproved,
    diff
  };
}

export function computeDatasetDiff(
  previousTargets: ReadonlyArray<TargetSpecies>,
  nextTargets: ReadonlyArray<TargetSpecies>
): DatasetDiff {
  const previousById = toTargetMap(previousTargets);
  const nextById = toTargetMap(nextTargets);

  const addedTargetIds = [...nextById.keys()].filter((id) => !previousById.has(id));
  const removedTargetIds = [...previousById.keys()].filter((id) => !nextById.has(id));
  const changedTargetIds: string[] = [];
  const unchangedTargetIds: string[] = [];

  for (const [id, next] of nextById.entries()) {
    const previous = previousById.get(id);
    if (!previous) {
      continue;
    }

    if (isTargetEquivalent(previous, next)) {
      unchangedTargetIds.push(id);
    } else {
      changedTargetIds.push(id);
    }
  }

  return {
    addedTargetIds: addedTargetIds.sort(),
    removedTargetIds: removedTargetIds.sort(),
    changedTargetIds: changedTargetIds.sort(),
    unchangedTargetIds: unchangedTargetIds.sort()
  };
}

function toTargetMap(targets: ReadonlyArray<TargetSpecies>): Map<string, TargetSpecies> {
  const map = new Map<string, TargetSpecies>();
  for (const target of targets) {
    map.set(target.id, target);
  }
  return map;
}

function isTargetEquivalent(a: TargetSpecies, b: TargetSpecies): boolean {
  return (
    a.id === b.id &&
    a.scientificName === b.scientificName &&
    a.scientificNameNormalized === b.scientificNameNormalized &&
    a.commonName === b.commonName &&
    a.briefDescriptor === b.briefDescriptor
  );
}

async function writeSourceSnapshot(
  cacheDir: string,
  adapter: TargetSourceAdapter,
  targets: ReadonlyArray<TargetSpecies>,
  fetchedAtIso: string
): Promise<SourceSnapshot> {
  const contentHash = hashTargets(targets);
  const fileName = `${adapter.sourceId}-${fetchedAtIso.replace(/[:.]/g, '-')}-${contentHash.slice(0, 12)}.json`;
  const cachePath = join(cacheDir, fileName);

  await writeJson(cachePath, {
    sourceId: adapter.sourceId,
    sourceType: adapter.sourceType,
    sourcePath: adapter.sourcePath,
    fetchedAtIso,
    recordCount: targets.length,
    contentHash,
    targets
  });

  return {
    sourceId: adapter.sourceId,
    sourceType: adapter.sourceType,
    sourcePath: adapter.sourcePath,
    cachePath,
    fetchedAtIso,
    recordCount: targets.length,
    contentHash
  };
}

function hashTargets(targets: ReadonlyArray<TargetSpecies>): string {
  return createHash('sha256').update(JSON.stringify(targets)).digest('hex');
}

async function nextDatasetVersion(now: Date, dirs: string[]): Promise<string> {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '.');
  const seen = new Set<number>();

  for (const dir of dirs) {
    const entries = await safeReadDir(dir);
    for (const entry of entries) {
      const matched = /^dataset-(\d{4}\.\d{2}\.\d{2})\.(\d+)\.json$/.exec(entry);
      if (!matched) {
        continue;
      }

      if (matched[1] !== day) {
        continue;
      }

      const seq = Number(matched[2]);
      if (Number.isFinite(seq) && seq > 0) {
        seen.add(seq);
      }
    }
  }

  const nextSeq = seen.size === 0 ? 1 : Math.max(...seen) + 1;
  return `${day}.${nextSeq}`;
}

async function readLatestArtifact(dir: string): Promise<DatasetArtifact | null> {
  const latestPath = join(dir, 'latest.json');

  try {
    const raw = await readFile(latestPath, 'utf8');
    const pointer = JSON.parse(raw) as LatestPointer;
    const artifactPath = resolve(dir, pointer.fileName);
    const artifactRaw = await readFile(artifactPath, 'utf8');
    return JSON.parse(artifactRaw) as DatasetArtifact;
  } catch {
    const entries = await safeReadDir(dir);
    const datasetFile = entries
      .filter((entry) => /^dataset-\d{4}\.\d{2}\.\d{2}\.\d+\.json$/.test(entry))
      .sort()
      .at(-1);

    if (!datasetFile) {
      return null;
    }

    try {
      const artifactRaw = await readFile(join(dir, datasetFile), 'utf8');
      return JSON.parse(artifactRaw) as DatasetArtifact;
    } catch {
      return null;
    }
  }
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

function buildDiffReportMarkdown(
  datasetVersion: string,
  generatedAt: string,
  diff: DatasetDiff,
  baselineApproved: DatasetArtifact | null
): string {
  const baselineVersion = baselineApproved?.manifest.datasetVersion ?? 'none';

  return [
    '# Scientific Data Refresh Report',
    '',
    `- Generated at: ${generatedAt}`,
    `- Candidate dataset version: ${datasetVersion}`,
    `- Baseline approved dataset: ${baselineVersion}`,
    '',
    '## Diff Summary',
    '',
    `- Added targets: ${diff.addedTargetIds.length}`,
    `- Removed targets: ${diff.removedTargetIds.length}`,
    `- Changed targets: ${diff.changedTargetIds.length}`,
    `- Unchanged targets: ${diff.unchangedTargetIds.length}`,
    '',
    '## Added Target IDs',
    '',
    ...toList(diff.addedTargetIds),
    '',
    '## Removed Target IDs',
    '',
    ...toList(diff.removedTargetIds),
    '',
    '## Changed Target IDs',
    '',
    ...toList(diff.changedTargetIds),
    ''
  ].join('\n');
}

function toList(values: ReadonlyArray<string>): string[] {
  if (values.length === 0) {
    return ['- (none)'];
  }

  return values.map((value) => `- ${value}`);
}

export function candidateFileNameFromPath(candidateArtifactPath: string): string {
  return basename(candidateArtifactPath);
}
