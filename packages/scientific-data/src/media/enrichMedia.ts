import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  DescriptionSegment,
  PhyloNode,
  ScientificPhylogeny,
  SourceReference,
  TargetDifficultyMetadata
} from '@evo-tree/domain';

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

const DEFAULT_TIMEOUT_MS = 9000;
const DEFAULT_RETRIES = 2;
const DEFAULT_DESCRIPTION_MAX_CHARS = 500;
const DESCRIPTION_LOOKUP_CONCURRENCY = 6;
// Bump when the cached Wikipedia record shape changes, otherwise stale entries mask new fields.
const WIKIPEDIA_CACHE_VERSION = 'v3';
const RECONSTRUCTION_PROMPT_VERSION = 'm6.1';
const RECONSTRUCTION_GENERATION_MODEL = 'inline-svg-v1';

export async function enrichMediaForScientificTree(
  scientificTree: ScientificPhylogeny,
  targets: ReadonlyArray<TargetSpecies>,
  options: Partial<MediaEnrichmentOptions> & Pick<MediaEnrichmentOptions, 'cacheDir'>
): Promise<{ tree: ScientificPhylogeny; result: MediaEnrichmentResult }> {
  const maxTargets = Math.max(1, options.maxTargets ?? targets.length);
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
    'wikipedia-summary',
    'wikimedia-commons',
    'wikipedia-links',
    'phylopic',
    'openverse'
  ]);
  const lookupOptions: ExternalLookupOptions = {
    cacheDir: options.cacheDir,
    online,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? DEFAULT_RETRIES,
    userAgent: options.userAgent,
    providerStats
  };

  const targetLimit = Math.min(maxTargets, targets.length);
  const selectedTargets = targets.slice(0, targetLimit);
  const progressIntervalPercent = Math.max(
    1,
    Math.min(25, Math.round(options.progressIntervalPercent ?? 5))
  );
  const descriptionMaxChars = Math.max(
    1,
    Math.round(options.descriptionMaxChars ?? DEFAULT_DESCRIPTION_MAX_CHARS)
  );

  const createProgressEmitter = (
    phase: MediaEnrichmentProgress['phase'],
    totalItems: number
  ): ((processedItems: number) => void) => {
    let nextReportAtPercent = 0;
    return (processedItems: number): void => {
      if (!options.onProgress || totalItems === 0) {
        return;
      }

      const percent = Math.floor((processedItems / totalItems) * 100);
      if (processedItems < totalItems && percent < nextReportAtPercent) {
        return;
      }

      options.onProgress({ phase, processedItems, totalItems, percent });
      while (nextReportAtPercent <= percent) {
        nextReportAtPercent += progressIntervalPercent;
      }
    };
  };
  const emitTargetProgress = createProgressEmitter('target-media', selectedTargets.length);

  if (targetLimit < targets.length) {
    warnings.push(
      `Target taxonomy limit applied: enriched ${targetLimit} of ${targets.length} targets. Named-node descriptions and images are not limited. Use --media-target-limit to raise.`
    );
  }

  const taxonomyMetadata: TargetDifficultyMetadata[] = [];

  options.onStage?.(`Enriching ${selectedTargets.length} target nodes with taxonomy`);
  emitTargetProgress(0);

  for (let targetIndex = 0; targetIndex < selectedTargets.length; targetIndex += 1) {
    const target = selectedTargets[targetIndex];
    if (!target) {
      continue;
    }

    const node = workingTree.nodesById[target.id];
    if (!node) {
      warnings.push(`Target ${target.id} missing from scientific tree; skipped media enrichment.`);
      emitTargetProgress(targetIndex + 1);
      continue;
    }

    const taxonomy = await resolveTaxonomy(target, lookupOptions);

    applyTaxonomyToNode(node, taxonomy, target);
    emitTargetProgress(targetIndex + 1);
  }

  const descriptionNodes = Object.values(workingTree.nodesById).filter(
    (node) => !node.navigationOnly && isDescriptionLookupCandidate(node)
  );
  const articlesByNodeId = new Map<string, WikipediaDescription>();
  // Rehydration must not retain authored or previously resolved content on a cache miss.
  for (const node of descriptionNodes) {
    delete node.description;
    delete node.descriptionSource;
    delete node.descriptionSegments;
  }
  const emitDescriptionProgress = createProgressEmitter(
    'node-descriptions',
    descriptionNodes.length
  );
  options.onStage?.(
    `Hydrating descriptions for ${descriptionNodes.length} selectable nodes (maximum ${descriptionMaxChars} characters, ${DESCRIPTION_LOOKUP_CONCURRENCY} concurrent requests)`
  );
  emitDescriptionProgress(0);

  let processedDescriptionCount = 0;
  const unresolvedDescriptionLabels: string[] = [];
  for (
    let batchStart = 0;
    batchStart < descriptionNodes.length;
    batchStart += DESCRIPTION_LOOKUP_CONCURRENCY
  ) {
    const batch = descriptionNodes.slice(
      batchStart,
      batchStart + DESCRIPTION_LOOKUP_CONCURRENCY
    );
    await Promise.all(
      batch.map(async (node) => {
        const lookupName = node.scientificName ?? node.displayName;
        const description = await lookupWikipediaDescription(lookupName, lookupOptions);

        if (description) {
          articlesByNodeId.set(node.id, description);
          const limitedSummary = limitDescriptionToCompleteSentences(
            description.summary,
            descriptionMaxChars
          );
          if (limitedSummary) {
            node.description = limitedSummary;

            if (description.articleTitle) {
              node.descriptionSource = {
                articleTitle: description.articleTitle,
                url: description.articleUrl ?? '',
                licenseCode: 'cc-by-sa-4.0',
                licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
                attributionText: 'Wikipedia contributors',
                modified: limitedSummary !== description.summary
              };
            }

            const links = await lookupWikipediaLeadLinks(
              description.articleTitle ?? lookupName,
              lookupOptions
            );
            const segments = buildDescriptionSegments(limitedSummary, links);
            if (segments) {
              node.descriptionSegments = segments;
            }
          }
          node.provenance = mergeProvenance(node.provenance, [description.provenance]);
        }

        processedDescriptionCount += 1;
        emitDescriptionProgress(processedDescriptionCount);
      })
    );
  }

  const misattributed = dropMisattributedDescriptions(descriptionNodes, articlesByNodeId);
  for (const dropped of misattributed) {
    articlesByNodeId.delete(dropped.nodeId);
  }
  for (const node of descriptionNodes) {
    const title = articlesByNodeId.get(node.id)?.articleTitle;
    if (!node.commonName && title && normalizeForMatch(title) !== normalizeForMatch(node.scientificName ?? node.displayName)) {
      node.commonName = title;
    }
  }
  if (misattributed.length > 0) {
    warnings.push(
      `Dropped ${misattributed.length} description(s) that resolved to an encyclopedia article already claimed by a closer-matching clade: ${misattributed
        .slice(0, 10)
        .map((entry) => `${entry.label} -> ${entry.articleTitle}`)
        .join('; ')}${misattributed.length > 10 ? ` (+${misattributed.length - 10} more)` : ''}`
    );
  }

  for (const node of descriptionNodes) {
    if (!node.description) {
      unresolvedDescriptionLabels.push(node.scientificName ?? node.displayName);
    }
  }

  if (unresolvedDescriptionLabels.length > 0) {
    const preview = unresolvedDescriptionLabels.slice(0, 10).join('; ');
    const remainder =
      unresolvedDescriptionLabels.length > 10
        ? ` (+${unresolvedDescriptionLabels.length - 10} more)`
        : '';
    warnings.push(
      `No encyclopedia description resolved for ${unresolvedDescriptionLabels.length} selectable node(s); ` +
        `endpoints display an explicit unavailable-description notice; intermediary nodes may use generated lineage text: ${preview}${remainder}`
    );
  }

  const emitMediaProgress = createProgressEmitter('node-media', descriptionNodes.length);
  options.onStage?.(`Hydrating images for ${descriptionNodes.length} named nodes`);
  emitMediaProgress(0);
  let processedMediaCount = 0;
  for (let start = 0; start < descriptionNodes.length; start += DESCRIPTION_LOOKUP_CONCURRENCY) {
    await Promise.all(descriptionNodes.slice(start, start + DESCRIPTION_LOOKUP_CONCURRENCY).map(async (node) => {
      const candidates = await resolveMediaCandidates(node, articlesByNodeId.get(node.id), lookupOptions);
      for (const candidate of candidates) {
        const assetId = buildAssetId(node.id, candidate.kind, candidate.url);
        assetsById[assetId] = { ...candidate, assetId, nodeId: node.id, retrievedAt: generatedAt };
        nodeMediaByNodeId[node.id] = { nodeId: node.id, primaryAssetId: assetId, assetIds: [assetId] };
      }
      processedMediaCount += 1;
      emitMediaProgress(processedMediaCount);
    }));
  }
  for (const target of targets) {
    const node = workingTree.nodesById[target.id];
    if (node) {
      taxonomyMetadata.push({ speciesId: target.id, familiarityScore: estimateFamiliarity(node) });
    }
  }
  const targetIds = new Set(targets.map((target) => target.id));
  const coverageFor = (nodes: PhyloNode[]) => ({
    total: nodes.length,
    withDescription: nodes.filter((node) => Boolean(node.descriptionSource)).length,
    withImage: nodes.filter((node) => Boolean(nodeMediaByNodeId[node.id])).length,
    missingDescriptionNodeIds: nodes.filter((node) => !node.descriptionSource).map((node) => node.id),
    missingImageNodeIds: nodes.filter((node) => !nodeMediaByNodeId[node.id]).map((node) => node.id)
  });
  const coverage = {
    targets: coverageFor(descriptionNodes.filter((node) => targetIds.has(node.id))),
    intermediaries: coverageFor(descriptionNodes.filter((node) => !targetIds.has(node.id)))
  };
  for (const [group, entry] of Object.entries(coverage)) {
    options.onStage?.(`${group}: ${entry.withDescription}/${entry.total} descriptions; ${entry.withImage}/${entry.total} images`);
    if (entry.missingImageNodeIds.length > 0) {
      warnings.push(`No commercially reusable image resolved for ${entry.missingImageNodeIds.length} ${group}; see media.coverage.`);
    }
  }

  options.onStage?.('Generating structural-placeholder image metadata');
  for (const node of Object.values(workingTree.nodesById)) {
    if (!node.navigationOnly && isDescriptionLookupCandidate(node)) {
      delete node.reconstruction;
      continue;
    }
    if (node.childIds.length === 0) {
      continue;
    }

    const queueEntry = buildReconstructionQueueEntry(node, workingTree, generatedAt);
    reconstructionQueue.push(queueEntry);

    const reconstructionAsset = buildGeneratedReconstructionAsset(node, queueEntry, generatedAt);
    assetsById[reconstructionAsset.assetId] = reconstructionAsset;

    const nodeMedia = nodeMediaByNodeId[node.id] ?? {
      nodeId: node.id,
      primaryAssetId: null,
      assetIds: []
    };
    if (!nodeMedia.assetIds.includes(reconstructionAsset.assetId)) {
      nodeMedia.assetIds.push(reconstructionAsset.assetId);
    }
    if (!nodeMedia.primaryAssetId) {
      nodeMedia.primaryAssetId = reconstructionAsset.assetId;
    }
    nodeMediaByNodeId[node.id] = nodeMedia;

    node.reconstruction = {
      assetId: reconstructionAsset.assetId,
      url: reconstructionAsset.url,
      generationModel: RECONSTRUCTION_GENERATION_MODEL,
      prompt: queueEntry.prompt,
      promptVersion: queueEntry.promptVersion,
      reviewStatus: 'generated',
      scientificConfidence: node.navigationOnly ? 'speculative' : 'low',
      evidenceBasis: queueEntry.evidenceBasis,
      sourceNodeIds: [node.id],
      createdAt: generatedAt
    };
  }
  options.onStage?.(`Generated ${reconstructionQueue.length} internal-node reconstructions`);

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
        coverage,
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
  const [gbif, openTree, paleoBioDb, inaturalist] = await Promise.all([
    lookupGbif(target.scientificName, options),
    lookupOpenTree(target.scientificName, options),
    lookupPaleoBioDb(target.scientificName, options),
    lookupINaturalistTaxa(target.scientificName, options)
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
  if (inaturalist?.taxa.length) {
    provenance.push(inaturalist.provenance);
  }

  return {
    canonicalName: gbif?.canonicalName ?? openTree?.canonicalName,
    commonName: inaturalist?.taxa
      .map((taxon) => stringOrUndefined(taxon['preferred_common_name']))
      .find((name) => Boolean(name)),
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
  article: WikipediaDescription | undefined,
  options: ExternalLookupOptions
): Promise<MediaCandidate[]> {
  const name = node.scientificName ?? node.displayName;
  if (article) {
    const image = await lookupWikipediaLeadPhoto(article, options);
    if (image) {
      return [image];
    }
  }
  if (node.extant || node.childIds.length > 0) {
    const image = await lookupINaturalistImage(name, options);
    if (image) {
      return [node.childIds.length > 0 ? { ...image, kind: 'representative-image', confidence: 'low' } : image];
    }
  }
  const silhouette = await lookupPhyloPicSilhouette(name, options);
  if (silhouette) {
    return [silhouette];
  }
  if (!node.extant && node.childIds.length === 0) {
    const illustration = await lookupOpenVerseExtinctIllustration(name, options);
    if (illustration) {
      return [illustration];
    }
  }
  return [];
}

interface INaturalistTaxa {
  taxa: Record<string, unknown>[];
  provenance: SourceReference;
}

async function lookupINaturalistTaxa(
  name: string,
  options: ExternalLookupOptions
): Promise<INaturalistTaxa | null> {
  return loadCachedOrFetch<INaturalistTaxa | null>({
    providerId: 'inaturalist',
    cacheDir: options.cacheDir,
    key: `inat-taxa-v1:${name}`,
    online: options.online,
    fetcher: async () => {
      const url = `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(name)}&per_page=10&is_active=true&locale=en`;
      const response = await fetchJson<Record<string, unknown>>(url, options);
      const taxa = asArray(response['results']).map(asRecord).filter(
        (taxon) => normalizeTaxonName(stringOrUndefined(taxon['name']) ?? '') === normalizeTaxonName(name)
      );
      return {
        taxa,
        provenance: buildSourceReference({
          sourceId: 'inaturalist-taxa',
          sourceType: 'other',
          url,
          retrievedAt: new Date().toISOString(),
          note: 'Exact scientific-name matches; English preferred common names and photo metadata.'
        })
      };
    },
    providerStats: options.providerStats
  });
}

async function lookupINaturalistImage(
  name: string,
  options: ExternalLookupOptions
): Promise<MediaCandidate | null> {
  const result = await lookupINaturalistTaxa(name, options);
  if (!result) {
    return null;
  }
  for (const taxon of result.taxa) {
    const photo = asRecord(taxon['default_photo']);
    const licenseCode = (stringOrUndefined(photo['license_code']) ?? '').toLowerCase();
    const imageUrl = stringOrUndefined(photo['medium_url']) ?? stringOrUndefined(photo['url']);
    const attribution = stringOrUndefined(photo['attribution']);
    if (
      !imageUrl || !isAllowedLicenseCode(licenseCode) ||
      (!attribution && licenseCode !== 'cc0' && licenseCode !== 'public domain')
    ) {
      continue;
    }
    const taxonId = numericOrUndefined(taxon['id']);
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
        attributionText: attribution ?? 'Public-domain iNaturalist photo',
        creatorName: undefined,
        licenseCode,
        licenseName: licenseNameFromCode(licenseCode),
        licenseUrl: licenseUrlFromCode(licenseCode)
      },
      provenance: [{
        ...result.provenance,
        ...(taxonId !== undefined ? { externalId: String(taxonId) } : {}),
        note: 'Exact taxon-name match; commercially reusable photo license required.'
      }]
    };
  }
  return null;
}

