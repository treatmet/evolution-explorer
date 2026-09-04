export type ScientificConfidence = 'high' | 'medium' | 'low' | 'unresolved';

export type PhyloNodeKind =
  | 'ancestral'
  | 'named-taxon'
  | 'unnamed-clade'
  | 'navigation';

export interface SourceReference {
  sourceId: string;
  sourceType:
    | 'open-tree'
    | 'gbif'
    | 'paleobiodb'
    | 'primary-literature'
    | 'curated'
    | 'other';
  externalId?: string;
  citation?: string;
  url?: string;
  doi?: string;
  retrievedAt?: string;
  note?: string;
}

export interface PhylogeneticTrait {
  id: string;
  name: string;
  description: string;
  traitType: 'synapomorphy' | 'characteristic' | 'inferred';
  confidence: ScientificConfidence;
  provenance: SourceReference[];
}

export interface ReconstructionMedia {
  assetId: string;
  url: string;
  generationModel: string;
  prompt: string;
  promptVersion: string;
  reviewStatus: 'generated' | 'pending-review' | 'approved' | 'rejected';
  scientificConfidence: 'high' | 'medium' | 'low' | 'speculative';
  evidenceBasis: string[];
  sourceNodeIds: string[];
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
}

export interface PhyloNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  kind: PhyloNodeKind;
  displayName: string;
  description?: string;
  scientificName?: string;
  commonName?: string;
  rank?: string;
  taxonId?: string;
  isGameEndpoint: boolean;
  isTargetEligible: boolean;
  navigationOnly: boolean;
  extant: boolean;
  divergenceAgeMa?: number;
  divergenceAgeMinMa?: number;
  divergenceAgeMaxMa?: number;
  extinctionAgeMa?: number;
  traits: PhylogeneticTrait[];
  confidence: ScientificConfidence;
  provenance: SourceReference[];
  reconstruction?: ReconstructionMedia;
  navigationExplanation?: string;
}

export interface ScientificPhylogeny {
  rootId: string;
  nodesById: Record<string, PhyloNode>;
  datasetVersion: string;
}

export interface GameProjectionOptions {
  desiredDecisionCount: number;
  maxChoicesPerDecision: number;
  preserveScientificallyImportantNodes: boolean;
  preserveUncertainNodes: boolean;
}

export interface DifficultyConfig {
  masterDifficulty: number;
  evolutionDepth: number;
  targetFamiliarity: number;
  maxChoicesPerDecision: number;
  backtrackingEnabled: boolean;
}

export interface TargetDifficultyMetadata {
  speciesId: string;
  familiarityScore: number;
  difficultyWeight?: number;
}
