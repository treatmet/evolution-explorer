import type { PhyloNode, ScientificPhylogeny, SourceReference } from '@evo-tree/domain';

import type { TargetSpecies } from '../types';

const ROOT_ID = 'luca';
const CATALOG_ROOT_ID = 'target-catalog-root';
const MAX_CHILDREN_PER_NAV_NODE = 6;
const ROOT_AGE_MA = 3900;

interface BuildCatalogTreeOptions {
  datasetVersion: string;
  maxChildrenPerNavigationNode?: number;
}

export function buildCatalogScientificPhylogeny(
  targets: ReadonlyArray<TargetSpecies>,
  options: BuildCatalogTreeOptions
): ScientificPhylogeny {
  if (targets.length === 0) {
    throw new Error('Cannot compile scientific phylogeny from an empty target list.');
  }

  const maxChildren = Math.max(2, options.maxChildrenPerNavigationNode ?? MAX_CHILDREN_PER_NAV_NODE);
  const sortedTargets = [...targets].sort((a, b) => a.id.localeCompare(b.id));

  const nodesById: Record<string, PhyloNode> = {};

  nodesById[ROOT_ID] = buildAncestralRootNode();
  nodesById[CATALOG_ROOT_ID] = buildCatalogRootNode();

  const catalogChildren = buildNavigationSubtree({
    parentId: CATALOG_ROOT_ID,
    branchPath: ['catalog'],
    depth: 1,
    targets: sortedTargets,
    maxChildren,
    nodesById
  });

  nodesById[CATALOG_ROOT_ID] = {
    ...nodesById[CATALOG_ROOT_ID],
    childIds: catalogChildren
  };

  nodesById[ROOT_ID] = {
    ...nodesById[ROOT_ID],
    childIds: [CATALOG_ROOT_ID]
  };

  return {
    datasetVersion: options.datasetVersion,
    rootId: ROOT_ID,
    nodesById
  };
}

interface BuildNavigationSubtreeOptions {
  parentId: string;
  branchPath: string[];
  depth: number;
  targets: ReadonlyArray<TargetSpecies>;
  maxChildren: number;
  nodesById: Record<string, PhyloNode>;
}

function buildNavigationSubtree(options: BuildNavigationSubtreeOptions): string[] {
  const {
    parentId,
    branchPath,
    depth,
    targets,
    maxChildren,
    nodesById
  } = options;

  if (targets.length <= maxChildren) {
    return targets.map((target) => {
      nodesById[target.id] = buildTargetLeafNode(target, parentId);
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
    const navNodeId = `${parentId}-b${branchLabel}`;
    const navPath = [...branchPath, branchLabel];

    const navNode: PhyloNode = {
      id: navNodeId,
      parentId,
      childIds: [],
      kind: 'navigation',
      displayName: `Catalog branch ${navPath.slice(1).join('.')}`,
      isGameEndpoint: false,
      isTargetEligible: false,
      navigationOnly: true,
      extant: false,
      divergenceAgeMa: estimateNavigationAgeMa(depth),
      traits: [],
      confidence: 'low',
      provenance: [generatedProvenance(navPath)],
      navigationExplanation:
        'Generated navigation-only branch that partitions species-list targets without claiming phylogenetic resolution.'
    };

    nodesById[navNodeId] = navNode;

    const descendants = buildNavigationSubtree({
      parentId: navNodeId,
      branchPath: navPath,
      depth: depth + 1,
      targets: chunk,
      maxChildren,
      nodesById
    });

    nodesById[navNodeId] = {
      ...nodesById[navNodeId],
      childIds: descendants
    };

    childIds.push(navNodeId);
  }

  return childIds;
}

function buildAncestralRootNode(): PhyloNode {
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
      {
        sourceId: 'species-list-compiler',
        sourceType: 'curated',
        note: 'Root anchor for provisional species-list-derived runtime tree.'
      }
    ]
  };
}

function buildCatalogRootNode(): PhyloNode {
  return {
    id: CATALOG_ROOT_ID,
    parentId: ROOT_ID,
    childIds: [],
    kind: 'navigation',
    displayName: 'Unresolved target catalog',
    isGameEndpoint: false,
    isTargetEligible: false,
    navigationOnly: true,
    extant: false,
    divergenceAgeMa: estimateNavigationAgeMa(1),
    traits: [],
    confidence: 'low',
    provenance: [generatedProvenance(['catalog'])],
    navigationExplanation:
      'Generated from species-list endpoint catalog. Internal branches are navigation-only and not scientific topology claims.'
  };
}

function buildTargetLeafNode(target: TargetSpecies, parentId: string): PhyloNode {
  return {
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
      {
        sourceId: 'species-list',
        sourceType: 'curated',
        note: `Compiled target endpoint from source row: ${target.scientificNameNormalized}`
      }
    ]
  };
}

function estimateNavigationAgeMa(depth: number): number {
  const clampedDepth = Math.max(1, depth);
  const age = Math.round(ROOT_AGE_MA * Math.pow(0.42, clampedDepth - 1));
  return Math.max(5, age);
}

function generatedProvenance(branchPath: string[]): SourceReference {
  return {
    sourceId: 'species-list-compiler',
    sourceType: 'curated',
    note: `Generated navigation branch ${branchPath.join('.')} from species-list target catalog.`
  };
}
