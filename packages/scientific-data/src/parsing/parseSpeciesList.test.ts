import { describe, expect, it } from 'vitest';

import { parseSpeciesListFile, parseSpeciesListText, toSpeciesId } from './parseSpeciesList';

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

  it('creates stable ids from scientific names', () => {
    expect(toSpeciesId('Canis lupus familiaris')).toBe('canis-lupus-familiaris');
    expect(toSpeciesId('  Fragaria × ananassa  ')).toBe('fragaria-ananassa');
  });

  it('parses the workspace species-list file', async () => {
    const parsed = await parseSpeciesListFile('data/source/species-list.txt');

    expect(parsed.length).toBeGreaterThan(900);
    expect(parsed.some((row) => row.scientificName === 'Homo sapiens')).toBe(true);
    expect(parsed.some((row) => row.scientificName === 'Dickinsonia costata')).toBe(true);
  });

  it('accepts non-species endpoints as target-eligible rows', async () => {
    const parsed = await parseSpeciesListFile('data/source/species-list.txt');

    const copepoda = parsed.find((row) => row.scientificName === 'Copepoda');
    const marinePicoplankton = parsed.find(
      (row) => row.scientificName === 'Marine picoplankton'
    );

    expect(copepoda).toBeDefined();
    expect(copepoda?.id).toBe('copepoda');
    expect(marinePicoplankton).toBeDefined();
    expect(marinePicoplankton?.id).toBe('marine-picoplankton');
  });
});
