import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  PhylogeneticTrait,
  PhyloNode,
  ScientificPhylogeny,
  SourceReference
} from '@evo-tree/domain';

import type { TargetSpecies } from '../types';

const ROOT_ID = 'luca';
const UNRESOLVED_CATALOG_ROOT_ID = 'target-catalog-root';
const ROOT_AGE_MA = 3900;
const DEFAULT_TIMEOUT_MS = 9000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_CHILDREN_PER_NAV_NODE = 6;

interface BuildOpenTreeScientificPhylogenyOptions {
  datasetVersion: string;
  cacheDir: string;
  online: boolean;
  timeoutMs?: number | undefined;
  retries?: number | undefined;
  userAgent?: string | undefined;
  maxChildrenPerNavigationNode?: number | undefined;
  onStage?: ((message: string) => void) | undefined;
  onWarning?: ((message: string) => void) | undefined;
}

export type TargetResolutionStatus = 'matched' | 'unmatched' | 'lookup-failed' | 'skipped-offline';

export interface TargetResolutionRecord {
  targetId: string;
  scientificName: string;
  status: TargetResolutionStatus;
  ottId?: number | undefined;
  matchedName?: string | undefined;
  score?: number | undefined;
  error?: string | undefined;
  placedInTopology: boolean;
}

export interface OpenTreeScientificPhylogenyResult {
  scientificPhylogeny: ScientificPhylogeny;
  usedOpenTreeTopology: boolean;
  resolvedTargetCount: number;
  unresolvedTargetCount: number;
  warnings: string[];
  resolutionRecords: TargetResolutionRecord[];
  inducedSubtreeChunkCount: number;
  usedAdaptiveChunking: boolean;
}

interface TargetOttResolution {
  targetId: string;
  scientificName: string;
  status: TargetResolutionStatus;
  ottId?: number | undefined;
  matchedName?: string | undefined;
  score?: number | undefined;
  error?: string | undefined;
  provenance?: SourceReference | undefined;
}

interface NewickNode {
  label: string | null;
  children: NewickNode[];
}

interface MaterializeContext {
  nodesById: Record<string, PhyloNode>;
  targetById: Map<string, TargetSpecies>;
  resolutionsByTargetId: Map<string, TargetOttResolution>;
  targetIdsByOttId: Map<number, string[]>;
  usedTargetIds: Set<string>;
  usedNodeIds: Set<string>;
  internalCounter: number;
  maxDepth: number;
}

interface ExternalLookupOptions {
  cacheDir: string;
  online: boolean;
  timeoutMs: number;
  retries: number;
  userAgent?: string | undefined;
}

interface TnrsLookupOutcome {
  match: OpenTreeTnrsMatch | null;
  error?: string | undefined;
  skippedOffline: boolean;
}

interface CachedLookupRecord<T> {
  cachedAt: string;
  value: T;
}

