import type { RenderNode } from '@evo-tree/renderer-contracts';

export function computeOrderPreservingFisheyeTarget(
  baseY: number,
  focusY: number,
  focusStrength: number
): number {
  const normalizedStrength = Math.max(0, Math.min(1, focusStrength));
  const alpha = 1 - normalizedStrength * 0.22;
  const distance = baseY - focusY;
  const sign = Math.sign(distance);
  const absDistance = Math.abs(distance);

  const linearComponent = distance * (1 - normalizedStrength * 0.25);
  const nonLinearComponent =
    sign * Math.pow(absDistance, alpha) * normalizedStrength * 0.25;

  return focusY + linearComponent + nonLinearComponent;
}

export function applySemanticFisheye(
  nodes: ReadonlyArray<RenderNode>,
  focusNodeId: string | null,
  focusStrength = 0.45
): RenderNode[] {
  if (!focusNodeId) {
    return nodes.map((node) => ({
      ...node,
      fisheyeTargetY: node.baseWorldY
    }));
  }

  const focusNode = nodes.find((node) => node.id === focusNodeId);
  if (!focusNode) {
    return nodes.map((node) => ({
      ...node,
      fisheyeTargetY: node.baseWorldY
    }));
  }

  const focusY = focusNode.baseWorldY;

  return nodes.map((node) => ({
    ...node,
    fisheyeTargetY: computeOrderPreservingFisheyeTarget(
      node.baseWorldY,
      focusY,
      focusStrength
    )
  }));
}
