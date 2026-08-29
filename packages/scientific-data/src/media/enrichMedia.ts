import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PhyloNode, ScientificPhylogeny, SourceReference, TargetDifficultyMetadata } from '@evo-tree/domain';

import type { TargetSpecies } from '../types';
import type {
  MediaAssetRecord,
  MediaCandidate,
  MediaEnrichmentOptions,
  MediaEnrichmentProgress,
  MediaEnrichmentResult,
  NodeMediaRecord,
  ProviderSnapshot,
  ReconstructionQueueEntry,
  TaxonomyMatch
} from './types';

const DEFAULT_MAX_TARGETS = 180;
const DEFAULT_TIMEOUT_MS = 9000;
const DEFAULT_RETRIES = 2;
const RECONSTRUCTION_PROMPT_VERSION = 'm6.1';
const RECONSTRUCTION_GENERATION_MODEL = 'queued-manifest';

export async function enrichMediaForScientificTree(
  scientificTree: ScientificPhylogeny,
  targets: ReadonlyArray<TargetSpecies>,
  options: Partial<MediaEnrichmentOptions> & Pick<MediaEnrichmentOptions, 'cacheDir'>
): Promise<{ tree: ScientificPhylogeny; result: MediaEnrichmentResult }> {
  const maxTargets = Math.max(1, options.maxTargets ?? DEFAULT_MAX_TARGETS);
  const online = options.online ?? false;
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();

  const workingTree = cloneTree(scientificTree);
  const assetsById: Record<string, MediaAssetRecord> = {};
  const nodeMediaByNodeId: Record<string, NodeMediaRecord> = {};
  const reconstructionQueue: ReconstructionQueueEntry[] = [];
  const warnings: string[] = [];

  const providerStats = createProviderStats([
    'gbif',
    'open-tree',
    'paleobiodb',
    'inaturalist',
    'phylopic',
    'openverse'
  ]);

  const targetLimit = Math.min(maxTargets, targets.length);
  const selectedTargets = targets.slice(0, targetLimit);
  const progressIntervalPercent = Math.max(
    1,
    Math.min(25, Math.round(options.progressIntervalPercent ?? 5))
  );
  let nextProgressReportAtPercent = 0;

  const emitProgress = (processedTargets: number): void => {
    if (!options.onProgress || selectedTargets.length === 0) {
      return;
    }

    const percent = Math.floor((processedTargets / selectedTargets.length) * 100);
    if (processedTargets < selectedTargets.length && percent < nextProgressReportAtPercent) {
      return;
    }

    const update: MediaEnrichmentProgress = {
      processedTargets,
      totalTargets: selectedTargets.length,
      percent
    };
    options.onProgress(update);

    while (nextProgressReportAtPercent <= percent) {
      nextProgressReportAtPercent += progressIntervalPercent;
    }
  };

  if (targetLimit < targets.length) {
    warnings.push(
      `Media enrichment target limit applied: enriched ${targetLimit} of ${targets.length} targets. Use --media-target-limit to raise.`
    );
  }

  const taxonomyMetadata: TargetDifficultyMetadata[] = [];

  emitProgress(0);

  for (let targetIndex = 0; targetIndex < selectedTargets.length; targetIndex += 1) {
    const target = selectedTargets[targetIndex];
    if (!target) {
      continue;
    }

    const node = workingTree.nodesById[target.id];
    if (!node) {
      warnings.push(`Target ${target.id} missing from scientific tree; skipped media enrichment.`);
      emitProgress(targetIndex + 1);
      continue;
    }

    const taxonomy = await resolveTaxonomy(target, {
      cacheDir: options.cacheDir,
      online,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retries: options.retries ?? DEFAULT_RETRIES,
      userAgent: options.userAgent,
      providerStats
    });

    applyTaxonomyToNode(node, taxonomy, target);
    taxonomyMetadata.push({
      speciesId: target.id,
      familiarityScore: estimateFamiliarityFromDescriptor(target)
    });

    const mediaCandidates = await resolveMediaCandidates(node, target, {
      cacheDir: options.cacheDir,
      online,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retries: options.retries ?? DEFAULT_RETRIES,
      userAgent: options.userAgent,
      providerStats
    });

    const nodeMedia: NodeMediaRecord = {
      nodeId: node.id,
      primaryAssetId: null,
      assetIds: []
    };

    for (const candidate of mediaCandidates) {
      const assetId = buildAssetId(node.id, candidate.kind, candidate.url);
      if (assetsById[assetId]) {
        nodeMedia.assetIds.push(assetId);
        if (!nodeMedia.primaryAssetId) {
          nodeMedia.primaryAssetId = assetId;
        }
        continue;
      }

      assetsById[assetId] = {
        assetId,
        nodeId: node.id,
        kind: candidate.kind,
        url: candidate.url,
        thumbnailUrl: candidate.thumbnailUrl,
        title: candidate.title,
        confidence: candidate.confidence,
        retrievedAt: generatedAt,
        attribution: candidate.attribution,
        provenance: candidate.provenance
      };

      nodeMedia.assetIds.push(assetId);
      if (!nodeMedia.primaryAssetId) {
        nodeMedia.primaryAssetId = assetId;
      }
    }

    if (nodeMedia.assetIds.length > 0) {
      nodeMediaByNodeId[node.id] = nodeMedia;
    }

    emitProgress(targetIndex + 1);
  }

  for (const node of Object.values(workingTree.nodesById)) {
    if (node.childIds.length === 0) {
      continue;
    }

    const queueEntry = buildReconstructionQueueEntry(node, workingTree, generatedAt);
    reconstructionQueue.push(queueEntry);

    if (!node.reconstruction) {
      node.reconstruction = {
        assetId: `reconstruction-${node.id}`,
        url: `pending://reconstruction/${node.id}`,
        generationModel: RECONSTRUCTION_GENERATION_MODEL,
        prompt: queueEntry.prompt,
        promptVersion: queueEntry.promptVersion,
        reviewStatus: 'pending-review',
        scientificConfidence: node.navigationOnly ? 'speculative' : 'low',
        evidenceBasis: queueEntry.evidenceBasis,
        sourceNodeIds: [node.id],
        createdAt: generatedAt
      };
    }
  }

  const providerSnapshots = Object.values(providerStats).map((entry) => ({
    providerId: entry.providerId,
    requests: entry.requests,
    cacheHits: entry.cacheHits,
    successes: entry.successes,
    failures: entry.failures,
    notes: [...entry.notes]
  } satisfies ProviderSnapshot));

  if (!online) {
    warnings.push('Media enrichment ran in offline mode; only cached external lookups were used.');
  }

  return {
    tree: {
      ...workingTree,
      datasetVersion: `${scientificTree.datasetVersion}+media`
    },
    result: {
      media: {
        generatedAt,
        providerSnapshots,
        assetsById,
        nodeMediaByNodeId,
        reconstructionQueue,
        targetDifficultyMetadata: taxonomyMetadata
      },
      warnings
    }
  };
}

