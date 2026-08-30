import type {
  PhylogeneticTrait,
  PhyloNode,
  ScientificConfidence,
  ScientificPhylogeny,
  SourceReference
} from '@evo-tree/domain';

const NON_INFORMATIVE_LABELS = new Set(['mrca', 'unnamed clade', 'unnamed-clade']);
const OPEN_TREE_PLACEHOLDER_LABEL = /^h\d+(?:-\d+)?$/i;

export interface PlayableScientificTreeResult {
  tree: ScientificPhylogeny;
  skippedNodeCount: number;
  mergedNodeCount: number;
  inferredTraitNodeCount: number;
}

export function buildPlayableScientificTree(
  sourceTree: ScientificPhylogeny
): PlayableScientificTreeResult {
  const sourceRoot = sourceTree.nodesById[sourceTree.rootId];
  if (!sourceRoot) {
    return {
      tree: sourceTree,
      skippedNodeCount: 0,
      mergedNodeCount: 0,
      inferredTraitNodeCount: 0
    };
  }

  const nodesById: Record<string, PhyloNode> = {};
  const visiting = new Set<string>();

  let skippedNodeCount = 0;
  let inferredTraitNodeCount = 0;

  const compressSubtree = (nodeId: string, forceKeep: boolean): string[] => {
    if (visiting.has(nodeId)) {
      return [];
    }

    const node = sourceTree.nodesById[nodeId];
    if (!node) {
      return [];
    }

    visiting.add(nodeId);

    const compressedChildIds = uniqueValues(
      node.childIds.flatMap((childId) => compressSubtree(childId, false))
    );

    const isLeafAfterCompression = compressedChildIds.length === 0;
    const keepNode = forceKeep || shouldKeepNode(node, isLeafAfterCompression);

    if (!keepNode) {
      skippedNodeCount += 1;
      visiting.delete(nodeId);
      return compressedChildIds;
    }

    const traits = hydrateTraits(node, isLeafAfterCompression);
    if (node.traits.length === 0 && traits.length > 0) {
      inferredTraitNodeCount += 1;
    }

    nodesById[node.id] = {
      ...node,
      parentId: null,
      childIds: compressedChildIds,
      traits
    };

    visiting.delete(nodeId);
    return [node.id];
  };

  const retainedRoots = compressSubtree(sourceTree.rootId, true);
  const rootId = retainedRoots[0] ?? sourceTree.rootId;

  if (!nodesById[rootId]) {
    return {
      tree: sourceTree,
      skippedNodeCount,
      mergedNodeCount: 0,
      inferredTraitNodeCount
    };
  }

  const mergedNodeCount = normalizeDuplicateClades(nodesById, rootId);
  const normalizedNodesById = rebuildFromRoot(nodesById, rootId);

  return {
    tree: {
      ...sourceTree,
      rootId,
      nodesById: normalizedNodesById
    },
    skippedNodeCount: skippedNodeCount + mergedNodeCount,
    mergedNodeCount,
    inferredTraitNodeCount
  };
}

function shouldKeepNode(node: PhyloNode, isLeaf: boolean): boolean {
  if (node.navigationOnly) {
    return false;
  }

  const hasInformativeIdentity =
    isInformativeLabel(node.displayName) ||
    isInformativeLabel(node.scientificName) ||
    isInformativeLabel(node.commonName);

  if (isLeaf) {
    return node.isGameEndpoint || node.isTargetEligible || hasInformativeIdentity;
  }

  if (node.traits.length > 0) {
    return true;
  }

  return hasInformativeIdentity;
}

function isInformativeLabel(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (NON_INFORMATIVE_LABELS.has(normalized)) {
    return false;
  }

  if (OPEN_TREE_PLACEHOLDER_LABEL.test(normalized)) {
    return false;
  }

  if (normalized.startsWith('mrca ')) {
    return false;
  }

  return true;
}

