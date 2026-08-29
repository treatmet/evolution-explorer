import type { SourceTargetSpecies } from '@evo-tree/shared-schemas';

export interface TargetSpecies extends SourceTargetSpecies {
  id: string;
  scientificNameNormalized: string;
}

export interface SpeciesRepository {
  listTargets(): Promise<TargetSpecies[]>;
  getTarget(id: string): Promise<TargetSpecies | null>;
}
