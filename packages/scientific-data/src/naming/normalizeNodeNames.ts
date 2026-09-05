import type { NodeNames, PhyloNode, ScientificPhylogeny } from '@evo-tree/domain';

import type { TargetSpecies } from '../types';
import { deriveVernacularFromCladeName, looksLikeLatinTaxonName } from './morphology';
import { capitalize, pluralize } from './pluralize';

export interface NameOverride {
  singular?: string;
  plural?: string;
  clade?: string;
}

export interface NormalizeNodeNamesOptions {
  /** Keyed by node id or by case-insensitive clade name. */
  overrides?: Record<string, NameOverride>;
  onWarning?: ((message: string) => void) | undefined;
}

export interface NormalizeNodeNamesResult {
  tree: ScientificPhylogeny;
  warnings: string[];
  collisionFallbackCount: number;
}

const DEFAULT_OVERRIDES: Record<string, NameOverride> = {
  luca: { singular: 'LUCA', plural: 'LUCA', clade: 'LUCA' },
  bacteria: { singular: 'Bacterium', plural: 'Bacteria', clade: 'Bacteria' },
  archaea: { singular: 'Archaeon', plural: 'Archaea', clade: 'Archaea' }
};

export function normalizeNodeNames(
  tree: ScientificPhylogeny,
  targets: ReadonlyArray<TargetSpecies>,
  options: NormalizeNodeNamesOptions = {}
): NormalizeNodeNamesResult {
  const warnings: string[] = [];
  const nodesById: Record<string, PhyloNode> = Object.fromEntries(
    Object.entries(tree.nodesById).map(([id, node]) => [id, { ...node }])
  );

  const targetIds = new Set(targets.map((target) => target.id));
  const overrides = { ...DEFAULT_OVERRIDES, ...(options.overrides ?? {}) };

  for (const node of Object.values(nodesById)) {
    node.names = resolveNames(node, targetIds.has(node.id), overrides);
  }

  const collisions = resolveSiblingCollisions(nodesById, tree.rootId);
  for (const message of collisions.warnings) {
    options.onWarning?.(message);
    warnings.push(message);
  }

  return {
    tree: { ...tree, nodesById },
    warnings,
    collisionFallbackCount: collisions.fallbackCount
  };
}

function resolveNames(
  node: PhyloNode,
  isSeedTarget: boolean,
  overrides: Record<string, NameOverride>
): NodeNames {
  const cladeName = stripQualifier(node.scientificName ?? node.displayName);

  const override = overrides[node.id] ?? overrides[cladeName.toLowerCase()];
  if (override) {
    const singular = capitalize(override.singular ?? cladeName);
    return {
      singular,
      plural: capitalize(override.plural ?? pluralize(singular)),
      clade: capitalize(override.clade ?? cladeName),
      provenance: 'curated'
    };
  }

  // Seed endpoints keep the curated common name and stay singular in every form.
  if (isSeedTarget) {
    const singular = capitalize(node.commonName || node.scientificName || node.displayName);
    return {
      singular,
      plural: singular,
      clade: singular,
      provenance: 'seed'
    };
  }

  const clade = capitalize(cladeName);

  // Placeholder labels get their identity from a descendant during runtime compaction.
  if (isPlaceholderLabel(cladeName)) {
    return {
      singular: clade,
      plural: clade,
      clade,
      provenance: 'clade-fallback'
    };
  }

  const vernacular = node.descriptionSource?.articleTitle
    ? stripQualifier(node.descriptionSource.articleTitle)
    : undefined;

  // A Latin title is a taxon name, not a vernacular, so morphology derives the English form.
  const hasVernacular =
    vernacular !== undefined &&
    normalizeForCompare(vernacular) !== normalizeForCompare(cladeName) &&
    !looksLikeLatinTaxonName(vernacular);

  if (hasVernacular && vernacular) {
    const singular = capitalize(vernacular);
    return {
      singular,
      plural: pluralize(singular),
      clade,
      provenance: 'wikipedia-vernacular'
    };
  }

  // Prefer the article's taxon name so the label tracks the description's accepted nomenclature.
  const derived =
    (vernacular ? deriveVernacularFromCladeName(vernacular) : undefined) ??
    deriveVernacularFromCladeName(cladeName);

  if (derived) {
    return {
      singular: derived,
      plural: pluralize(derived),
      clade,
      provenance: 'morphological-rule'
    };
  }

  return {
    singular: clade,
    plural: clade,
    clade,
    provenance: 'clade-fallback'
  };
}

function resolveSiblingCollisions(
  nodesById: Record<string, PhyloNode>,
  rootId: string
): { warnings: string[]; fallbackCount: number } {
  const warnings: string[] = [];
  let fallbackCount = 0;

  for (const parent of Object.values(nodesById)) {
    const siblings = parent.childIds
      .map((childId) => nodesById[childId])
      .filter((child): child is PhyloNode => Boolean(child?.names));

    const grouped = new Map<string, PhyloNode[]>();
    for (const child of siblings) {
      // Placeholders legitimately repeat and take their identity from a descendant later.
      if (isPlaceholderLabel(stripQualifier(child.displayName))) {
        continue;
      }

      const key = (child.names?.singular ?? '').toLowerCase();
      if (!key) {
        continue;
      }
      grouped.set(key, [...(grouped.get(key) ?? []), child]);
    }

    for (const [, colliding] of grouped) {
      if (colliding.length < 2) {
        continue;
      }

      const collidingLabel = colliding[0]?.names?.singular ?? '';
      const labels = colliding.map((child) => child.displayName).join(', ');

      for (const child of colliding) {
        const names = child.names;
        if (!names || names.provenance === 'seed' || names.singular === names.clade) {
          continue;
        }

        child.names = {
          singular: names.clade,
          plural: names.clade,
          clade: names.clade,
          provenance: 'collision-fallback'
        };
        fallbackCount += 1;
      }

      warnings.push(
        `Sibling name collision under "${parent.displayName}": ${labels} all resolved to ` +
          `"${collidingLabel}"; reverted to clade names.`
      );
    }
  }

  const rootNode = nodesById[rootId];
  if (rootNode && !rootNode.names) {
    warnings.push(`Root node ${rootId} did not receive normalized names.`);
  }

  return { warnings, fallbackCount };
}

function stripQualifier(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

function isPlaceholderLabel(value: string): boolean {
  return (
    /^mrca\b/i.test(value) ||
    /^h\d+(?:-\d+)?$/i.test(value) ||
    /^opentree clade\b/i.test(value) ||
    /^clade of\b/i.test(value) ||
    /^unnamed[- ]clade$/i.test(value)
  );
}