interface ProviderStatMutable {
  providerId: string;
  requests: number;
  cacheHits: number;
  successes: number;
  failures: number;
  notes: Set<string>;
}

function createProviderStats(providerIds: string[]): Record<string, ProviderStatMutable> {
  return Object.fromEntries(
    providerIds.map((providerId) => [
      providerId,
      {
        providerId,
        requests: 0,
        cacheHits: 0,
        successes: 0,
        failures: 0,
        notes: new Set<string>()
      }
    ])
  );
}

interface ExternalLookupOptions {
  cacheDir: string;
  online: boolean;
  timeoutMs: number;
  retries: number;
  userAgent?: string | undefined;
  providerStats: Record<string, ProviderStatMutable>;
}

async function resolveTaxonomy(
  target: TargetSpecies,
  options: ExternalLookupOptions
): Promise<TaxonomyMatch> {
  const [gbif, openTree, paleoBioDb] = await Promise.all([
    lookupGbif(target.scientificName, options),
    lookupOpenTree(target.scientificName, options),
    lookupPaleoBioDb(target.scientificName, options)
  ]);

  const provenance: SourceReference[] = [];
  if (gbif?.provenance) {
    provenance.push(gbif.provenance);
  }
  if (openTree?.provenance) {
    provenance.push(openTree.provenance);
  }
  if (paleoBioDb?.provenance) {
    provenance.push(paleoBioDb.provenance);
  }

  return {
    canonicalName: gbif?.canonicalName ?? openTree?.canonicalName,
    rank: gbif?.rank,
    taxonId:
      gbif?.usageKey !== undefined
        ? `gbif:${gbif.usageKey}`
        : openTree?.ottId !== undefined
          ? `ott:${openTree.ottId}`
          : undefined,
    openTreeOttId: openTree?.ottId,
    gbifUsageKey: gbif?.usageKey,
    likelyExtinct: paleoBioDb?.likelyExtinct,
    extinctionAgeMa: paleoBioDb?.extinctionAgeMa,
    provenance
  };
}

