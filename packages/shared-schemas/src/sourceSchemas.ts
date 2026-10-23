import { z } from 'zod';

export const speciesListHeader = 'Scientific name';

export const SourceTargetSpeciesSchema = z.object({
  scientificName: z.string().trim().min(1)
}).strict();

export const SourceTargetSpeciesListSchema = z.array(SourceTargetSpeciesSchema).min(1);

export type SourceTargetSpecies = z.infer<typeof SourceTargetSpeciesSchema>;
