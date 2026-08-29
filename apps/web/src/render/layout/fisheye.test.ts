import { describe, expect, it } from 'vitest';

import type { RenderNode } from '@evo-tree/renderer-contracts';

import { applySemanticFisheye } from './fisheye';

function node(id: string, y: number): RenderNode {
  return {
    id,
    parentId: null,
    childIds: [],
    worldX: 0,
    baseWorldY: y,
    fisheyeTargetY: y,
    renderedWorldY: y,
    subtreeMinY: y,
    subtreeMaxY: y,
    descendantLeafCount: 1,
    label: id,
    labelPriority: 1,
    semanticImportance: 1,
    isCurrent: false,
    isHovered: false,
    isOnVisitedPath: false
  };
}

describe('applySemanticFisheye', () => {
  it('preserves vertical order after focus transform', () => {
    const nodes = [node('a', 0), node('b', 50), node('c', 100), node('d', 200)];

    const transformed = applySemanticFisheye(nodes, 'c', 0.5);
    const sorted = [...transformed].sort((left, right) => left.baseWorldY - right.baseWorldY);

    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i - 1]!.fisheyeTargetY <= sorted[i]!.fisheyeTargetY).toBe(true);
    }
  });
});