interface GbifMatch {
  usageKey?: number | undefined;
  canonicalName?: string | undefined;
  rank?: string | undefined;
  confidence?: number | undefined;
  provenance: SourceReference;
}

interface OpenTreeMatch {
  ottId?: number | undefined;
  canonicalName?: string | undefined;
  score?: number | undefined;
  provenance: SourceReference;
}

interface PaleoBioDbMatch {
  likelyExtinct?: boolean | undefined;
  extinctionAgeMa?: number | undefined;
  provenance: SourceReference;
}

async function lookupGbif(name: string, options: ExternalLookupOptions): Promise<GbifMatch | null> {
  return loadCachedOrFetch<GbifMatch | null>({
    providerId: 'gbif',
    cacheDir: options.cacheDir,
    key: name,
    online: options.online,
    fetcher: async () => {
      const url = `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(name)}`;
      const response = await fetchJson<Record<string, unknown>>(url, options);

      const usageKey = numericOrUndefined(response['usageKey']);
      const canonicalName = stringOrUndefined(response['canonicalName']);
      const rank = stringOrUndefined(response['rank']);
      const confidence = numericOrUndefined(response['confidence']);

      if (usageKey === undefined && !canonicalName) {
        return null;
      }

      return {
        usageKey,
        canonicalName,
        rank,
        confidence,
        provenance: buildSourceReference({
          sourceId: 'gbif-species-match',
          sourceType: 'gbif',
          externalId: usageKey !== undefined ? String(usageKey) : undefined,
          url,
          retrievedAt: new Date().toISOString(),
          note: confidence !== undefined ? `GBIF confidence ${confidence}` : undefined
        })
      };
    },
    providerStats: options.providerStats
  });
}

async function lookupOpenTree(
  name: string,
  options: ExternalLookupOptions
): Promise<OpenTreeMatch | null> {
  return loadCachedOrFetch<OpenTreeMatch | null>({
    providerId: 'open-tree',
    cacheDir: options.cacheDir,
    key: name,
    online: options.online,
    fetcher: async () => {
      const url = 'https://api.opentreeoflife.org/v3/tnrs/match_names';
      const response = await fetchJson<Record<string, unknown>>(
        url,
        options,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            names: [name],
            include_suppressed: false,
            do_approximate_matching: true
          })
        }
      );

      const results = asArray(response['results']);
      const firstResult = results[0];
      if (!firstResult || typeof firstResult !== 'object') {
        return null;
      }

      const matches = asArray((firstResult as Record<string, unknown>)['matches']);
      const firstMatch = matches[0];
      if (!firstMatch || typeof firstMatch !== 'object') {
        return null;
      }

      const taxon = (firstMatch as Record<string, unknown>)['taxon'];
      const score = numericOrUndefined((firstMatch as Record<string, unknown>)['score']);
      const taxonRecord = taxon && typeof taxon === 'object' ? (taxon as Record<string, unknown>) : {};
      const ottId = numericOrUndefined(taxonRecord['ott_id']);
      const canonicalName = stringOrUndefined(taxonRecord['unique_name']) ?? stringOrUndefined(taxonRecord['name']);

      if (ottId === undefined && !canonicalName) {
        return null;
      }

      return {
        ottId,
        canonicalName,
        score,
        provenance: buildSourceReference({
          sourceId: 'open-tree-tnrs',
          sourceType: 'open-tree',
          externalId: ottId !== undefined ? `ott${ottId}` : undefined,
          url,
          retrievedAt: new Date().toISOString(),
          note: score !== undefined ? `OpenTree TNRS score ${score}` : undefined
        })
      };
    },
    providerStats: options.providerStats
  });
}