interface CommonsLicense {
  code: string;
  name: string;
  url?: string | undefined;
  attribution: string;
  fileUrl: string;
}

async function lookupWikipediaLeadPhoto(
  article: WikipediaDescription,
  options: ExternalLookupOptions
): Promise<MediaCandidate | null> {
  const imageUrl = article.originalImageUrl ?? article.thumbnailUrl;
  if (!imageUrl) {
    return null;
  }

  const license = await lookupCommonsLicense(imageUrl, options);
  if (!license) {
    return null;
  }

  return {
    kind: 'representative-image',
    url: imageUrl,
    thumbnailUrl: article.thumbnailUrl,
    title: article.articleTitle,
    confidence: 'low',
    attribution: {
      providerId: 'wikimedia-commons',
      sourceUrl: license.fileUrl,
      attributionText: license.attribution,
      creatorName: license.attribution,
      licenseCode: license.code,
      licenseName: license.name,
      licenseUrl: license.url ?? licenseUrlFromCode(license.code)
    },
    provenance: [
      buildSourceReference({
        sourceId: 'wikipedia-page-summary',
        sourceType: 'other',
        url: article.articleUrl,
        retrievedAt: article.provenance.retrievedAt,
        note: 'Representative article lead image, not necessarily the exact species or ancestor; license verified on Wikimedia Commons.'
      })
    ]
  };
}