function hydrateTraits(node: PhyloNode, isLeaf: boolean): PhylogeneticTrait[] {
  if (node.traits.length > 0) {
    return [...node.traits];
  }

  const anchorName = node.commonName ?? node.scientificName ?? node.displayName;
  const traitName = isLeaf
    ? node.extant
      ? 'Extant lineage endpoint'
      : 'Extinct lineage endpoint'
    : `Lineage anchor: ${anchorName}`;

  return [
    {
      id: `inferred-hydration-${node.id}`,
      name: traitName,
      description: isLeaf
        ? 'Inferred endpoint hydration trait generated from taxonomic placement.'
        : 'Inferred lineage hydration trait generated from taxonomic placement metadata.',
      traitType: 'inferred',
      confidence: node.confidence === 'high' ? 'medium' : 'low',
      provenance: traitProvenance(node)
    }
  ];
}

function traitProvenance(node: PhyloNode): SourceReference[] {
  if (node.provenance.length > 0) {
    return [...node.provenance];
  }

  return [
    {
      sourceId: 'playable-tree-hydrator',
      sourceType: 'curated',
      note:
        'Generated fallback inferred trait because no explicit trait curation was present on this node.'
    }
  ];
}

function uniqueValues(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function normalizeDuplicateClades(nodesById: Record<string, PhyloNode>, rootId: string): number {
  let mergedNodeCount = 0;

  const visit = (nodeId: string): void => {
    const node = nodesById[nodeId];
    if (!node) {
      return;
    }

    for (const childId of [...node.childIds]) {
      visit(childId);
    }

    node.childIds = uniqueValues(node.childIds.filter((childId) => Boolean(nodesById[childId])));

    const groupedByKey = new Map<string, string[]>();
    for (const childId of node.childIds) {
      const child = nodesById[childId];
      if (!child) {
        continue;
      }

      const key = duplicateMergeKey(child);
      if (!key) {
        continue;
      }

      const existing = groupedByKey.get(key) ?? [];
      existing.push(childId);
      groupedByKey.set(key, existing);
    }

    let nextChildIds = [...node.childIds];
    for (const groupIds of groupedByKey.values()) {
      if (groupIds.length < 2) {
        continue;
      }

      const canonicalId = selectCanonicalNodeId(groupIds, nodesById);
      const canonical = nodesById[canonicalId];
      if (!canonical) {
        continue;
      }

      for (const duplicateId of groupIds) {
        if (duplicateId === canonicalId) {
          continue;
        }

        const duplicate = nodesById[duplicateId];
        if (!duplicate) {
          continue;
        }

        canonical.childIds = uniqueValues([...canonical.childIds, ...duplicate.childIds]);
        canonical.traits = mergeTraits(canonical.traits, duplicate.traits);
        canonical.provenance = mergeSourceReferences(canonical.provenance, duplicate.provenance);
        canonical.extant = canonical.extant || duplicate.extant;
        canonical.isGameEndpoint = canonical.isGameEndpoint || duplicate.isGameEndpoint;
        canonical.isTargetEligible = canonical.isTargetEligible || duplicate.isTargetEligible;
        canonical.confidence = bestConfidence(canonical.confidence, duplicate.confidence);

        delete nodesById[duplicateId];
        mergedNodeCount += 1;
        nextChildIds = nextChildIds.map((id) => (id === duplicateId ? canonicalId : id));
      }
    }

    node.childIds = uniqueValues(nextChildIds.filter((childId) => Boolean(nodesById[childId])));

    while (node.id !== rootId && node.childIds.length === 1) {
      const onlyChildId = node.childIds[0];
      if (!onlyChildId) {
        break;
      }

      const child = nodesById[onlyChildId];
      if (!child || !canCollapseUnaryChain(node, child)) {
        break;
      }

      node.childIds = uniqueValues(child.childIds);
      node.traits = mergeTraits(node.traits, child.traits);
      node.provenance = mergeSourceReferences(node.provenance, child.provenance);
      node.extant = node.extant || child.extant;
      node.isGameEndpoint = node.isGameEndpoint || child.isGameEndpoint;
      node.isTargetEligible = node.isTargetEligible || child.isTargetEligible;
      node.confidence = bestConfidence(node.confidence, child.confidence);

      delete nodesById[onlyChildId];
      mergedNodeCount += 1;
    }
  };

  visit(rootId);
  return mergedNodeCount;
}

function rebuildFromRoot(
  nodesById: Record<string, PhyloNode>,
  rootId: string
): Record<string, PhyloNode> {
  const parentByNodeId = new Map<string, string | null>([[rootId, null]]);
  const visited = new Set<string>();
  const stack = [rootId];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) {
      continue;
    }

    const currentNode = nodesById[currentId];
    if (!currentNode) {
      continue;
    }

    visited.add(currentId);
    currentNode.childIds = uniqueValues(
      currentNode.childIds.filter((childId) => childId !== currentId && Boolean(nodesById[childId]))
    );

    for (const childId of currentNode.childIds) {
      if (!parentByNodeId.has(childId)) {
        parentByNodeId.set(childId, currentId);
      }
      stack.push(childId);
    }
  }

  const rebuilt: Record<string, PhyloNode> = {};
  for (const nodeId of visited) {
    const node = nodesById[nodeId];
    if (!node) {
      continue;
    }

    rebuilt[nodeId] = {
      ...node,
      parentId: parentByNodeId.get(nodeId) ?? null,
      childIds: node.childIds.filter((childId) => visited.has(childId))
    };
  }

  return rebuilt;
}