export async function buildOpenTreeScientificPhylogeny(
  targets: ReadonlyArray<TargetSpecies>,
  options: BuildOpenTreeScientificPhylogenyOptions
): Promise<OpenTreeScientificPhylogenyResult> {
  if (targets.length === 0) {
    throw new Error('Cannot compile scientific phylogeny from an empty target list.');
  }

  const warnings: string[] = [];
  const lookupOptions: ExternalLookupOptions = {
    cacheDir: options.cacheDir,
    online: options.online,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? DEFAULT_RETRIES,
    ...(options.userAgent ? { userAgent: options.userAgent } : {})
  };

  const resolutions = await resolveTargetsToOttIds(targets, lookupOptions, options.onWarning);
  const resolvedTargets = resolutions.filter((entry) => entry.ottId !== undefined);
  const resolvedTargetCount = resolvedTargets.length;

  const failedLookups = resolutions.filter((entry) => entry.status === 'lookup-failed');
  const unmatchedNames = resolutions.filter((entry) => entry.status === 'unmatched');
  const offlineSkips = resolutions.filter((entry) => entry.status === 'skipped-offline');

  if (failedLookups.length > 0) {
    warnings.push(
      `OpenTree name resolution failed for ${failedLookups.length} target(s): ${failedLookups
        .map((entry) => `${entry.scientificName} (${entry.error ?? 'unknown error'})`)
        .join('; ')}`
    );
  }

  if (unmatchedNames.length > 0) {
    warnings.push(
      `OpenTree returned no name match for ${unmatchedNames.length} target(s): ${unmatchedNames
        .map((entry) => entry.scientificName)
        .join('; ')}`
    );
  }

  if (offlineSkips.length > 0) {
    warnings.push(
      `OpenTree name resolution skipped for ${offlineSkips.length} target(s) because the run was offline with no cached match.`
    );
  }

  if (resolvedTargetCount < 2) {
    throw new Error(
      `OpenTree topology unavailable: only ${resolvedTargetCount} target(s) resolved to OTT IDs. ` +
        'At least 2 resolved targets are required to generate a runtime tree.'
    );
  }

  const uniqueOttIds = [...new Set(resolvedTargets.map((entry) => entry.ottId).filter(isNumber))];
  options.onStage?.(
    `Requesting OpenTree induced subtree for ${uniqueOttIds.length} resolved OTT identifiers`
  );
  const inducedSets = await fetchOpenTreeInducedSubtreeSets(uniqueOttIds, lookupOptions);

  if (inducedSets.newicks.length === 0) {
    const fallbackWarning = inducedSets.warnings.join(' ');
    throw new Error(
      'OpenTree topology unavailable: induced subtree request returned no usable topology.' +
        (fallbackWarning ? ` ${fallbackWarning}` : '')
    );
  }
  warnings.push(...inducedSets.warnings);

  const nodesById: Record<string, PhyloNode> = {
    [ROOT_ID]: buildLucaRootNode('Root anchor for OpenTree-induced runtime topology.')
  };

  const targetById = new Map(targets.map((target) => [target.id, target]));
  const resolutionsByTargetId = new Map(resolutions.map((resolution) => [resolution.targetId, resolution]));

  const targetIdsByOttId = new Map<number, string[]>();
  for (const resolution of resolvedTargets) {
    const ottId = resolution.ottId;
    if (ottId === undefined) {
      continue;
    }

    const existing = targetIdsByOttId.get(ottId) ?? [];
    existing.push(resolution.targetId);
    targetIdsByOttId.set(ottId, existing);
  }

  const context: MaterializeContext = {
    nodesById,
    targetById,
    resolutionsByTargetId,
    targetIdsByOttId,
    usedTargetIds: new Set<string>(),
    usedNodeIds: new Set<string>([ROOT_ID]),
    internalCounter: 0,
    maxDepth: 1
  };

  const openTreeRootChildIds: string[] = [];
  for (const newick of inducedSets.newicks) {
    const parsed = parseNewick(newick);
    const ids = materializeRoot(parsed, context);
    openTreeRootChildIds.push(...ids);
  }

  const unresolvedTargets = targets.filter((target) => !context.usedTargetIds.has(target.id));
  const unresolvedTargetCount = unresolvedTargets.length;

  const rootChildIds = [...openTreeRootChildIds];
  if (unresolvedTargets.length > 0) {
    warnings.push(
      `OpenTree unresolved targets: ${unresolvedTargets.length} of ${targets.length}. They remain under an unresolved catalog branch.`
    );
    const unresolvedBranchId = buildUnresolvedBranch(
      unresolvedTargets,
      context,
      options.maxChildrenPerNavigationNode
    );
    rootChildIds.push(unresolvedBranchId);
  }

  if (rootChildIds.length === 0) {
    throw new Error(
      'OpenTree topology produced no usable mapped endpoints after materialization. Tree generation aborted.'
    );
  }

  const rootNode = nodesById[ROOT_ID];
  if (!rootNode) {
    throw new Error('Root node was not initialized for OpenTree topology build.');
  }

  nodesById[ROOT_ID] = {
    ...rootNode,
    childIds: rootChildIds,
    confidence: 'medium'
  };

  hydrateInternalLineageMetadata(nodesById, ROOT_ID);

  const tree: ScientificPhylogeny = {
    datasetVersion: options.datasetVersion,
    rootId: ROOT_ID,
    nodesById
  };

  const resolutionRecords: TargetResolutionRecord[] = resolutions.map((resolution) => ({
    targetId: resolution.targetId,
    scientificName: resolution.scientificName,
    status: resolution.status,
    ottId: resolution.ottId,
    matchedName: resolution.matchedName,
    score: resolution.score,
    error: resolution.error,
    placedInTopology: context.usedTargetIds.has(resolution.targetId)
  }));

  const matchedButUnplaced = resolutionRecords.filter(
    (record) => record.status === 'matched' && !record.placedInTopology
  );

  if (matchedButUnplaced.length > 0) {
    warnings.push(
      `OpenTree resolved but did not place ${matchedButUnplaced.length} target(s) in the induced topology: ${matchedButUnplaced
        .map((record) => record.scientificName)
        .join('; ')}`
    );
  }

  return {
    scientificPhylogeny: tree,
    usedOpenTreeTopology: true,
    resolvedTargetCount,
    unresolvedTargetCount,
    warnings,
    resolutionRecords,
    inducedSubtreeChunkCount: inducedSets.newicks.length,
    usedAdaptiveChunking: inducedSets.usedAdaptiveChunking
  };
}

function materializeRoot(parsedRoot: NewickNode, context: MaterializeContext): string[] {
  const seeds = parsedRoot.children.length > 0 ? parsedRoot.children : [parsedRoot];
  const childIds: string[] = [];

  for (const seed of seeds) {
    const ids = materializeNode(seed, ROOT_ID, 1, context);
    childIds.push(...ids);
  }

  return uniqueValues(childIds);
}