// Summary image URLs point at Commons files; the file name is recoverable from the path.
function commonsFileTitleFromUrl(imageUrl: string): string | undefined {
  const parsed = new URL(imageUrl);
  if (
    !['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(parsed.hostname) ||
    parsed.protocol !== 'https:' ||
    !parsed.pathname.startsWith('/wikipedia/commons/')
  ) {
    return undefined;
  }
  const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
  const commonsIndex = parts.indexOf('commons');
  if (commonsIndex < 0) {
    return undefined;
  }

  const rest = parts.slice(commonsIndex + 1);
  // Thumbnails: thumb/<a>/<bc>/<file>/<size>-<file>. Originals: <a>/<bc>/<file>.
  const fileSegment = rest[0] === 'thumb' ? rest[3] : rest[2];
  return fileSegment ? decodeURIComponent(fileSegment) : undefined;
}

function commonsLicenseCode(shortName: string): string | undefined {
  const name = shortName.trim();
  if (/^CC0(?: 1\.0)?$/i.test(name)) {
    return 'cc0';
  }
  if (/^public domain$/i.test(name)) {
    return 'public domain';
  }

  const match = /^CC BY(-SA)?\s+(\d(?:\.\d)?)(?:\s+[a-z]{2}(?:-[a-z]+)?)?$/i.exec(name);
  if (!match) {
    return undefined;
  }
  return `cc-by${match[1] ? '-sa' : ''}`;
}

async function lookupCommonsLicense(
  imageUrl: string,
  options: ExternalLookupOptions
): Promise<CommonsLicense | null> {
  const fileTitle = commonsFileTitleFromUrl(imageUrl);
  if (!fileTitle) {
    return null;
  }

  return loadCachedOrFetch<CommonsLicense | null>({
    providerId: 'wikimedia-commons',
    cacheDir: options.cacheDir,
    key: `file-license-commercial-v2:${fileTitle}`,
    online: options.online,
    fetcher: async () => {
      const url =
        'https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=extmetadata' +
        `&iiextmetadatafilter=LicenseShortName|LicenseUrl|Artist|Credit|Attribution&format=json&formatversion=2&titles=${encodeURIComponent(`File:${fileTitle}`)}`;
      const response = await fetchJsonAllowingMissing<Record<string, unknown>>(url, options);
      const page = asArray(asRecord(response?.['query'])?.['pages'])[0];
      const info = asArray(asRecord(page)?.['imageinfo'])[0];
      const metadata = asRecord(asRecord(info)?.['extmetadata']);

      const shortName = stringOrUndefined(asRecord(metadata?.['LicenseShortName'])?.['value']);
      const code = shortName ? commonsLicenseCode(shortName) : undefined;
      if (!shortName || !code || !isAllowedLicenseCode(code)) {
        return null;
      }

      const cleanCredit = (field: string): string => decodeHtmlText(
        (stringOrUndefined(asRecord(metadata[field])['value']) ?? '').replace(/<[^>]*>/g, '')
      ).replace(/\s+/g, ' ').trim();
      const artist = cleanCredit('Artist');
      const attribution = cleanCredit('Attribution') || artist;
      if (!attribution && code !== 'cc0' && code !== 'public domain') {
        return null;
      }
      const version = /\s(\d(?:\.\d)?)(?:\s+([a-z]{2}(?:-[a-z]+)?))?$/i.exec(shortName);
      const licenseUrl = stringOrUndefined(asRecord(metadata['LicenseUrl'])['value']) ??
        (version && code.startsWith('cc-by')
          ? `https://creativecommons.org/licenses/${code.slice(3)}/${version[1]}/${version[2] ? `${version[2].toLowerCase()}/` : ''}`
          : licenseUrlFromCode(code));
      if (licenseCodeFromUrl(licenseUrl) !== code) {
        return null;
      }

      return {
        code,
        name: shortName,
        url: licenseUrl,
        attribution: [attribution || 'Public-domain media', cleanCredit('Credit')].filter(Boolean).join(' | '),
        fileUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileTitle)}`
      };
    },
    providerStats: options.providerStats
  });
}

interface WikipediaDescription {
  summary: string;
  articleTitle?: string | undefined;
  articleUrl?: string | undefined;
  originalImageUrl?: string | undefined;
  thumbnailUrl?: string | undefined;
  provenance: SourceReference;
}

async function lookupWikipediaDescription(
  name: string,
  options: ExternalLookupOptions
): Promise<WikipediaDescription | null> {
  for (const candidate of wikipediaTitleCandidates(name)) {
    const found = await lookupWikipediaDescriptionByTitle(candidate, options);
    if (found) {
      return found;
    }
  }

  return null;
}

// OpenTree labels carry qualifiers such as "Vertebrata (subphylum in Deuterostomia)".
// Wikipedia resolves most synonyms via redirects; the qualified forms rescue disambiguation pages.
function wikipediaTitleCandidates(name: string): string[] {
  const trimmed = name.trim();
  const withoutQualifier = trimmed.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const base = withoutQualifier || trimmed;

  return [
    ...new Set(
      [withoutQualifier, trimmed, `${base} (genus)`, `${base} (biology)`].filter(
        (value) => value.length > 0
      )
    )
  ];
}

async function lookupWikipediaDescriptionByTitle(
  name: string,
  options: ExternalLookupOptions
): Promise<WikipediaDescription | null> {
  return loadCachedOrFetch<WikipediaDescription | null>({
    providerId: 'wikipedia-summary',
    cacheDir: options.cacheDir,
    key: `${WIKIPEDIA_CACHE_VERSION}:${name}`,
    online: options.online,
    fetcher: async () => {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
      const response = await fetchJsonAllowingMissing<Record<string, unknown>>(url, options);
      if (!response) {
        return null;
      }
      const summary = stringOrUndefined(response['extract'])?.replace(/\s+/g, ' ').trim();
      if (!summary || response['type'] === 'disambiguation') {
        return null;
      }

      const pageId = numericOrUndefined(response['pageid']);
      const contentUrls = response['content_urls'];
      const desktop =
        contentUrls && typeof contentUrls === 'object'
          ? (contentUrls as Record<string, unknown>)['desktop']
          : undefined;
      const pageUrl =
        desktop && typeof desktop === 'object'
          ? stringOrUndefined((desktop as Record<string, unknown>)['page'])
          : undefined;

      return {
        summary,
        articleTitle: stringOrUndefined(response['title']) ?? name,
        articleUrl: pageUrl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(stringOrUndefined(response['title']) ?? name)}`,
        originalImageUrl: stringOrUndefined(asRecord(response['originalimage'])['source']),
        thumbnailUrl: stringOrUndefined(asRecord(response['thumbnail'])['source']),
        provenance: buildSourceReference({
          sourceId: 'wikipedia-page-summary',
          sourceType: 'other',
          externalId: pageId !== undefined ? String(pageId) : undefined,
          url: pageUrl ?? url,
          retrievedAt: new Date().toISOString(),
          note: 'Introductory taxon summary supplied by the Wikipedia REST API.'
        })
      };
    },
    providerStats: options.providerStats
  });
}