async function lookupPaleoBioDb(
  name: string,
  options: ExternalLookupOptions
): Promise<PaleoBioDbMatch | null> {
  return loadCachedOrFetch<PaleoBioDbMatch | null>({
    providerId: 'paleobiodb',
    cacheDir: options.cacheDir,
    key: name,
    online: options.online,
    fetcher: async () => {
      const url = `https://paleobiodb.org/data1.2/taxa/list.json?name=${encodeURIComponent(name)}&show=attr`;
      const response = await fetchJson<Record<string, unknown>>(url, options);

      const records = asArray(response['records']);
      const first = records[0];
      if (!first || typeof first !== 'object') {
        return null;
      }

      const row = first as Record<string, unknown>;
      const ext = stringOrUndefined(row['ext']) ?? stringOrUndefined(row['extant']);
      const likelyExtinct = ext ? ext.toLowerCase() === 'n' || ext.toLowerCase() === 'false' : undefined;

      const lma = numericOrUndefined(row['lma']) ?? numericOrUndefined(row['lna']);
      const fma = numericOrUndefined(row['fma']) ?? numericOrUndefined(row['fna']);
      const extinctionAgeMa = likelyExtinct ? lma ?? fma : undefined;

      if (likelyExtinct === undefined && extinctionAgeMa === undefined) {
        return null;
      }

      const taxonNo = numericOrUndefined(row['taxon_no']);

      return {
        likelyExtinct,
        extinctionAgeMa,
        provenance: buildSourceReference({
          sourceId: 'paleobiodb-taxa-list',
          sourceType: 'paleobiodb',
          externalId: taxonNo !== undefined ? String(taxonNo) : undefined,
          url,
          retrievedAt: new Date().toISOString(),
          note: likelyExtinct ? 'PBDB indicates extinct status.' : undefined
        })
      };
    },
    providerStats: options.providerStats
  });
}

async function resolveMediaCandidates(
  node: PhyloNode,
  target: TargetSpecies,
  options: ExternalLookupOptions
): Promise<MediaCandidate[]> {
  const candidates: MediaCandidate[] = [];

  if (node.extant) {
    const extantImage = await lookupINaturalistImage(target.scientificName, options);
    if (extantImage) {
      candidates.push(extantImage);
    }
  }

  const silhouette = await lookupPhyloPicSilhouette(target.scientificName, options);
  if (silhouette) {
    candidates.push(silhouette);
  }

  if (!node.extant) {
    const extinctIllustration = await lookupOpenVerseExtinctIllustration(
      target.scientificName,
      options
    );
    if (extinctIllustration) {
      candidates.unshift(extinctIllustration);
    }
  }

  return candidates;
}