function materializeNode(
  parsedNode: NewickNode,
  parentId: string,
  depth: number,
  context: MaterializeContext
): string[] {
  context.maxDepth = Math.max(context.maxDepth, depth);

  if (parsedNode.children.length === 0) {
    return materializeLeafNode(parsedNode, parentId, context);
  }

  const internalNodeId = nextInternalNodeId(parsedNode.label, context);
  const parsedOttId = extractOttId(parsedNode.label);
  const displayName =
    cleanOpenTreeLabel(parsedNode.label) ??
    (parsedOttId !== undefined ? `OpenTree clade ott${parsedOttId}` : `OpenTree clade ${context.internalCounter}`);

  const provenance = [
    buildSourceReference({
      sourceId: 'open-tree-induced-subtree',
      sourceType: 'open-tree',
      ...(parsedOttId !== undefined ? { externalId: `ott${parsedOttId}` } : {}),
      url: 'https://api.opentreeoflife.org/v3/tree_of_life/induced_subtree',
      note: 'Internal clade from OpenTree synthetic induced subtree.'
    })
  ];

  const internalNode: PhyloNode = {
    id: internalNodeId,
    parentId,
    childIds: [],
    kind: 'unnamed-clade',
    displayName,
    ...(parsedOttId !== undefined ? { taxonId: `ott:${parsedOttId}` } : {}),
    isGameEndpoint: false,
    isTargetEligible: false,
    navigationOnly: false,
    extant: true,
    divergenceAgeMa: estimateAgeByDepth(depth),
    traits: [],
    confidence: 'medium',
    provenance
  };

  context.nodesById[internalNodeId] = internalNode;

  const childIds: string[] = [];
  for (const parsedChild of parsedNode.children) {
    const ids = materializeNode(parsedChild, internalNodeId, depth + 1, context);
    childIds.push(...ids);
  }

  if (childIds.length === 0) {
    delete context.nodesById[internalNodeId];
    return [];
  }

  const internalNodeAfterChildren = context.nodesById[internalNodeId];
  if (!internalNodeAfterChildren) {
    throw new Error(`OpenTree internal node missing during finalize: ${internalNodeId}`);
  }

  context.nodesById[internalNodeId] = {
    ...internalNodeAfterChildren,
    childIds: uniqueValues(childIds)
  };

  return [internalNodeId];
}

function materializeLeafNode(
  parsedNode: NewickNode,
  parentId: string,
  context: MaterializeContext
): string[] {
  const ottId = extractOttId(parsedNode.label);
  if (ottId === undefined) {
    return [];
  }

  const targetIds = context.targetIdsByOttId.get(ottId) ?? [];
  if (targetIds.length === 0) {
    return [];
  }

  const createdIds: string[] = [];
  for (const targetId of targetIds) {
    if (context.usedTargetIds.has(targetId)) {
      continue;
    }

    const target = context.targetById.get(targetId);
    if (!target) {
      continue;
    }

    const resolution = context.resolutionsByTargetId.get(targetId);

    const provenance: SourceReference[] = [
      buildSourceReference({
        sourceId: 'species-list',
        sourceType: 'curated',
        note: `Compiled target endpoint from source row: ${target.scientificNameNormalized}`
      }),
      buildSourceReference({
        sourceId: 'open-tree-induced-subtree',
        sourceType: 'open-tree',
        externalId: `ott${ottId}`,
        url: 'https://api.opentreeoflife.org/v3/tree_of_life/induced_subtree',
        note: 'Leaf placement from OpenTree synthetic induced subtree.'
      })
    ];

    if (resolution?.provenance) {
      provenance.push(resolution.provenance);
    }

    context.nodesById[target.id] = {
      id: target.id,
      parentId,
      childIds: [],
      kind: 'named-taxon',
      displayName: target.commonName || target.scientificName,
      scientificName: target.scientificName,
      commonName: target.commonName,
      taxonId: `ott:${ottId}`,
      isGameEndpoint: true,
      isTargetEligible: true,
      navigationOnly: false,
      extant: true,
      divergenceAgeMa: 0,
      traits: [],
      confidence: 'medium',
      provenance
    };

    context.usedTargetIds.add(target.id);
    createdIds.push(target.id);
  }

  return createdIds;
}

