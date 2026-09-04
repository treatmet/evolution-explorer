import {
  parseSpeciesListFile,
  parseSpeciesListFileWithDiagnostics,
  type SpeciesListParseResult
} from '../parsing/parseSpeciesList';
import type { TargetSpecies } from '../types';

export interface TargetSourceAdapter {
  sourceId: string;
  sourceType: string;
  sourcePath: string;
  loadTargets(): Promise<TargetSpecies[]>;
  loadTargetsWithDiagnostics?(): Promise<SpeciesListParseResult>;
}

export class TxtSpeciesListAdapter implements TargetSourceAdapter {
  readonly sourceId = 'species-list';
  readonly sourceType = 'txt-species-list';
  readonly sourcePath: string;

  constructor(sourcePath: string) {
    this.sourcePath = sourcePath;
  }

  async loadTargets(): Promise<TargetSpecies[]> {
    return parseSpeciesListFile(this.sourcePath);
  }

  async loadTargetsWithDiagnostics(): Promise<SpeciesListParseResult> {
    return parseSpeciesListFileWithDiagnostics(this.sourcePath);
  }
}
