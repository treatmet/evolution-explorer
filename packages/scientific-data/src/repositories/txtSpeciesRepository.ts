import { parseSpeciesListFile } from '../parsing/parseSpeciesList';
import type { SpeciesRepository, TargetSpecies } from '../types';

export class TxtSpeciesRepository implements SpeciesRepository {
  private readonly sourcePath: string;
  private cache: TargetSpecies[] | null = null;

  constructor(sourcePath: string) {
    this.sourcePath = sourcePath;
  }

  async listTargets(): Promise<TargetSpecies[]> {
    if (!this.cache) {
      this.cache = await parseSpeciesListFile(this.sourcePath);
    }

    return this.cache;
  }

  async getTarget(id: string): Promise<TargetSpecies | null> {
    const targets = await this.listTargets();
    const match = targets.find((target) => target.id === id);
    return match ?? null;
  }
}