function buildUnresolvedBranch(
  unresolvedTargets: ReadonlyArray<TargetSpecies>,
  context: MaterializeContext,
  maxChildrenPerNavigationNode?: number
): string {
  const maxChildren = Math.max(2, maxChildrenPerNavigationNode ?? DEFAULT_MAX_CHILDREN_PER_NAV_NODE);
  const sortedTargets = [...unresolvedTargets].sort((a, b) => a.id.localeCompare(b.id));

  const rootNode: PhyloNode = {
    id: UNRESOLVED_CATALOG_ROOT_ID,
    parentId: ROOT_ID,
    childIds: [],
    kind: 'navigation',
    displayName: 'Unresolved target catalog',
    isGameEndpoint: false,
    isTargetEligible: false,
    navigationOnly: true,
    extant: false,
    divergenceAgeMa: estimateAgeByDepth(1),
    traits: [],
    confidence: 'low',
    provenance: [
      buildSourceReference({
        sourceId: 'species-list-compiler',
        sourceType: 'curated',
        note: 'Generated unresolved branch for targets missing confident OpenTree placement.'
      })
    ],
    navigationExplanation:
      'Only unresolved targets remain here. The main tree is OpenTree-induced for resolved OTT mappings.'
  };

  context.nodesById[UNRESOLVED_CATALOG_ROOT_ID] = rootNode;
  context.usedNodeIds.add(UNRESOLVED_CATALOG_ROOT_ID);

  const children = buildNavigationSubtree({
    parentId: UNRESOLVED_CATALOG_ROOT_ID,
    branchPath: ['unresolved'],
    depth: 2,
    targets: sortedTargets,
    maxChildren,
    nodesById: context.nodesById,
    usedNodeIds: context.usedNodeIds
  });

  context.nodesById[UNRESOLVED_CATALOG_ROOT_ID] = {
    ...rootNode,
    childIds: children
  };

  return UNRESOLVED_CATALOG_ROOT_ID;
}

interface NavigationSubtreeOptions {
  parentId: string;
  branchPath: string[];
  depth: number;
  targets: ReadonlyArray<TargetSpecies>;
  maxChildren: number;
  nodesById: Record<string, PhyloNode>;
  usedNodeIds: Set<string>;
}

function buildNavigationSubtree(options: NavigationSubtreeOptions): string[] {
  const { parentId, branchPath, depth, targets, maxChildren, nodesById, usedNodeIds } = options;

  if (targets.length <= maxChildren) {
    return targets.map((target) => {
      if (!nodesById[target.id]) {
        nodesById[target.id] = {
          id: target.id,
          parentId,
          childIds: [],
          kind: 'named-taxon',
          displayName: target.commonName || target.scientificName,
          scientificName: target.scientificName,
          commonName: target.commonName,
          isGameEndpoint: true,
          isTargetEligible: true,
          navigationOnly: false,
          extant: true,
          divergenceAgeMa: 0,
          traits: [],
          confidence: 'low',
          provenance: [
            buildSourceReference({
              sourceId: 'species-list',
              sourceType: 'curated',
              note: `Fallback unresolved target endpoint: ${target.scientificNameNormalized}`
            })
          ]
        };
      }
      return target.id;
    });
  }

  const childCount = Math.min(maxChildren, Math.ceil(targets.length / maxChildren));
  const chunkSize = Math.ceil(targets.length / childCount);
  const childIds: string[] = [];

  for (let index = 0; index < childCount; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(targets.length, (index + 1) * chunkSize);
    const chunk = targets.slice(start, end);
    if (chunk.length === 0) {
      continue;
    }

    const branchLabel = `${index + 1}`;
    const nodeBaseId = `${parentId}-b${branchLabel}`;
    const nodeId = uniqueNodeId(nodeBaseId, usedNodeIds);
    const navPath = [...branchPath, branchLabel];

    nodesById[nodeId] = {
      id: nodeId,
      parentId,
      childIds: [],
      kind: 'navigation',
      displayName: `Unresolved branch ${navPath.slice(1).join('.')}`,
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: true,
      extant: false,
      divergenceAgeMa: estimateAgeByDepth(depth),
      traits: [],
      confidence: 'low',
      provenance: [
        buildSourceReference({
          sourceId: 'species-list-compiler',
          sourceType: 'curated',
          note: `Generated unresolved navigation branch ${navPath.join('.')}.`
        })
      ],
      navigationExplanation:
        'Generated unresolved branch for targets without stable OpenTree OTT mapping.'
    };

    const descendants = buildNavigationSubtree({
      parentId: nodeId,
      branchPath: navPath,
      depth: depth + 1,
      targets: chunk,
      maxChildren,
      nodesById,
      usedNodeIds
    });

    nodesById[nodeId] = {
      ...nodesById[nodeId],
      childIds: descendants
    };

    childIds.push(nodeId);
  }

  return childIds;
}