async function lookupINaturalistImage(
  name: string,
  options: ExternalLookupOptions
): Promise<MediaCandidate | null> {
  return loadCachedOrFetch<MediaCandidate | null>({
    providerId: 'inaturalist',
    cacheDir: options.cacheDir,
    key: name,
    online: options.online,
    fetcher: async () => {
      const url = `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(name)}&per_page=3&is_active=true`;
      const response = await fetchJson<Record<string, unknown>>(url, options);

      const results = asArray(response['results']);
      for (const row of results) {
        if (!row || typeof row !== 'object') {
          continue;
        }

        const taxon = row as Record<string, unknown>;
        const defaultPhoto = taxon['default_photo'];
        if (!defaultPhoto || typeof defaultPhoto !== 'object') {
          continue;
        }

        const photo = defaultPhoto as Record<string, unknown>;
        const licenseCode = (stringOrUndefined(photo['license_code']) ?? '').toLowerCase();
        if (!isFreeLicenseCode(licenseCode)) {
          continue;
        }

        const imageUrl = stringOrUndefined(photo['medium_url']) ?? stringOrUndefined(photo['url']);
        if (!imageUrl) {
          continue;
        }

        const taxonId = numericOrUndefined(taxon['id']);
        const attribution = stringOrUndefined(photo['attribution']) ?? 'iNaturalist community photo';

        return {
          kind: 'extant-photo',
          url: imageUrl,
          thumbnailUrl: stringOrUndefined(photo['square_url']),
          title: stringOrUndefined(taxon['preferred_common_name']) ?? stringOrUndefined(taxon['name']),
          confidence: 'medium',
          attribution: {
            providerId: 'inaturalist',
            sourceRecordId: taxonId !== undefined ? String(taxonId) : undefined,
            sourceUrl: taxonId !== undefined ? `https://www.inaturalist.org/taxa/${taxonId}` : undefined,
            attributionText: attribution,
            creatorName: undefined,
            licenseCode,
            licenseName: licenseNameFromCode(licenseCode),
            licenseUrl: licenseUrlFromCode(licenseCode)
          },
          provenance: [
            buildSourceReference({
              sourceId: 'inaturalist-taxa',
              sourceType: 'other',
              externalId: taxonId !== undefined ? String(taxonId) : undefined,
              url,
              retrievedAt: new Date().toISOString(),
              note: 'Filtered to free-use license codes.'
            })
          ]
        };
      }

      return null;
    },
    providerStats: options.providerStats
  });
}

async function lookupPhyloPicSilhouette(
  name: string,
  options: ExternalLookupOptions
): Promise<MediaCandidate | null> {
  return loadCachedOrFetch<MediaCandidate | null>({
    providerId: 'phylopic',
    cacheDir: options.cacheDir,
    key: name,
    online: options.online,
    fetcher: async () => {
      const url = `https://api.phylopic.org/images?filter_name=${encodeURIComponent(name)}`;
      const response = await fetchJson<Record<string, unknown>>(url, options);

      const embedded = response['_embedded'];
      if (!embedded || typeof embedded !== 'object') {
        return null;
      }

      const imageArray = asArray((embedded as Record<string, unknown>)['images']);
      const first = imageArray[0];
      if (!first || typeof first !== 'object') {
        return null;
      }

      const image = first as Record<string, unknown>;
      const links = image['_links'];
      const linksRecord = links && typeof links === 'object' ? (links as Record<string, unknown>) : {};
      const raster = linksRecord['rasterFile'];
      const rasterRecord = raster && typeof raster === 'object' ? (raster as Record<string, unknown>) : {};
      const href = stringOrUndefined(rasterRecord['href']);

      if (!href) {
        return null;
      }

      const attribution = stringOrUndefined(image['attribution']) ?? 'PhyloPic silhouette';
      const uid = stringOrUndefined(image['uid']);

      return {
        kind: 'silhouette',
        url: href,
        confidence: 'low',
        attribution: {
          providerId: 'phylopic',
          sourceRecordId: uid,
          sourceUrl: uid ? `https://www.phylopic.org/images/${uid}` : undefined,
          attributionText: attribution,
          licenseCode: 'varies',
          licenseName: 'See PhyloPic record',
          licenseUrl: uid ? `https://www.phylopic.org/images/${uid}` : undefined
        },
        provenance: [
          buildSourceReference({
            sourceId: 'phylopic-images',
            sourceType: 'other',
            externalId: uid,
            url,
            retrievedAt: new Date().toISOString(),
            note: 'PhyloPic lookup (best effort).'
          })
        ]
      };
    },
    providerStats: options.providerStats
  });
}