function duplicateMergeKey(node: PhyloNode): string | null {
  if (node.childIds.length === 0 || node.isGameEndpoint || node.isTargetEligible) {
    return null;
  }

  const scientific = normalizeLabel(node.scientificName);
  if (scientific && isInformativeLabel(scientific)) {
    return `name:${scientific}`;
  }

  const display = normalizeLabel(node.displayName);
  if (display && isInformativeLabel(display)) {
    return `name:${display}`;
  }

  const common = normalizeLabel(node.commonName);
  if (common && isInformativeLabel(common)) {
    return `name:${common}`;
  }

  if (node.taxonId) {
    return `taxon:${node.taxonId.toLowerCase()}`;
  }

  return null;
}

function selectCanonicalNodeId(
  ids: ReadonlyArray<string>,
  nodesById: Record<string, PhyloNode>
): string {
  const ranked = [...ids].sort((leftId, rightId) => {
    const left = nodesById[leftId];
    const right = nodesById[rightId];
    if (!left || !right) {
      return leftId.localeCompare(rightId);
    }

    const leftScore = left.childIds.length * 4 + left.traits.length * 3 + left.provenance.length;
    const rightScore = right.childIds.length * 4 + right.traits.length * 3 + right.provenance.length;
    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }

    return leftId.localeCompare(rightId);
  });

  return ranked[0] ?? ids[0] ?? '';
}

function canCollapseUnaryChain(parent: PhyloNode, child: PhyloNode): boolean {
  if (child.childIds.length === 0) {
    return false;
  }

  if (parent.isGameEndpoint || child.isGameEndpoint || parent.isTargetEligible || child.isTargetEligible) {
    return false;
  }

  const parentKey = duplicateMergeKey(parent);
  const childKey = duplicateMergeKey(child);

  if (!parentKey || !childKey) {
    return false;
  }

  return parentKey === childKey;
}

function mergeTraits(
  base: ReadonlyArray<PhylogeneticTrait>,
  incoming: ReadonlyArray<PhylogeneticTrait>
): PhylogeneticTrait[] {
  const merged = [...base];
  const seen = new Set(base.map((trait) => trait.id));

  for (const trait of incoming) {
    if (seen.has(trait.id)) {
      continue;
    }
    seen.add(trait.id);
    merged.push(trait);
  }

  return merged;
}

function mergeSourceReferences(
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

function bestConfidence(a: ScientificConfidence, b: ScientificConfidence): ScientificConfidence {
  const rank: Record<ScientificConfidence, number> = {
    unresolved: 0,
    low: 1,
    medium: 2,
    high: 3
  };

  return rank[b] > rank[a] ? b : a;
}

function normalizeLabel(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized : undefined;
}