function hydrateInternalLineageMetadata(nodesById: Record<string, PhyloNode>, rootId: string): void {
  const visit = (nodeId: string, depth: number): {
    extantDescendantCount: number;
    representativeNames: string[];
    lineageProvenance: SourceReference[];
  } => {
    const node = nodesById[nodeId];
    if (!node) {
      return {
        extantDescendantCount: 0,
        representativeNames: [],
        lineageProvenance: []
      };
    }

    if (node.childIds.length === 0) {
      return {
        extantDescendantCount: node.extant ? 1 : 0,
        representativeNames: [node.displayName],
        lineageProvenance: [...node.provenance]
      };
    }

    const extantCounts: number[] = [];
    const representativeNames: string[] = [];
    const lineageProvenance: SourceReference[] = [];

    for (const childId of node.childIds) {
      const childSummary = visit(childId, depth + 1);
      extantCounts.push(childSummary.extantDescendantCount);
      representativeNames.push(...childSummary.representativeNames);
      lineageProvenance.push(...childSummary.lineageProvenance);
    }

    const extantDescendantCount = extantCounts.reduce((sum, value) => sum + value, 0);

    if (nodeId !== rootId) {
      const mergedProvenance = mergeProvenance(
        node.provenance,
        lineageProvenance.filter((source) => source.sourceType !== 'curated').slice(0, 6)
      );

      const nextDisplayName =
        node.displayName.startsWith('OpenTree clade') && representativeNames.length > 0
          ? `Clade of ${representativeNames.slice(0, 2).join(' + ')}`
          : node.displayName;

      const lineageTraits =
        node.traits.length > 0
          ? node.traits
          : [
              buildInferredLineageSummaryTrait({
                node,
                displayName: nextDisplayName,
                representativeNames,
                extantDescendantCount,
                mergedProvenance
              })
            ];

      nodesById[nodeId] = {
        ...node,
        displayName: nextDisplayName,
        extant: extantCounts.some((count) => count > 0),
        confidence:
          mergedProvenance.some((source) => source.sourceType === 'open-tree') ? 'medium' : node.confidence,
        divergenceAgeMa: node.divergenceAgeMa ?? estimateAgeByDepth(depth),
        rank: node.rank ?? 'clade',
        provenance: mergedProvenance,
        traits: lineageTraits
      };
    }

    return {
      extantDescendantCount,
      representativeNames: uniqueValues(representativeNames).slice(0, 6),
      lineageProvenance: mergeProvenance(node.provenance, lineageProvenance)
    };
  };

  visit(rootId, 1);
}

function buildInferredLineageSummaryTrait(options: {
  node: PhyloNode;
  displayName: string;
  representativeNames: string[];
  extantDescendantCount: number;
  mergedProvenance: SourceReference[];
}): PhylogeneticTrait {
  const examples = uniqueValues(options.representativeNames).slice(0, 3);
  const confidence = options.mergedProvenance.some((source) => source.sourceType === 'open-tree')
    ? 'medium'
    : 'low';

  return {
    id: `inferred-lineage-summary-${options.node.id}`,
    name: `Lineage summary: ${options.displayName}`,
    description:
      options.extantDescendantCount > 0
        ? `Inferred lineage anchored by ${options.displayName} with sampled descendants ${examples.join(', ') || 'none'} and ${options.extantDescendantCount} extant descendant endpoints represented in this compiled tree.`
        : `Inferred lineage anchored by ${options.displayName} with sampled descendants ${examples.join(', ') || 'none'} and no extant descendant endpoints currently represented in this compiled tree.`,
    traitType: 'inferred',
    confidence,
    provenance: options.mergedProvenance
  };
}

function mergeProvenance(
  base: ReadonlyArray<SourceReference>,
  incoming: ReadonlyArray<SourceReference>
): SourceReference[] {
  const merged = [...base];
  const seen = new Set(base.map((source) => sourceKey(source)));

  for (const source of incoming) {
    const key = sourceKey(source);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(source);
  }

  return merged;
}

function sourceKey(source: SourceReference): string {
  return `${source.sourceId}|${source.externalId ?? ''}|${source.url ?? ''}`;
}

function nextInternalNodeId(label: string | null, context: MaterializeContext): string {
  context.internalCounter += 1;
  const ottId = extractOttId(label);
  const labelStem = cleanOpenTreeLabel(label);

  const baseId =
    ottId !== undefined
      ? `clade-ott-${ottId}`
      : labelStem
        ? `clade-${slugify(labelStem)}`
        : `clade-${context.internalCounter}`;

  const uniqueId = uniqueNodeId(baseId, context.usedNodeIds);
  return uniqueId;
}

function uniqueNodeId(baseId: string, usedNodeIds: Set<string>): string {
  let nextId = baseId;
  let index = 2;
  while (usedNodeIds.has(nextId)) {
    nextId = `${baseId}-${index}`;
    index += 1;
  }
  usedNodeIds.add(nextId);
  return nextId;
}

function estimateAgeByDepth(depth: number): number {
  const clampedDepth = Math.max(1, depth);
  const age = Math.round(ROOT_AGE_MA * Math.pow(0.58, clampedDepth - 1));
  return Math.max(1, age);
}