async function lookupOpenVerseExtinctIllustration(
  name: string,
  options: ExternalLookupOptions
): Promise<MediaCandidate | null> {
  return loadCachedOrFetch<MediaCandidate | null>({
    providerId: 'openverse',
    cacheDir: options.cacheDir,
    key: `${name}-extinct-illustration`,
    online: options.online,
    fetcher: async () => {
      const url =
        `https://api.openverse.engineering/v1/images/?q=${encodeURIComponent(`${name} paleoart silhouette`)}` +
        '&license_type=commercial&extension=jpg&page_size=5';
      const response = await fetchJson<Record<string, unknown>>(url, options);

      const results = asArray(response['results']);
      const first = results.find((row) => {
        if (!row || typeof row !== 'object') {
          return false;
        }

        const rec = row as Record<string, unknown>;
        return typeof rec['url'] === 'string';
      });

      if (!first || typeof first !== 'object') {
        return null;
      }

      const row = first as Record<string, unknown>;
      const imageUrl = stringOrUndefined(row['url']);
      if (!imageUrl) {
        return null;
      }

      const license = (stringOrUndefined(row['license']) ?? 'cc-by').toLowerCase();
      const creator = stringOrUndefined(row['creator']);
      const source = stringOrUndefined(row['source']);
      const foreignId = stringOrUndefined(row['foreign_landing_url']) ?? undefined;

      return {
        kind: 'extinct-illustration',
        url: imageUrl,
        thumbnailUrl: stringOrUndefined(row['thumbnail']),
        title: stringOrUndefined(row['title']),
        confidence: 'low',
        attribution: {
          providerId: 'openverse',
          sourceRecordId: source,
          sourceUrl: foreignId,
          creatorName: creator,
          attributionText: creator ? `${creator} via Openverse` : 'Openverse media result',
          licenseCode: license,
          licenseName: licenseNameFromCode(license),
          licenseUrl: licenseUrlFromCode(license)
        },
        provenance: [
          buildSourceReference({
            sourceId: 'openverse-images',
            sourceType: 'other',
            externalId: source,
            url,
            retrievedAt: new Date().toISOString(),
            note: 'Openverse fallback for extinct illustration/silhouette.'
          })
        ]
      };
    },
    providerStats: options.providerStats
  });
}

function applyTaxonomyToNode(
  node: PhyloNode,
  taxonomy: TaxonomyMatch,
  target: TargetSpecies
): void {
  node.scientificName = target.scientificName;
  node.commonName = target.commonName;

  if (taxonomy.canonicalName && !node.displayName) {
    node.displayName = taxonomy.canonicalName;
  }

  if (taxonomy.rank) {
    node.rank = taxonomy.rank;
  }

  if (taxonomy.taxonId) {
    node.taxonId = taxonomy.taxonId;
  }

  if (taxonomy.likelyExtinct === true) {
    node.extant = false;
    if (taxonomy.extinctionAgeMa !== undefined) {
      node.extinctionAgeMa = taxonomy.extinctionAgeMa;
    }
  }

  node.provenance = mergeProvenance(node.provenance, taxonomy.provenance);
}

