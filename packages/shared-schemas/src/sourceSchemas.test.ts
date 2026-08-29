import { describe, expect, it } from 'vitest';

import { SourceTargetSpeciesSchema } from './sourceSchemas';

describe('SourceTargetSpeciesSchema', () => {
  it('accepts valid source rows', () => {
    const row = SourceTargetSpeciesSchema.parse({
      scientificName: 'Panthera tigris',
      commonName: 'Tiger',
      briefDescriptor: 'Largest living cat'
    });

    expect(row.commonName).toBe('Tiger');
  });

  it('rejects empty descriptors', () => {
    expect(() =>
      SourceTargetSpeciesSchema.parse({
        scientificName: 'Panthera tigris',
        commonName: 'Tiger',
        briefDescriptor: ' '
      })
    ).toThrow();
  });
});