function buildLucaRootNode(note: string): PhyloNode {
  return {
    id: ROOT_ID,
    parentId: null,
    childIds: [],
    kind: 'ancestral',
    displayName: 'LUCA',
    isGameEndpoint: false,
    isTargetEligible: false,
    navigationOnly: false,
    extant: false,
    divergenceAgeMa: ROOT_AGE_MA,
    traits: [],
    confidence: 'low',
    provenance: [
      buildSourceReference({
        sourceId: 'species-list-compiler',
        sourceType: 'curated',
        note
      })
    ]
  };
}

function buildFallbackCatalogTree(
  targets: ReadonlyArray<TargetSpecies>,
  datasetVersion: string,
  options: { maxChildrenPerNavigationNode?: number }
): ScientificPhylogeny {
  const nodesById: Record<string, PhyloNode> = {
    [ROOT_ID]: buildLucaRootNode('Root anchor for fallback unresolved runtime tree.'),
    [UNRESOLVED_CATALOG_ROOT_ID]: {
      id: UNRESOLVED_CATALOG_ROOT_ID,
      parentId: ROOT_ID,
      childIds: [],
      kind: 'navigation',
      displayName: 'Unresolved target catalog',
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: true,
      extant: false,
      divergenceAgeMa: estimateAgeByDepth(1),
      traits: [],
      confidence: 'low',
      provenance: [
        buildSourceReference({
          sourceId: 'species-list-compiler',
          sourceType: 'curated',
          note: 'Fallback unresolved target catalog generated from species list.'
        })
      ],
      navigationExplanation:
        'Generated fallback topology without OpenTree induced subtree. Internal branches are unresolved navigation nodes.'
    }
  };

  const usedNodeIds = new Set<string>([ROOT_ID, UNRESOLVED_CATALOG_ROOT_ID]);
  const sortedTargets = [...targets].sort((a, b) => a.id.localeCompare(b.id));
  const maxChildren = Math.max(2, options.maxChildrenPerNavigationNode ?? DEFAULT_MAX_CHILDREN_PER_NAV_NODE);

  const childIds = buildNavigationSubtree({
    parentId: UNRESOLVED_CATALOG_ROOT_ID,
    branchPath: ['catalog'],
    depth: 2,
    targets: sortedTargets,
    maxChildren,
    nodesById,
    usedNodeIds
  });

  const catalogRoot = nodesById[UNRESOLVED_CATALOG_ROOT_ID];
  if (!catalogRoot) {
    throw new Error('Fallback unresolved catalog root node was not initialized.');
  }

  nodesById[UNRESOLVED_CATALOG_ROOT_ID] = {
    ...catalogRoot,
    childIds
  };

  const rootNode = nodesById[ROOT_ID];
  if (!rootNode) {
    throw new Error('Fallback root node was not initialized.');
  }

  nodesById[ROOT_ID] = {
    ...rootNode,
    childIds: [UNRESOLVED_CATALOG_ROOT_ID]
  };

  return {
    datasetVersion,
    rootId: ROOT_ID,
    nodesById
  };
}

async function resolveTargetsToOttIds(
  targets: ReadonlyArray<TargetSpecies>,
  options: ExternalLookupOptions,
  onWarning?: ((message: string) => void) | undefined
): Promise<TargetOttResolution[]> {
  const resolutions: TargetOttResolution[] = [];

  for (const target of targets) {
    const outcome = await lookupOpenTreeTnrs(target.scientificName, options);
    const match = outcome.match;

    const status: TargetResolutionStatus = outcome.error
      ? 'lookup-failed'
      : outcome.skippedOffline
        ? 'skipped-offline'
        : match?.ottId !== undefined
          ? 'matched'
          : 'unmatched';

    if (status === 'lookup-failed') {
      onWarning?.(
        `OpenTree name resolution failed for "${target.scientificName}": ${outcome.error}`
      );
    } else if (status === 'unmatched') {
      onWarning?.(`OpenTree returned no name match for "${target.scientificName}"`);
    } else if (status === 'skipped-offline') {
      onWarning?.(
        `OpenTree name resolution skipped for "${target.scientificName}" (offline, no cached match)`
      );
    }

    resolutions.push({
      targetId: target.id,
      scientificName: target.scientificName,
      status,
      ...(match?.ottId !== undefined ? { ottId: match.ottId } : {}),
      ...(match?.matchedName ? { matchedName: match.matchedName } : {}),
      ...(match?.score !== undefined ? { score: match.score } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(match?.provenance ? { provenance: match.provenance } : {})
    });
  }

  return resolutions;
}

interface OpenTreeTnrsMatch {
  ottId?: number | undefined;
  matchedName?: string | undefined;
  score?: number | undefined;
  provenance?: SourceReference | undefined;
}

interface OpenTreeInducedSubtreeResponse {
  newick?: string | undefined;
}

async function lookupOpenTreeTnrs(
  name: string,
  options: ExternalLookupOptions
): Promise<TnrsLookupOutcome> {
  let error: string | undefined;
  let skippedOffline = false;

  const match = await loadCachedOrFetch<OpenTreeTnrsMatch | null>({
    cacheDir: options.cacheDir,
    cacheNamespace: 'open-tree-tnrs',
    key: name,
    online: options.online,
    onFailure: (message) => {
      error = message;
    },
    onOffline: () => {
      skippedOffline = true;
    },
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

      const firstResult = asArray(response['results'])[0];
      if (!firstResult || typeof firstResult !== 'object') {
        return null;
      }

      const firstMatch = asArray((firstResult as Record<string, unknown>)['matches'])[0];
      if (!firstMatch || typeof firstMatch !== 'object') {
        return null;
      }

      const firstMatchRecord = firstMatch as Record<string, unknown>;
      const taxonRecord = asRecord(firstMatchRecord['taxon']);
      const ottId = numericOrUndefined(taxonRecord['ott_id']);
      const matchedName = stringOrUndefined(taxonRecord['unique_name']) ?? stringOrUndefined(taxonRecord['name']);
      const score = numericOrUndefined(firstMatchRecord['score']);

      if (ottId === undefined) {
        return null;
      }

      return {
        ottId,
        ...(matchedName ? { matchedName } : {}),
        ...(score !== undefined ? { score } : {}),
        provenance: buildSourceReference({
          sourceId: 'open-tree-tnrs',
          sourceType: 'open-tree',
          externalId: `ott${ottId}`,
          url,
          retrievedAt: new Date().toISOString(),
          ...(score !== undefined ? { note: `OpenTree TNRS score ${score}` } : {})
        })
      };
    }
  });

  return {
    match,
    ...(error !== undefined ? { error } : {}),
    skippedOffline
  };
}

