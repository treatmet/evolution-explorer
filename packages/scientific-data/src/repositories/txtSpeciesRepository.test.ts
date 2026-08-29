import { describe, expect, it } from 'vitest';

import { TxtSpeciesRepository } from './txtSpeciesRepository';

describe('TxtSpeciesRepository', () => {
  it('lists targets and gets by id', async () => {
    const repo = new TxtSpeciesRepository('data/source/species-list.txt');

    const list = await repo.listTargets();
    expect(list.length).toBeGreaterThan(900);

    const tiger = await repo.getTarget('panthera-tigris');
    expect(tiger?.scientificName).toBe('Panthera tigris');
  });
});
