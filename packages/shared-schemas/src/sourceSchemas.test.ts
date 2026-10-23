import { describe, expect, it } from 'vitest';

import { SourceTargetSpeciesSchema } from './sourceSchemas';

describe('SourceTargetSpeciesSchema', () => {
  it('accepts valid source rows', () => {
    const row = SourceTargetSpeciesSchema.parse({
      scientificName: 'Panthera tigris'
    });

    expect(row.scientificName).toBe('Panthera tigris');
  });

  it('rejects empty scientific names', () => {
    expect(() =>
      SourceTargetSpeciesSchema.parse({
        scientificName: ' '
      })
    ).toThrow();
  });

  it('rejects authored hydration fields', () => {
    expect(() => SourceTargetSpeciesSchema.parse({
      scientificName: 'Panthera tigris',
      briefDescriptor: 'Authored text'
    })).toThrow();
  });
});
