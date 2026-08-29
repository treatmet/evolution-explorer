import type { TargetSpecies } from '../types';
import type { ScientificPhylogeny } from '@evo-tree/domain';
import type { MediaEnrichmentArtifact } from '../media/types';

export interface SourceSnapshot {
  sourceId: string;
  sourceType: string;
  sourcePath: string;
  cachePath: string;
  fetchedAtIso: string;
  recordCount: number;
  contentHash: string;
}

export interface DatasetManifest {
  datasetVersion: string;
  generatedAt: string;
  sourceSnapshots: SourceSnapshot[];
  speciesCount: number;
  nodeCount: number;
  validationStatus: 'candidate' | 'approved';
}

export interface DatasetArtifact {
  manifest: DatasetManifest;
  scientificPhylogeny: ScientificPhylogeny;
  targets: TargetSpecies[];
  mediaEnrichment?: MediaEnrichmentArtifact;
}

export interface DatasetDiff {
  addedTargetIds: string[];
  removedTargetIds: string[];
  changedTargetIds: string[];
  unchangedTargetIds: string[];
}

export interface RefreshPaths {
  sourceSpeciesListPath: string;
  cacheDir: string;
  candidateDir: string;
  approvedDir: string;
}

export interface RefreshOptions {
  promoteToApproved?: boolean;
  now?: Date;
  mediaOnline?: boolean;
  mediaTargetLimit?: number;
  mediaTimeoutMs?: number;
  mediaRetries?: number;
  mediaUserAgent?: string;
  progress?: boolean;
  progressIntervalPercent?: number;
}

export interface RefreshSummary {
  sourceCount: number;
  candidateVersion: string;
  generatedAt: string;
  cacheSnapshotPath: string;
  candidateArtifactPath: string;
  diffReportPath: string;
  diff: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
  media: {
    online: boolean;
    assetCount: number;
    nodesWithMedia: number;
    reconstructionQueueCount: number;
    providerRequestCount: number;
    providerFailureCount: number;
  };
  promotedToApproved: boolean;
  approvedArtifactPath: string | null;
  warnings: string[];
}

export interface RefreshResult {
  summary: RefreshSummary;
  candidate: DatasetArtifact;
  baselineApproved: DatasetArtifact | null;
  diff: DatasetDiff;
}
