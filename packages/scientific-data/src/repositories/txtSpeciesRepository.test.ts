import { describe, expect, it } from 'vitest';

import { TxtSpeciesRepository } from './txtSpeciesRepository';

describe('TxtSpeciesRepository', () => {
  it('lists targets and gets by id', async () => {
    const repo = new TxtSpeciesRepository('data/source/species-list.txt');

    const list = await repo.listTargets();
    expect(list.length).toBeGreaterThan(0);

    const first = list[0];
    expect(first).toBeDefined();

    const found = await repo.getTarget(first!.id);
    expect(found?.scientificName).toBe(first!.scientificName);

    expect(await repo.getTarget('not-a-real-species-id')).toBeNull();
  });
});
