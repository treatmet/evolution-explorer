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

export interface SpeciesListRowIssue {
  lineNumber: number;
  content: string;
  reason: string;
}

export interface SpeciesListParseResult {
  targets: TargetSpecies[];
  issues: SpeciesListRowIssue[];
}

export function parseSpeciesListText(rawText: string): TargetSpecies[] {
  const { targets, issues } = parseSpeciesListTextWithDiagnostics(rawText);

  const firstIssue = issues[0];
  if (firstIssue) {
    throw new Error(
      `Invalid species-list row at line ${firstIssue.lineNumber}: ${firstIssue.reason}`
    );
  }

  return targets;
}

export function parseSpeciesListTextWithDiagnostics(rawText: string): SpeciesListParseResult {
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

  const issues: SpeciesListRowIssue[] = [];
  const parsedRows: TargetSpecies[] = [];
  const seenIds = new Set<string>();

  lines.slice(1).forEach((line, index) => {
    const lineNumber = index + 2;
    const parts = line.split('|').map((part) => part.trim());

    if (parts.length !== 3) {
      issues.push({
        lineNumber,
        content: line,
        reason: `expected 3 pipe-separated fields but found ${parts.length}`
      });
      return;
    }

    const candidate = {
      scientificName: parts[0],
      commonName: parts[1],
      briefDescriptor: parts[2]
    };

    const parsed = SourceTargetSpeciesSchema.safeParse(candidate);
    if (!parsed.success) {
      issues.push({
        lineNumber,
        content: line,
        reason: parsed.error.issues.map((issue) => issue.message).join('; ')
      });
      return;
    }

    const normalizedName = normalizeScientificName(parsed.data.scientificName);
    const id = toSpeciesId(normalizedName);

    if (seenIds.has(id)) {
      issues.push({
        lineNumber,
        content: line,
        reason: `duplicate species id generated from scientific names: ${id}`
      });
      return;
    }

    seenIds.add(id);
    parsedRows.push({
      ...parsed.data,
      id,
      scientificNameNormalized: normalizedName
    });
  });

  if (parsedRows.length > 0) {
    const listValidation = SourceTargetSpeciesListSchema.safeParse(parsedRows);
    if (!listValidation.success) {
      throw new Error(`species-list validation failed: ${listValidation.error.message}`);
    }
  }

  return { targets: parsedRows, issues };
}

export async function parseSpeciesListFile(filePath: string): Promise<TargetSpecies[]> {
  const raw = await readFile(filePath, 'utf8');
  return parseSpeciesListText(raw);
}

export async function parseSpeciesListFileWithDiagnostics(
  filePath: string
): Promise<SpeciesListParseResult> {
  const raw = await readFile(filePath, 'utf8');
  return parseSpeciesListTextWithDiagnostics(raw);
}
