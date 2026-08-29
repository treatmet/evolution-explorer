import type {
  ScientificConfidence,
  SourceReference,
  TargetDifficultyMetadata
} from '@evo-tree/domain';

export type MediaAssetKind =
  | 'extant-photo'
  | 'extinct-illustration'
  | 'silhouette'
  | 'reconstruction';

export interface MediaAssetAttribution {
  providerId: string;
  sourceRecordId?: string | undefined;
  sourceUrl?: string | undefined;
  creatorName?: string | undefined;
  attributionText: string;
  licenseCode: string;
  licenseName: string;
  licenseUrl?: string | undefined;
}

export interface MediaAssetRecord {
  assetId: string;
  nodeId: string;
  kind: MediaAssetKind;
  url: string;
  thumbnailUrl?: string | undefined;
  title?: string | undefined;
  confidence: ScientificConfidence;
  retrievedAt: string;
  attribution: MediaAssetAttribution;
  provenance: SourceReference[];
}

export interface NodeMediaRecord {
  nodeId: string;
  primaryAssetId: string | null;
  assetIds: string[];
}

export interface ReconstructionQueueEntry {
  nodeId: string;
  prompt: string;
  promptVersion: string;
  generationModel: string;
  status: 'pending-review' | 'generated';
  evidenceBasis: string[];
  requestedAt: string;
}

export interface ProviderSnapshot {
  providerId: string;
  requests: number;
  cacheHits: number;
  successes: number;
  failures: number;
  notes: string[];
}

export interface MediaEnrichmentArtifact {
  generatedAt: string;
  providerSnapshots: ProviderSnapshot[];
  assetsById: Record<string, MediaAssetRecord>;
  nodeMediaByNodeId: Record<string, NodeMediaRecord>;
  reconstructionQueue: ReconstructionQueueEntry[];
  targetDifficultyMetadata: TargetDifficultyMetadata[];
}

export interface MediaEnrichmentResult {
  media: MediaEnrichmentArtifact;
  warnings: string[];
}

export interface MediaEnrichmentProgress {
  processedTargets: number;
  totalTargets: number;
  percent: number;
}

export interface MediaEnrichmentOptions {
  cacheDir: string;
  online: boolean;
  maxTargets: number;
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
  now?: Date;
  onProgress?: ((update: MediaEnrichmentProgress) => void) | undefined;
  progressIntervalPercent?: number | undefined;
}

export interface TaxonomyMatch {
  canonicalName?: string | undefined;
  rank?: string | undefined;
  taxonId?: string | undefined;
  openTreeOttId?: number | undefined;
  gbifUsageKey?: number | undefined;
  likelyExtinct?: boolean | undefined;
  extinctionAgeMa?: number | undefined;
  provenance: SourceReference[];
}

export interface MediaCandidate {
  kind: Exclude<MediaAssetKind, 'reconstruction'>;
  url: string;
  thumbnailUrl?: string | undefined;
  title?: string | undefined;
  confidence: ScientificConfidence;
  attribution: MediaAssetAttribution;
  provenance: SourceReference[];
}
