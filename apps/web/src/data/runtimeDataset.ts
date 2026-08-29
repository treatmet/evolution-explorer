import type { ScientificConfidence, ScientificPhylogeny, TargetDifficultyMetadata } from '@evo-tree/domain';

export interface RuntimeDatasetPointer {
  datasetVersion: string;
  fileName: string;
  generatedAt: string;
}

export interface RuntimeTargetSpecies {
  id: string;
  scientificName: string;
  scientificNameNormalized: string;
  commonName: string;
  briefDescriptor: string;
}

export interface RuntimeDatasetArtifact {
  manifest: {
    datasetVersion: string;
    generatedAt: string;
    speciesCount: number;
    nodeCount: number;
    validationStatus: 'candidate' | 'approved';
  };
  scientificPhylogeny?: ScientificPhylogeny;
  targets: RuntimeTargetSpecies[];
  mediaEnrichment?: RuntimeMediaEnrichmentArtifact;
}

export interface RuntimeMediaEnrichmentArtifact {
  generatedAt: string;
  providerSnapshots: RuntimeProviderSnapshot[];
  assetsById: Record<string, RuntimeMediaAssetRecord>;
  nodeMediaByNodeId: Record<string, RuntimeNodeMediaRecord>;
  reconstructionQueue: RuntimeReconstructionQueueEntry[];
  targetDifficultyMetadata: TargetDifficultyMetadata[];
}

export interface RuntimeProviderSnapshot {
  providerId: string;
  requests: number;
  cacheHits: number;
  successes: number;
  failures: number;
  notes: string[];
}

export interface RuntimeNodeMediaRecord {
  nodeId: string;
  primaryAssetId: string | null;
  assetIds: string[];
}

export interface RuntimeMediaAssetRecord {
  assetId: string;
  nodeId: string;
  kind: 'extant-photo' | 'extinct-illustration' | 'silhouette' | 'reconstruction';
  url: string;
  thumbnailUrl?: string;
  title?: string;
  confidence: ScientificConfidence;
  retrievedAt: string;
  attribution: {
    providerId: string;
    sourceRecordId?: string;
    sourceUrl?: string;
    creatorName?: string;
    attributionText: string;
    licenseCode: string;
    licenseName: string;
    licenseUrl?: string;
  };
}

export interface RuntimeReconstructionQueueEntry {
  nodeId: string;
  prompt: string;
  promptVersion: string;
  generationModel: string;
  status: 'pending-review' | 'generated';
  evidenceBasis: string[];
  requestedAt: string;
}

export interface RuntimeDatasetLoadResult {
  artifact: RuntimeDatasetArtifact | null;
  warning: string | null;
}

export async function loadApprovedRuntimeDataset(): Promise<RuntimeDatasetLoadResult> {
  try {
    const pointerResponse = await fetch('/data/approved/latest.json', {
      cache: 'no-store'
    });

    if (!pointerResponse.ok) {
      return {
        artifact: null,
        warning: 'Approved dataset pointer is unavailable; using fixture scientific tree.'
      };
    }

    const pointer = (await pointerResponse.json()) as RuntimeDatasetPointer;
    if (!pointer.fileName) {
      return {
        artifact: null,
        warning: 'Approved dataset pointer is invalid; using fixture scientific tree.'
      };
    }

    const artifactResponse = await fetch(`/data/approved/${pointer.fileName}`, {
      cache: 'no-store'
    });

    if (!artifactResponse.ok) {
      return {
        artifact: null,
        warning: 'Approved dataset artifact is unavailable; using fixture scientific tree.'
      };
    }

    const artifact = (await artifactResponse.json()) as RuntimeDatasetArtifact;
    if (!Array.isArray(artifact.targets)) {
      return {
        artifact: null,
        warning: 'Approved dataset artifact targets are malformed; using fixture scientific tree.'
      };
    }

    return {
      artifact,
      warning: null
    };
  } catch {
    return {
      artifact: null,
      warning: 'Approved dataset failed to load; using fixture scientific tree.'
    };
  }
}
