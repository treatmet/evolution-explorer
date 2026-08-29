import { readFile } from 'node:fs/promises';

import {
  SourceTargetSpeciesListSchema,
  SourceTargetSpeciesSchema,
  speciesListHeader
} from '@evo-tree/shared-schemas';

import type { TargetSpecies } from '../types';

function normalizeScientificName(scientificName: string): string {
  return scientificName.trim().replace(/\s+/g, ' ');
}

export function toSpeciesId(scientificName: string): string {
  return normalizeScientificName(scientificName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseSpeciesListText(rawText: string): TargetSpecies[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('species-list is empty.');
  }

  const header = lines[0];
  if (header !== speciesListHeader) {
    throw new Error(`species-list header mismatch. Expected: "${speciesListHeader}".`);
  }

  const parsedRows = lines.slice(1).map((line, index) => {
    const lineNumber = index + 2;
    const parts = line.split('|').map((part) => part.trim());

    if (parts.length !== 3) {
      throw new Error(
        `Invalid species-list row at line ${lineNumber}: expected 3 pipe-separated fields.`
      );
    }

    const candidate = {
      scientificName: parts[0],
      commonName: parts[1],
      briefDescriptor: parts[2]
    };

    const parsed = SourceTargetSpeciesSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(
        `Invalid species-list row at line ${lineNumber}: ${parsed.error.issues
          .map((issue) => issue.message)
          .join('; ')}`
      );
    }

    const normalizedName = normalizeScientificName(parsed.data.scientificName);

    return {
      ...parsed.data,
      id: toSpeciesId(normalizedName),
      scientificNameNormalized: normalizedName
    };
  });

  const listValidation = SourceTargetSpeciesListSchema.safeParse(parsedRows);
  if (!listValidation.success) {
    throw new Error(`species-list validation failed: ${listValidation.error.message}`);
  }

  const ids = new Set<string>();
  for (const row of parsedRows) {
    if (ids.has(row.id)) {
      throw new Error(`Duplicate species id generated from scientific names: ${row.id}`);
    }

    ids.add(row.id);
  }

  return parsedRows;
}

export async function parseSpeciesListFile(filePath: string): Promise<TargetSpecies[]> {
  const raw = await readFile(filePath, 'utf8');
  return parseSpeciesListText(raw);
}
