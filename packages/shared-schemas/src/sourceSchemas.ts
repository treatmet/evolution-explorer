import { z } from 'zod';

export const speciesListHeader =
  'Scientific name | Common name | Brief descriptor';

export const SourceTargetSpeciesSchema = z.object({
  scientificName: z.string().trim().min(1),
  commonName: z.string().trim().min(1),
  briefDescriptor: z.string().trim().min(1)
});

export const SourceTargetSpeciesListSchema = z.array(SourceTargetSpeciesSchema).min(1);

export type SourceTargetSpecies = z.infer<typeof SourceTargetSpeciesSchema>;
