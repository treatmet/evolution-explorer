import type { NodeNameForm, PhyloNode } from './types';

export const DEFAULT_NODE_NAME_FORM: NodeNameForm = 'singular';

/** Single source of truth for node labels so canvas and panels cannot drift apart. */
export function resolveNodeLabel(
  node: Pick<PhyloNode, 'displayName' | 'names'>,
  form: NodeNameForm = DEFAULT_NODE_NAME_FORM
): string {
  const names = node.names;
  if (!names) {
    return node.displayName;
  }

  return names[form] || names.singular || node.displayName;
}