function mergeProvenance(
  base: ReadonlyArray<SourceReference>,
  incoming: ReadonlyArray<SourceReference>
): SourceReference[] {
  const merged = [...base];
  const seen = new Set(
    base.map((entry) => `${entry.sourceId}|${entry.externalId ?? ''}|${entry.url ?? ''}`)
  );

  for (const entry of incoming) {
    const key = `${entry.sourceId}|${entry.externalId ?? ''}|${entry.url ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entry);
  }

  return merged;
}

function buildReconstructionQueueEntry(
  node: PhyloNode,
  tree: ScientificPhylogeny,
  requestedAt: string
): ReconstructionQueueEntry {
  const descendantNames = collectDescendantNames(tree, node.id, 5);
  const evidenceBasis = [
    `node:${node.id}`,
    `children:${node.childIds.length}`,
    ...descendantNames.map((name) => `descendant:${name}`)
  ];

  const prompt = [
    `Ancestral reconstruction reference for ${node.displayName}.`,
    'Use scientifically cautious style and include uncertainty cues.',
    `Node kind: ${node.kind}.`,
    `Descendant examples: ${descendantNames.join(', ') || 'none available'}.`,
    node.navigationOnly
      ? 'This is a navigation-only grouping. Represent as abstract lineage cluster, not a concrete species.'
      : 'Represent likely lineage-level morphology inferred from descendant traits.'
  ].join(' ');

  return {
    nodeId: node.id,
    prompt,
    promptVersion: RECONSTRUCTION_PROMPT_VERSION,
    generationModel: RECONSTRUCTION_GENERATION_MODEL,
    status: 'pending-review',
    evidenceBasis,
    requestedAt
  };
}

function collectDescendantNames(
  tree: ScientificPhylogeny,
  nodeId: string,
  limit: number
): string[] {
  const names: string[] = [];

  const visit = (currentId: string): void => {
    if (names.length >= limit) {
      return;
    }

    const node = tree.nodesById[currentId];
    if (!node) {
      return;
    }

    if (node.childIds.length === 0) {
      names.push(node.scientificName ?? node.displayName);
      return;
    }

    for (const childId of node.childIds) {
      if (names.length >= limit) {
        break;
      }
      visit(childId);
    }
  };

  visit(nodeId);
  return names;
}

function cloneTree(tree: ScientificPhylogeny): ScientificPhylogeny {
  return {
    ...tree,
    nodesById: Object.fromEntries(
      Object.entries(tree.nodesById).map(([id, node]) => [
        id,
        {
          ...node,
          childIds: [...node.childIds],
          traits: node.traits.map((trait) => ({
            ...trait,
            provenance: [...trait.provenance]
          })),
          provenance: [...node.provenance],
          ...(node.reconstruction ? { reconstruction: { ...node.reconstruction } } : {})
        }
      ])
    )
  };
}

interface CachedLookupOptions<T> {
  providerId: string;
  cacheDir: string;
  key: string;
  online: boolean;
  fetcher: () => Promise<T>;
  providerStats: Record<string, ProviderStatMutable>;
}

interface CachedLookupRecord<T> {
  cachedAt: string;
  value: T;
}

async function loadCachedOrFetch<T>(options: CachedLookupOptions<T>): Promise<T> {
  const stat =
    options.providerStats[options.providerId] ??
    (options.providerStats[options.providerId] = {
      providerId: options.providerId,
      requests: 0,
      cacheHits: 0,
      successes: 0,
      failures: 0,
      notes: new Set<string>()
    });
  const cachePath = lookupCachePath(options.cacheDir, options.providerId, options.key);

  stat.requests += 1;

  const cached = await readCacheRecord<T>(cachePath);
  if (cached !== null) {
    stat.cacheHits += 1;
    stat.successes += 1;
    return cached.value;
  }

  if (!options.online) {
    stat.notes.add('offline mode');
    return null as T;
  }

  try {
    const value = await options.fetcher();
    stat.successes += 1;
    await writeCacheRecord(cachePath, {
      cachedAt: new Date().toISOString(),
      value
    });
    return value;
  } catch (error) {
    stat.failures += 1;
    stat.notes.add(error instanceof Error ? error.message : 'unknown error');
    return null as T;
  }
}

function lookupCachePath(cacheDir: string, providerId: string, key: string): string {
  const digest = createHash('sha1').update(key).digest('hex');
  return join(cacheDir, 'external-media', providerId, `${digest}.json`);
}

async function readCacheRecord<T>(cachePath: string): Promise<CachedLookupRecord<T> | null> {
  try {
    const raw = await readFile(cachePath, 'utf8');
    return JSON.parse(raw) as CachedLookupRecord<T>;
  } catch {
    return null;
  }
}

async function writeCacheRecord<T>(cachePath: string, record: CachedLookupRecord<T>): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(record, null, 2), 'utf8');
}

async function fetchJson<T>(
  url: string,
  options: Pick<ExternalLookupOptions, 'timeoutMs' | 'retries' | 'userAgent'>,
  init?: RequestInit
): Promise<T> {
  const headers: HeadersInit = {
    accept: 'application/json',
    ...(options.userAgent ? { 'user-agent': options.userAgent } : {}),
    ...(init?.headers ?? {})
  };

  const maxAttempts = Math.max(1, options.retries + 1);
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal
      });

      if (!response.ok) {
        const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
        if ((response.status === 429 || response.status === 503) && attempt + 1 < maxAttempts) {
          await delay(retryAfter ?? 500 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`HTTP ${response.status} from ${url}`);
      }

      const parsed = (await response.json()) as T;
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= maxAttempts) {
        break;
      }
      await delay(220 * Math.pow(2, attempt));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfterMs(retryAfterHeader: string | null): number | undefined {
  if (!retryAfterHeader) {
    return undefined;
  }

  const asSeconds = Number(retryAfterHeader);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }

  const asDate = Date.parse(retryAfterHeader);
  if (Number.isFinite(asDate)) {
    const wait = asDate - Date.now();
    return wait > 0 ? wait : 0;
  }

  return undefined;
}

function buildAssetId(nodeId: string, kind: string, url: string): string {
  const digest = createHash('sha1').update(`${nodeId}|${kind}|${url}`).digest('hex').slice(0, 12);
  return `${kind}-${nodeId}-${digest}`;
}

function buildSourceReference(reference: {
  sourceId: string;
  sourceType: SourceReference['sourceType'];
  externalId?: string | undefined;
  citation?: string | undefined;
  url?: string | undefined;
  doi?: string | undefined;
  retrievedAt?: string | undefined;
  note?: string | undefined;
}): SourceReference {
  const sourceReference: SourceReference = {
    sourceId: reference.sourceId,
    sourceType: reference.sourceType
  };

  if (reference.externalId !== undefined) {
    sourceReference.externalId = reference.externalId;
  }
  if (reference.citation !== undefined) {
    sourceReference.citation = reference.citation;
  }
  if (reference.url !== undefined) {
    sourceReference.url = reference.url;
  }
  if (reference.doi !== undefined) {
    sourceReference.doi = reference.doi;
  }
  if (reference.retrievedAt !== undefined) {
    sourceReference.retrievedAt = reference.retrievedAt;
  }
  if (reference.note !== undefined) {
    sourceReference.note = reference.note;
  }

  return sourceReference;
}

function numericOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isFreeLicenseCode(code: string): boolean {
  return ['cc0', 'cc-by', 'cc-by-sa', 'cc-by-4.0', 'cc-by-sa-4.0', 'public domain'].includes(
    code
  );
}

function licenseNameFromCode(code: string): string {
  const map: Record<string, string> = {
    cc0: 'Creative Commons Zero',
    'cc-by': 'Creative Commons Attribution',
    'cc-by-sa': 'Creative Commons Attribution ShareAlike',
    'cc-by-4.0': 'Creative Commons Attribution 4.0',
    'cc-by-sa-4.0': 'Creative Commons Attribution ShareAlike 4.0',
    'public domain': 'Public Domain'
  };

  return map[code] ?? code.toUpperCase();
}

function licenseUrlFromCode(code: string): string | undefined {
  const map: Record<string, string> = {
    cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
    'cc-by': 'https://creativecommons.org/licenses/by/4.0/',
    'cc-by-sa': 'https://creativecommons.org/licenses/by-sa/4.0/',
    'cc-by-4.0': 'https://creativecommons.org/licenses/by/4.0/',
    'cc-by-sa-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
    'public domain': 'https://creativecommons.org/publicdomain/mark/1.0/'
  };

  return map[code];
}

function estimateFamiliarityFromDescriptor(target: TargetSpecies): number {
  const scientificName = target.scientificName.toLowerCase();
  const commonName = target.commonName.toLowerCase();

  const familiarHints = ['human', 'dog', 'cat', 'lion', 'tiger', 'whale', 'eagle', 'shark'];
  if (familiarHints.some((hint) => commonName.includes(hint) || scientificName.includes(hint))) {
    return 0.92;
  }

  if (scientificName.includes('sp.')) {
    return 0.25;
  }

  if (commonName.split(' ').length >= 4) {
    return 0.3;
  }

  return 0.55;
}
