import type { PhyloNode, ScientificPhylogeny, SourceReference } from '@evo-tree/domain';

export interface PruneLowConfidenceUnaryNodesResult {
  tree: ScientificPhylogeny;
  prunedNodeCount: number;
}

export function pruneLowConfidenceUnaryNodes(
  sourceTree: ScientificPhylogeny
): PruneLowConfidenceUnaryNodesResult {
  const nodesById: Record<string, PhyloNode> = Object.fromEntries(
    Object.entries(sourceTree.nodesById).map(([id, node]) => [
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
  );

  let prunedNodeCount = 0;
  let changed = true;

  while (changed) {
    changed = false;

    for (const nodeId of Object.keys(nodesById)) {
      const node = nodesById[nodeId];
      if (!node) {
        continue;
      }

      if (!isPrunableUnaryInternalNode(node, sourceTree.rootId)) {
        continue;
      }

      const onlyChildId = node.childIds[0];
      if (!onlyChildId) {
        continue;
      }

      const child = nodesById[onlyChildId];
      if (!child) {
        continue;
      }

      const parentId = node.parentId;
      if (parentId) {
        const parent = nodesById[parentId];
        if (parent) {
          parent.childIds = uniqueValues(
            parent.childIds.flatMap((childId) => (childId === nodeId ? [onlyChildId] : [childId]))
          );
        }
      }

      child.parentId = parentId;
      child.provenance = mergeSourceReferences(child.provenance, node.provenance);

      delete nodesById[nodeId];
      prunedNodeCount += 1;
      changed = true;
    }
  }

  const reachable = collectReachableNodeIds(nodesById, sourceTree.rootId);
  const rebuiltNodesById: Record<string, PhyloNode> = {};

  for (const nodeId of reachable) {
    const node = nodesById[nodeId];
    if (!node) {
      continue;
    }

    rebuiltNodesById[nodeId] = {
      ...node,
      childIds: uniqueValues(node.childIds.filter((childId) => reachable.has(childId)))
    };
  }

  return {
    tree: {
      ...sourceTree,
      nodesById: rebuiltNodesById
    },
    prunedNodeCount
  };
}

function isPrunableUnaryInternalNode(node: PhyloNode, rootId: string): boolean {
  if (node.id === rootId) {
    return false;
  }

  if (node.childIds.length !== 1) {
    return false;
  }

  if (node.isGameEndpoint || node.isTargetEligible) {
    return false;
  }

  return node.navigationOnly || node.confidence === 'low' || node.confidence === 'unresolved';
}

function collectReachableNodeIds(
  nodesById: Record<string, PhyloNode>,
  rootId: string
): Set<string> {
  const reachable = new Set<string>();
  const stack = [rootId];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || reachable.has(currentId)) {
      continue;
    }

    const node = nodesById[currentId];
    if (!node) {
      continue;
    }

    reachable.add(currentId);
    for (const childId of node.childIds) {
      stack.push(childId);
    }
  }

  return reachable;
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

function uniqueValues(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}