async function fetchOpenTreeInducedSubtree(
  ottIds: ReadonlyArray<number>,
  options: ExternalLookupOptions,
  onFailure?: ((message: string) => void) | undefined
): Promise<OpenTreeInducedSubtreeResponse | null> {
  const cacheKey = ottIds.map((id) => String(id)).sort().join(',');

  return loadCachedOrFetch<OpenTreeInducedSubtreeResponse | null>({
    cacheDir: options.cacheDir,
    cacheNamespace: 'open-tree-induced-subtree',
    key: cacheKey,
    online: options.online,
    ...(onFailure ? { onFailure } : {}),
    fetcher: async () => {
      const url = 'https://api.opentreeoflife.org/v3/tree_of_life/induced_subtree';
      const response = await fetchJson<Record<string, unknown>>(
        url,
        options,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            ott_ids: [...ottIds]
          })
        }
      );

      const newick = stringOrUndefined(response['newick']);
      return newick ? { newick } : null;
    }
  });
}

async function fetchOpenTreeInducedSubtreeSets(
  ottIds: ReadonlyArray<number>,
  options: ExternalLookupOptions
): Promise<{ newicks: string[]; warnings: string[]; usedAdaptiveChunking: boolean }> {
  const warnings: string[] = [];
  const sortedOttIds = [...ottIds].sort((a, b) => a - b);

  let fullTreeError: string | undefined;
  const fullTree = await fetchOpenTreeInducedSubtree(sortedOttIds, options, (message) => {
    fullTreeError = message;
  });
  if (fullTree?.newick) {
    return {
      newicks: [fullTree.newick],
      warnings,
      usedAdaptiveChunking: false
    };
  }

  warnings.push(
    `OpenTree full induced subtree request did not return a usable topology${
      fullTreeError ? ` (${fullTreeError})` : ''
    }; falling back to adaptive chunking.`
  );

  const newicks = await fetchOpenTreeInducedSubtreesAdaptive(sortedOttIds, options);

  if (newicks.length > 0) {
    warnings.push(
      `OpenTree full induced subtree was unavailable; compiled ${newicks.length} adaptive chunked induced subtrees. Deep relationships between chunks are not resolved.`
    );
  }

  return {
    newicks,
    warnings,
    usedAdaptiveChunking: newicks.length > 0
  };
}

async function fetchOpenTreeInducedSubtreesAdaptive(
  ottIds: ReadonlyArray<number>,
  options: ExternalLookupOptions
): Promise<string[]> {
  if (ottIds.length < 2) {
    return [];
  }

  const single = await fetchOpenTreeInducedSubtree(ottIds, options);
  if (single?.newick) {
    return [single.newick];
  }

  if (ottIds.length <= 4) {
    return [];
  }

  const midpoint = Math.floor(ottIds.length / 2);
  const left = ottIds.slice(0, midpoint);
  const right = ottIds.slice(midpoint);

  const [leftTrees, rightTrees] = await Promise.all([
    fetchOpenTreeInducedSubtreesAdaptive(left, options),
    fetchOpenTreeInducedSubtreesAdaptive(right, options)
  ]);

  return [...leftTrees, ...rightTrees];
}

