import { describe, expect, it } from 'vitest';

import {
  parseSpeciesListFile,
  parseSpeciesListText,
  parseSpeciesListTextWithDiagnostics,
  toSpeciesId
} from './parseSpeciesList';

describe('parseSpeciesList', () => {
  it('parses valid source rows', () => {
    const text = [
      'Scientific name | Common name | Brief descriptor',
      'Panthera tigris | Tiger | Largest living cat',
      'Panthera leo | Lion | Social big cat'
    ].join('\n');

    const parsed = parseSpeciesListText(text);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.id).toBe('panthera-tigris');
  });

  it('rejects malformed rows', () => {
    const text = [
      'Scientific name | Common name | Brief descriptor',
      'Panthera tigris | Tiger'
    ].join('\n');

    expect(() => parseSpeciesListText(text)).toThrow(/expected 3 pipe-separated fields/i);
  });

  it('reports unparseable rows as diagnostics while keeping valid rows', () => {
    const text = [
      'Scientific name | Common name | Brief descriptor',
      'Panthera tigris | Tiger | Largest living cat',
      'Panthera leo | Lion',
      'Homo sapiens |  | Modern human',
      'Panthera tigris | Tiger duplicate | Repeated row',
      'Danio rerio | Zebrafish | Striped minnow'
    ].join('\n');

    const { targets, issues } = parseSpeciesListTextWithDiagnostics(text);

    expect(targets.map((target) => target.id)).toEqual(['panthera-tigris', 'danio-rerio']);
    expect(issues).toHaveLength(3);
    expect(issues[0]?.lineNumber).toBe(3);
    expect(issues[0]?.reason).toMatch(/3 pipe-separated fields/i);
    expect(issues[1]?.lineNumber).toBe(4);
    expect(issues[2]?.reason).toMatch(/duplicate species id/i);
  });

  it('creates stable ids from scientific names', () => {
    expect(toSpeciesId('Canis lupus familiaris')).toBe('canis-lupus-familiaris');
    expect(toSpeciesId('  Fragaria × ananassa  ')).toBe('fragaria-ananassa');
  });

  it('parses the workspace species-list file', async () => {
    const parsed = await parseSpeciesListFile('data/source/species-list.txt');

    expect(parsed.length).toBeGreaterThan(0);

    for (const row of parsed) {
      expect(row.scientificName.length).toBeGreaterThan(0);
      expect(row.commonName.length).toBeGreaterThan(0);
      expect(row.briefDescriptor.length).toBeGreaterThan(0);
      expect(row.id).toBe(toSpeciesId(row.scientificNameNormalized));
      expect(row.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }

    expect(new Set(parsed.map((row) => row.id)).size).toBe(parsed.length);
  });

  it('accepts non-species endpoints as target-eligible rows', () => {
    const text = [
      'Scientific name | Common name | Brief descriptor',
      'Copepoda | Copepods | Diverse group of small crustaceans',
      'Marine picoplankton | Marine picoplankton | Smallest drifting marine organisms'
    ].join('\n');

    const parsed = parseSpeciesListText(text);

    expect(parsed.map((row) => row.id)).toEqual(['copepoda', 'marine-picoplankton']);
  });
});