// Shared genus articles can legitimately describe species, but unrelated redirects must not inherit them.
function dropMisattributedDescriptions(
  nodes: ReadonlyArray<PhyloNode>,
  articlesByNodeId: ReadonlyMap<string, WikipediaDescription>
): { nodeId: string; label: string; articleTitle: string }[] {
  const byArticle = new Map<string, PhyloNode[]>();

  for (const node of nodes) {
    const articleTitle = node.descriptionSource?.articleTitle;
    if (!articleTitle) {
      continue;
    }

    const key = articleTitle.toLowerCase();
    const existing = byArticle.get(key) ?? [];
    existing.push(node);
    byArticle.set(key, existing);
  }

  const dropped: { nodeId: string; label: string; articleTitle: string }[] = [];

  for (const claimants of byArticle.values()) {
    if (claimants.length < 2) {
      continue;
    }

    const ranked = [...claimants].sort(
      (left, right) => articleMatchScore(right) - articleMatchScore(left)
    );

    for (const node of ranked.slice(1)) {
      const article = articlesByNodeId.get(node.id);
      if (
        normalizeForMatch(node.scientificName ?? node.displayName) ===
          normalizeForMatch(node.descriptionSource?.articleTitle ?? '') ||
        (article && articleExplicitlyMentionsTaxon(article.summary, node))
      ) {
        continue;
      }
      dropped.push({
        nodeId: node.id,
        label: node.scientificName ?? node.displayName,
        articleTitle: node.descriptionSource?.articleTitle ?? ''
      });

      delete node.description;
      delete node.descriptionSegments;
      delete node.descriptionSource;
    }
  }

  function articleExplicitlyMentionsTaxon(summary: string, node: PhyloNode): boolean {
    const name = (node.scientificName ?? node.displayName)
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (!name) {
      return false;
    }
    const text = summary.replace(/\s+/g, ' ').toLowerCase();
    let position = text.indexOf(name);
    while (position >= 0) {
      if (isWholeWordMatch(text, position, position + name.length)) {
        return true;
      }
      position = text.indexOf(name, position + 1);
    }
    return false;
  }

  return dropped;
}