interface CachedLookupOptions<T> {
  cacheDir: string;
  cacheNamespace: string;
  key: string;
  online: boolean;
  fetcher: () => Promise<T>;
  onFailure?: ((message: string) => void) | undefined;
  onOffline?: (() => void) | undefined;
}

async function loadCachedOrFetch<T>(options: CachedLookupOptions<T>): Promise<T> {
  const cachePath = lookupCachePath(options.cacheDir, options.cacheNamespace, options.key);
  const cached = await readCacheRecord<T>(cachePath);
  if (cached !== null) {
    return cached.value;
  }

  if (!options.online) {
    options.onOffline?.();
    return null as T;
  }

  try {
    const value = await options.fetcher();
    await writeCacheRecord(cachePath, {
      cachedAt: new Date().toISOString(),
      value
    });
    return value;
  } catch (error) {
    options.onFailure?.(error instanceof Error ? error.message : 'unknown error');
    return null as T;
  }
}

function lookupCachePath(cacheDir: string, namespace: string, key: string): string {
  const digest = createHash('sha1').update(key).digest('hex');
  return join(cacheDir, 'external-topology', namespace, `${digest}.json`);
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

      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= maxAttempts) {
        break;
      }
      await delay(240 * Math.pow(2, attempt));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`);
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
    return Math.max(0, asDate - Date.now());
  }

  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseNewick(rawNewick: string): NewickNode {
  const newick = rawNewick.trim();
  let index = 0;

  const parseNode = (): NewickNode => {
    const children: NewickNode[] = [];

    if (newick[index] === '(') {
      index += 1;

      while (index < newick.length) {
        children.push(parseNode());

        const separator = newick[index];
        if (separator === ',') {
          index += 1;
          continue;
        }
        if (separator === ')') {
          index += 1;
          break;
        }
        throw new Error(`Invalid Newick: expected ',' or ')' at position ${index}`);
      }
    }

    const label = parseLabel(newick, () => index, (next) => {
      index = next;
    });

    return {
      label,
      children
    };
  };

  const root = parseNode();

  while (index < newick.length && /\s/.test(newick[index] ?? '')) {
    index += 1;
  }

  if (index < newick.length && newick[index] === ';') {
    index += 1;
  }

  return root;
}

function parseLabel(
  input: string,
  getIndex: () => number,
  setIndex: (next: number) => void
): string | null {
  let index = getIndex();

  while (index < input.length && /\s/.test(input[index] ?? '')) {
    index += 1;
  }

  let token = '';
  if (input[index] === "'") {
    index += 1;
    while (index < input.length && input[index] !== "'") {
      token += input[index] ?? '';
      index += 1;
    }
    if (input[index] === "'") {
      index += 1;
    }
  } else {
    while (index < input.length) {
      const char = input[index];
      if (!char || char === ',' || char === ')' || char === ';') {
        break;
      }
      token += char;
      index += 1;
    }
  }

  const colonIndex = token.indexOf(':');
  const label = (colonIndex >= 0 ? token.slice(0, colonIndex) : token).trim();

  setIndex(index);
  return label.length > 0 ? label : null;
}

function extractOttId(label: string | null): number | undefined {
  if (!label) {
    return undefined;
  }

  const match = /ott(\d+)/i.exec(label);
  if (!match) {
    return undefined;
  }

  const ottId = Number(match[1]);
  return Number.isFinite(ottId) ? ottId : undefined;
}

function cleanOpenTreeLabel(label: string | null): string | undefined {
  if (!label) {
    return undefined;
  }

  const withoutOtt = label.replace(/ott\d+/gi, '');
  const normalized = withoutOtt
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length > 0 ? normalized : undefined;
}

function buildSourceReference(reference: {
  sourceId: string;
  sourceType: SourceReference['sourceType'];
  externalId?: string;
  citation?: string;
  url?: string;
  doi?: string;
  retrievedAt?: string;
  note?: string;
}): SourceReference {
  const source: SourceReference = {
    sourceId: reference.sourceId,
    sourceType: reference.sourceType
  };

  if (reference.externalId !== undefined) {
    source.externalId = reference.externalId;
  }
  if (reference.citation !== undefined) {
    source.citation = reference.citation;
  }
  if (reference.url !== undefined) {
    source.url = reference.url;
  }
  if (reference.doi !== undefined) {
    source.doi = reference.doi;
  }
  if (reference.retrievedAt !== undefined) {
    source.retrievedAt = reference.retrievedAt;
  }
  if (reference.note !== undefined) {
    source.note = reference.note;
  }

  return source;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function numericOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
}

function uniqueValues(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function isNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fallbackTreeOptions(maxChildrenPerNavigationNode?: number): {
  maxChildrenPerNavigationNode?: number;
} {
  return maxChildrenPerNavigationNode !== undefined
    ? { maxChildrenPerNavigationNode }
    : {};
}