function articleMatchScore(node: PhyloNode): number {
  const label = normalizeForMatch(node.scientificName ?? node.displayName);
  const article = normalizeForMatch(node.descriptionSource?.articleTitle ?? '');

  if (label === article) {
    return Number.MAX_SAFE_INTEGER;
  }

  let shared = 0;
  while (shared < label.length && shared < article.length && label[shared] === article[shared]) {
    shared += 1;
  }

  return shared;
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[^a-z]/g, '');
}

function isDescriptionLookupCandidate(node: PhyloNode): boolean {
  const label = (node.scientificName ?? node.displayName).trim();
  return !(
    /^mrca\b/i.test(label) ||
    /^h\d+(?:-\d+)?$/i.test(label) ||
    /^openTree clade\b/i.test(label) ||
    /^clade of\b/i.test(label)
  );
}

function limitDescriptionToCompleteSentences(
  description: string,
  maxChars: number
): string | undefined {
  const normalized = description.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const sentences = normalized.match(/[^.!?]+[.!?]+(?:["')\]]+)?/g) ?? [];
  let limited = '';
  for (const sentence of sentences) {
    const candidate = `${limited}${limited ? ' ' : ''}${sentence.trim()}`;
    if (candidate.length > maxChars) {
      break;
    }
    limited = candidate;
  }

  return limited || undefined;
}

interface WikipediaLeadLink {
  phrase: string;
  articleTitle: string;
  href: string;
}

const WIKIPEDIA_ANCHOR_PATTERN = /<a\b[^>]*href="\/wiki\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;

async function lookupWikipediaLeadLinks(
  articleTitle: string,
  options: ExternalLookupOptions
): Promise<WikipediaLeadLink[]> {
  const links = await loadCachedOrFetch<WikipediaLeadLink[] | null>({
    providerId: 'wikipedia-links',
    cacheDir: options.cacheDir,
    key: `${WIKIPEDIA_CACHE_VERSION}:${articleTitle}`,
    online: options.online,
    fetcher: async () => {
      const url =
        'https://en.wikipedia.org/w/api.php?action=parse&prop=text&section=0&redirects=1' +
        `&format=json&formatversion=2&page=${encodeURIComponent(articleTitle)}`;
      const response = await fetchJsonAllowingMissing<Record<string, unknown>>(url, options);
      if (!response) {
        return null;
      }

      const parse = response['parse'];
      const html =
        parse && typeof parse === 'object'
          ? stringOrUndefined((parse as Record<string, unknown>)['text'])
          : undefined;

      if (!html) {
        return null;
      }

      return extractWikipediaLeadLinks(html);
    },
    providerStats: options.providerStats
  });

  return links ?? [];
}

function extractWikipediaLeadLinks(html: string): WikipediaLeadLink[] {
  const byPhrase = new Map<string, WikipediaLeadLink>();

  for (const match of html.matchAll(WIKIPEDIA_ANCHOR_PATTERN)) {
    const rawTitle = match[1];
    const rawInner = match[2];
    if (!rawTitle || !rawInner || rawInner.includes('<img')) {
      continue;
    }

    const articleTitle = decodeWikiTitle(rawTitle);
    // Namespaced links such as File:, Help: and Category: are not article links.
    if (!articleTitle || articleTitle.includes(':')) {
      continue;
    }

    const phrase = decodeHtmlText(rawInner.replace(/<[^>]+>/g, '')).trim();
    if (phrase.length < 3 || /^\d+$/.test(phrase)) {
      continue;
    }

    const key = phrase.toLowerCase();
    if (byPhrase.has(key)) {
      continue;
    }

    byPhrase.set(key, {
      phrase,
      articleTitle,
      href: `https://en.wikipedia.org/wiki/${rawTitle}`
    });
  }

  return [...byPhrase.values()];
}

function buildDescriptionSegments(
  description: string,
  links: ReadonlyArray<WikipediaLeadLink>
): DescriptionSegment[] | undefined {
  if (links.length === 0) {
    return undefined;
  }

  const lowerDescription = description.toLowerCase();
  const claimed: { start: number; end: number; link: WikipediaLeadLink }[] = [];
  const orderedLinks = [...links].sort((a, b) => b.phrase.length - a.phrase.length);

  for (const link of orderedLinks) {
    const needle = link.phrase.toLowerCase();
    let searchFrom = 0;

    while (searchFrom <= lowerDescription.length - needle.length) {
      const start = lowerDescription.indexOf(needle, searchFrom);
      if (start === -1) {
        break;
      }

      const end = start + needle.length;
      const overlaps = claimed.some((range) => start < range.end && end > range.start);

      if (!overlaps && isWholeWordMatch(description, start, end)) {
        claimed.push({ start, end, link });
        break;
      }

      searchFrom = start + 1;
    }
  }

  if (claimed.length === 0) {
    return undefined;
  }

  claimed.sort((a, b) => a.start - b.start);

  const segments: DescriptionSegment[] = [];
  let cursor = 0;

  for (const range of claimed) {
    if (range.start > cursor) {
      segments.push({ text: description.slice(cursor, range.start) });
    }

    segments.push({
      text: description.slice(range.start, range.end),
      href: range.link.href,
      articleTitle: range.link.articleTitle
    });

    cursor = range.end;
  }

  if (cursor < description.length) {
    segments.push({ text: description.slice(cursor) });
  }

  return segments;
}

function isWholeWordMatch(value: string, start: number, end: number): boolean {
  const before = start > 0 ? value[start - 1] : undefined;
  const after = end < value.length ? value[end] : undefined;
  const isWordCharacter = (character: string | undefined): boolean =>
    character !== undefined && /[A-Za-z0-9]/.test(character);

  return !isWordCharacter(before) && !isWordCharacter(after);
}

function decodeWikiTitle(rawTitle: string): string {
  try {
    return decodeURIComponent(rawTitle).replace(/_/g, ' ');
  } catch {
    return rawTitle.replace(/_/g, ' ');
  }
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const PHYLOPIC_ACCEPT_HEADER = 'application/vnd.phylopic.v2+json';
const phyloPicBuildLookups = new WeakMap<Record<string, ProviderStatMutable>, Promise<number>>();

// PhyloPic requires a build number on node queries; the root endpoint reports the current one.
function getPhyloPicBuild(options: ExternalLookupOptions): Promise<number> {
  const existing = phyloPicBuildLookups.get(options.providerStats);
  if (existing) {
    return existing;
  }
  const lookup = fetchJson<Record<string, unknown>>('https://api.phylopic.org/', options, {
    headers: { accept: PHYLOPIC_ACCEPT_HEADER }
  }).then((root) => {
    if (typeof root['build'] !== 'number') {
      throw new Error('PhyloPic root response did not include a build number.');
    }
    return root['build'];
  });
  phyloPicBuildLookups.set(options.providerStats, lookup);
  return lookup;
}

async function lookupPhyloPicSilhouette(
  name: string,
  options: ExternalLookupOptions
): Promise<MediaCandidate | null> {
  return loadCachedOrFetch<MediaCandidate | null>({
    providerId: 'phylopic',
    cacheDir: options.cacheDir,
    key: `phylopic-commercial-v3:${name}`,
    online: options.online,
    fetcher: async () => {
      const build = await getPhyloPicBuild(options);
      const filterName = normalizeTaxonName(name);
      const url =
        `https://api.phylopic.org/nodes?build=${build}&page=0&filter_name=${encodeURIComponent(filterName)}` +
        '&embed_items=true&embed_primaryImage=true';
      const response = await fetchJsonAllowingMissing<Record<string, unknown>>(url, options, {
        headers: { accept: PHYLOPIC_ACCEPT_HEADER }
      });
      if (!response) {
        return null;
      }

      const items = asArray(asRecord(response['_embedded'])['items']);
      const image = items
        .map((item) => asRecord(asRecord(item)['_embedded'])['primaryImage'])
        .find((candidate) => licenseCodeFromUrl(
          stringOrUndefined(asRecord(asRecord(asRecord(candidate)['_links'])['license'])['href'])
        ));
      if (!image) {
        return null;
      }

      const imageRecord = asRecord(image);
      const rasterFiles = asArray(asRecord(imageRecord['_links'])['rasterFiles'])
        .map((raster) => stringOrUndefined(asRecord(raster)['href']))
        .filter((href): href is string => Boolean(href));
      const href = rasterFiles[0];
      if (!href) {
        return null;
      }
      const thumbnailUrl = rasterFiles[rasterFiles.length - 1];

      const attribution = stringOrUndefined(imageRecord['attribution']) ?? 'PhyloPic silhouette';
      const uid = stringOrUndefined(imageRecord['uuid']);
      const licenseUrl = stringOrUndefined(asRecord(asRecord(imageRecord['_links'])['license'])['href']);
      const licenseCode = licenseCodeFromUrl(licenseUrl);
      if (!licenseCode) {
        return null;
      }
      if (!stringOrUndefined(imageRecord['attribution']) && licenseCode !== 'cc0' && licenseCode !== 'public domain') {
        return null;
      }

      return {
        kind: 'silhouette',
        url: href,
        thumbnailUrl,
        confidence: 'low',
        attribution: {
          providerId: 'phylopic',
          sourceRecordId: uid,
          sourceUrl: uid ? `https://www.phylopic.org/images/${uid}` : undefined,
          attributionText: attribution,
          licenseCode,
          licenseName: licenseNameFromCode(licenseCode),
          licenseUrl
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
    key: `commercial-v2:${name}-extinct-illustration`,
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
        const code = stringOrUndefined(rec['license'])?.toLowerCase() ?? '';
        return typeof rec['url'] === 'string' && isAllowedLicenseCode(code) &&
          (code === 'cc0' || code === 'public domain' || Boolean(stringOrUndefined(rec['creator'])));
      });

      if (!first || typeof first !== 'object') {
        return null;
      }

      const row = first as Record<string, unknown>;
      const imageUrl = stringOrUndefined(row['url']);
      if (!imageUrl) {
        return null;
      }

      const license = (stringOrUndefined(row['license']) ?? '').toLowerCase();
      const licenseVersion = stringOrUndefined(row['license_version']);
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
          sourceUrl: foreignId ?? imageUrl,
          creatorName: creator,
          attributionText: creator ? `${creator} via Openverse` : 'Openverse media result',
          licenseCode: license,
          licenseName: licenseNameFromCode(license),
          licenseUrl: licenseVersion && /^cc-by(?:-sa)?$/.test(license)
            ? `https://creativecommons.org/licenses/${license.slice(3)}/${licenseVersion}/`
            : licenseUrlFromCode(license)
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
  if (taxonomy.commonName) {
    node.commonName = taxonomy.commonName;
  }

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
    status: 'generated',
    evidenceBasis,
    requestedAt
  };
}

function buildGeneratedReconstructionAsset(
  node: PhyloNode,
  queueEntry: ReconstructionQueueEntry,
  generatedAt: string
): MediaAssetRecord {
  const assetId = `reconstruction-${node.id}`;
  const url = buildReconstructionDataUrl(node);

  return {
    assetId,
    nodeId: node.id,
    kind: 'reconstruction',
    url,
    title: `Reconstruction: ${node.displayName}`,
    confidence: node.navigationOnly ? 'low' : 'medium',
    retrievedAt: generatedAt,
    attribution: {
      providerId: 'generated-reconstruction',
      sourceRecordId: node.id,
      attributionText: 'Generated lineage reconstruction from descendant summary metadata.',
      licenseCode: 'cc0',
      licenseName: 'CC0 1.0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/'
    },
    provenance: [
      ...node.provenance,
      buildSourceReference({
        sourceId: 'reconstruction-generator',
        sourceType: 'curated',
        note: `Generated inline reconstruction from prompt version ${queueEntry.promptVersion}.`
      })
    ]
  };
}

function buildReconstructionDataUrl(node: PhyloNode): string {
  const title = escapeSvgText(node.displayName);
  const subtitle = escapeSvgText(node.navigationOnly ? 'Speculative lineage cluster' : 'Inferred ancestral lineage');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#0f2f2b"/><stop offset="100%" stop-color="#1f4f48"/>' +
    '</linearGradient></defs>' +
    '<rect width="640" height="360" fill="url(#g)"/>' +
    '<circle cx="120" cy="120" r="80" fill="#2f7d6f" opacity="0.3"/>' +
    '<circle cx="520" cy="260" r="110" fill="#94d2bd" opacity="0.2"/>' +
    `<text x="40" y="190" fill="#f1faee" font-family="Georgia,serif" font-size="34">${title}</text>` +
    `<text x="40" y="230" fill="#d9f2ea" font-family="Georgia,serif" font-size="19">${subtitle}</text>` +
    '</svg>';

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
          ...(node.descriptionSegments
            ? { descriptionSegments: node.descriptionSegments.map((segment) => ({ ...segment })) }
            : {}),
          ...(node.descriptionSource ? { descriptionSource: { ...node.descriptionSource } } : {}),
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

// A missing article is a legitimate absence, not a provider malfunction.
async function fetchJsonAllowingMissing<T>(
  url: string,
  options: Pick<ExternalLookupOptions, 'timeoutMs' | 'retries' | 'userAgent'>,
  init?: RequestInit
): Promise<T | null> {
  try {
    return await fetchJson<T>(url, options, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('HTTP 404')) {
      return null;
    }
    throw error;
  }
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isAllowedLicenseCode(code: string): boolean {
  return [
    'cc0',
    'cc-by',
    'cc-by-sa',
    'cc-by-4.0',
    'cc-by-sa-4.0',
    'public domain'
  ].includes(code);
}

function licenseCodeFromUrl(url: string | undefined): string | undefined {
  const match = /^https?:\/\/creativecommons\.org\/(?:licenses\/(by(?:-sa)?)\/\d\.\d|publicdomain\/(zero|mark)\/1\.0)(?:\/[a-z]{2})?\/?(?:deed\.[a-z_-]+)?$/i.exec(url ?? '');
  return match?.[1] ? `cc-${match[1].toLowerCase()}` : match?.[2] === 'zero' ? 'cc0' : match?.[2] === 'mark' ? 'public domain' : undefined;
}

function normalizeTaxonName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
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

function estimateFamiliarity(node: PhyloNode): number {
  const scientificName = (node.scientificName ?? '').toLowerCase();
  const commonName = (node.commonName ?? '').toLowerCase();

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
