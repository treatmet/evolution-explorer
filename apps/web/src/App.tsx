import type {
  DifficultyConfig,
  PhyloNode,
  ScientificPhylogeny,
  TargetDifficultyMetadata
} from '@evo-tree/domain';
import { fixtureScientificPhylogeny } from '@evo-tree/domain';
import {
  assignTarget,
  backtrack,
  chooseBranch,
  createInitialSession,
  deriveAdvancedDifficulty,
  finalizeDifficulty,
  getAvailableChoices,
  quitAndScoreNow,
  retrySession,
  selectTargetFromTree,
  type GameSessionState
} from '@evo-tree/game-engine';
import type { CameraState } from '@evo-tree/renderer-contracts';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from 'react';

import { CanvasTreeRenderer } from './render/canvas/CanvasTreeRenderer';
import {
  buildRenderModel,
  type RenderModelBounds
} from './render/layout/buildRenderModel';
import {
  loadApprovedRuntimeDataset,
  type RuntimeMediaAssetRecord,
  type RuntimeNodeMediaRecord,
  type RuntimeTargetSpecies
} from './data/runtimeDataset';
import { buildPlayableScientificTree } from './data/buildPlayableScientificTree';

const targetMetadata: TargetDifficultyMetadata[] = [
  { speciesId: 'homo-sapiens', familiarityScore: 0.98 },
  { speciesId: 'panthera-leo', familiarityScore: 0.84 },
  { speciesId: 'panthera-tigris', familiarityScore: 0.8 }
];

const PRIORITY_CLADE_LABELS = [
  'Eukaryota',
  'Opisthokonta',
  'Nucletmycea',
  'Fungi',
  'Metazoa',
  'Animalia',
  'Chloroplastida',
  'Plantae',
  'Bilateria',
  'Deuterostomia',
  'Chordata',
  'Mammalia',
  'Primates'
];

interface GesturePoint {
  x: number;
  y: number;
}

interface GestureState {
  pointers: Map<number, GesturePoint>;
  lastPinch: { distance: number; midX: number; midY: number } | null;
  movementPx: number;
}

interface RuntimeDataStatus {
  source: 'fixture' | 'approved';
  datasetVersion: string;
  targetCatalogCount: number;
  mediaAssetCount: number;
  mediaNodeCount: number;
  reconstructionQueueCount: number;
  mediaProviderFailureCount: number;
  warning: string | null;
}

function nodeName(
  tree: ScientificPhylogeny,
  nodeId: string,
  targetCatalogById: Record<string, RuntimeTargetSpecies>
): string {
  const treeNode = tree.nodesById[nodeId];
  if (treeNode) {
    return treeNode.displayName;
  }

  const catalogTarget = targetCatalogById[nodeId];
  if (catalogTarget) {
    return catalogTarget.commonName || catalogTarget.scientificName;
  }

  return nodeId;
}

function describeNodeAge(node: PhyloNode | null): string {
  if (!node) {
    return 'Age unresolved';
  }

  if (
    node.divergenceAgeMinMa !== undefined &&
    node.divergenceAgeMaxMa !== undefined
  ) {
    return `${node.divergenceAgeMinMa} to ${node.divergenceAgeMaxMa} Ma`;
  }

  if (node.divergenceAgeMa !== undefined) {
    return node.divergenceAgeMa === 0 ? 'Present day' : `${node.divergenceAgeMa} Ma`;
  }

  if (node.extinctionAgeMa !== undefined) {
    return `Extinct around ${node.extinctionAgeMa} Ma`;
  }

  return 'Age unresolved';
}

function getDecisionTraits(node: PhyloNode | null): string[] {
  if (!node) {
    return [];
  }

  return node.traits
    .map((trait) => trait.name)
    .filter(
      (traitName) =>
        !traitName.startsWith('Lineage summary:') && !traitName.startsWith('Lineage anchor:')
    )
    .slice(0, 3);
}

function describeChoiceHint(node: PhyloNode): string {
  const firstTrait = node.traits[0];
  if (firstTrait) {
    return firstTrait.name;
  }

  if (node.childIds.length > 0) {
    return `${node.childIds.length} descendant branches`;
  }

  if (node.extant) {
    return 'Extant endpoint';
  }

  if (node.extinctionAgeMa !== undefined) {
    return `Extinct around ${node.extinctionAgeMa} Ma`;
  }

  return 'Lineage details pending curation';
}

function avatarText(raw: string): string {
  const compact = raw.replace(/[^A-Za-z\s]/g, '').trim();
  if (!compact) {
    return 'T';
  }

  const words = compact.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }

  return `${words[0]![0] ?? ''}${words[1]![0] ?? ''}`.toUpperCase();
}

function buildTargetMetadataFromCatalog(
  targetCatalogById: Record<string, RuntimeTargetSpecies>
): TargetDifficultyMetadata[] {
  const catalogTargets = Object.values(targetCatalogById);
  if (catalogTargets.length === 0) {
    return targetMetadata;
  }

  const denominator = Math.max(1, catalogTargets.length - 1);
  const metadataFromCatalog: TargetDifficultyMetadata[] = catalogTargets.map((target, index) => ({
    speciesId: target.id,
    familiarityScore: Math.max(0, Math.min(1, 1 - index / denominator))
  }));

  const seen = new Set(metadataFromCatalog.map((item) => item.speciesId));
  for (const fallback of targetMetadata) {
    if (!seen.has(fallback.speciesId)) {
      metadataFromCatalog.push(fallback);
    }
  }

  return metadataFromCatalog;
}

function buildDifficulty(
  masterDifficultyPercent: number,
  manualDepth: number | null,
  manualMaxChoices: number | null,
  manualFamiliarity: number | null,
  backtrackingEnabled: boolean
): DifficultyConfig {
  const derived = deriveAdvancedDifficulty(masterDifficultyPercent / 100);

  return {
    ...derived,
    evolutionDepth: manualDepth ?? derived.evolutionDepth,
    maxChoicesPerDecision: manualMaxChoices ?? derived.maxChoicesPerDecision,
    targetFamiliarity: (manualFamiliarity ?? Math.round(derived.targetFamiliarity * 100)) / 100,
    backtrackingEnabled
  };
}

function fitCameraToBounds(
  bounds: RenderModelBounds,
  viewportWidth: number,
  viewportHeight: number
): CameraState {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const paddingX = 120;
  const paddingY = 120;

  const zoomX = (viewportWidth - paddingX * 2) / width;
  const zoomY = (viewportHeight - paddingY * 2) / height;
  const zoom = Math.max(0.06, Math.min(2.5, Math.min(zoomX, zoomY)));

  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    zoom,
    viewportWidth,
    viewportHeight
  };
}

function fitCameraToFocus(
  bounds: RenderModelBounds,
  focusX: number,
  focusY: number,
  viewportWidth: number,
  viewportHeight: number
): CameraState {
  const paddingX = 120;
  const paddingY = 120;
  const horizontalExtent = Math.max(Math.abs(bounds.minX - focusX), Math.abs(bounds.maxX - focusX), 1);
  const verticalExtent = Math.max(Math.abs(bounds.minY - focusY), Math.abs(bounds.maxY - focusY), 1);
  const zoomX = (viewportWidth / 2 - paddingX) / horizontalExtent;
  const zoomY = (viewportHeight / 2 - paddingY) / verticalExtent;

  return {
    x: focusX,
    y: focusY,
    zoom: Math.max(0.06, Math.min(2.5, zoomX, zoomY)),
    viewportWidth,
    viewportHeight
  };
}

function buildPathFromRoot(tree: ScientificPhylogeny, nodeId: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cursorId: string | null = nodeId;

  while (cursorId && !seen.has(cursorId)) {
    path.push(cursorId);
    seen.add(cursorId);

    const cursorNode: PhyloNode | undefined = tree.nodesById[cursorId];
    cursorId = cursorNode?.parentId ?? null;
  }

  if (path.length === 0 || path[path.length - 1] !== tree.rootId) {
    path.push(tree.rootId);
  }

  return path.reverse();
}

function buildNavigationHistoryFromPath(path: ReadonlyArray<string>, selectedAtIso: string) {
  return path.slice(1).map((toNodeId, index) => ({
    fromNodeId: path[index] ?? '',
    toNodeId,
    selectedAtIso
  }));
}

function easeInOutCubic(progress: number): number {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

function App() {
  const [scientificTree, setScientificTree] = useState<ScientificPhylogeny>(
    fixtureScientificPhylogeny
  );
  const [targetCatalogById, setTargetCatalogById] = useState<
    Record<string, RuntimeTargetSpecies>
  >({});
  const [nodeMediaByNodeId, setNodeMediaByNodeId] = useState<
    Record<string, RuntimeNodeMediaRecord>
  >({});
  const [mediaAssetsById, setMediaAssetsById] = useState<
    Record<string, RuntimeMediaAssetRecord>
  >({});
  const [runtimeTargetMetadataOverrides, setRuntimeTargetMetadataOverrides] = useState<
    TargetDifficultyMetadata[]
  >([]);
  const [runtimeDataStatus, setRuntimeDataStatus] = useState<RuntimeDataStatus>({
    source: 'fixture',
    datasetVersion: fixtureScientificPhylogeny.datasetVersion,
    targetCatalogCount: 0,
    mediaAssetCount: 0,
    mediaNodeCount: 0,
    reconstructionQueueCount: 0,
    mediaProviderFailureCount: 0,
    warning: null
  });

  const [masterDifficultyPercent, setMasterDifficultyPercent] = useState(55);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [difficultyPanelOpen, setDifficultyPanelOpen] = useState(false);
  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const [manualDepth, setManualDepth] = useState<number | null>(null);
  const [manualMaxChoices, setManualMaxChoices] = useState<number | null>(null);
  const [manualFamiliarity, setManualFamiliarity] = useState<number | null>(null);
  const [backtrackingEnabled, setBacktrackingEnabled] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CanvasTreeRenderer | null>(null);
  const cameraRef = useRef<CameraState>({
    x: 0,
    y: 0,
    zoom: 0.1,
    viewportWidth: 1,
    viewportHeight: 1
  });
  const animationFrameRef = useRef<number | null>(null);
  const cameraAnimationFrameRef = useRef<number | null>(null);
  const hasAutoFitRef = useRef(false);
  const lastFocusedSessionKeyRef = useRef<string | null>(null);
  const gestureRef = useRef<GestureState>({
    pointers: new Map(),
    lastPinch: null,
    movementPx: 0
  });

  const configuredDifficulty = useMemo(
    () =>
      buildDifficulty(
        masterDifficultyPercent,
        manualDepth,
        manualMaxChoices,
        manualFamiliarity,
        backtrackingEnabled
      ),
    [
      backtrackingEnabled,
      manualDepth,
      manualFamiliarity,
      manualMaxChoices,
      masterDifficultyPercent
    ]
  );

  const playableTreeResult = useMemo(
    () =>
      buildPlayableScientificTree(scientificTree, {
        priorityClades: {
          labels: PRIORITY_CLADE_LABELS
        }
      }),
    [scientificTree]
  );
  const playableTree = playableTreeResult.tree;

  const [session, setSession] = useState<GameSessionState>(() =>
    createInitialSession(playableTree.rootId, configuredDifficulty)
  );

  useEffect(() => {
    let cancelled = false;

    loadApprovedRuntimeDataset()
      .then((result) => {
        if (cancelled) {
          return;
        }

        if (!result.artifact) {
          setRuntimeDataStatus((previous) => ({
            ...previous,
            warning: result.warning
          }));
          return;
        }

        const targetCatalog = Object.fromEntries(
          result.artifact.targets.map((target) => [target.id, target])
        );
        const media = result.artifact.mediaEnrichment;
        const mediaNodes = media?.nodeMediaByNodeId ?? {};
        const mediaAssets = media?.assetsById ?? {};
        const targetMetadata = media?.targetDifficultyMetadata ?? [];
        const mediaProviderFailureCount = (media?.providerSnapshots ?? []).reduce(
          (sum, provider) => sum + provider.failures,
          0
        );

        const nextTree = result.artifact.scientificPhylogeny ?? fixtureScientificPhylogeny;
        const nextPlayableTree = buildPlayableScientificTree(nextTree, {
          priorityClades: {
            labels: PRIORITY_CLADE_LABELS
          }
        }).tree;
        setTargetCatalogById(targetCatalog);
        setNodeMediaByNodeId(mediaNodes);
        setMediaAssetsById(mediaAssets);
        setRuntimeTargetMetadataOverrides(targetMetadata);
        setScientificTree(nextTree);
        setSession((previous) => createInitialSession(nextPlayableTree.rootId, previous.difficulty));
        setHoveredNodeId(null);
        hasAutoFitRef.current = false;
        setErrorText(null);
        setRuntimeDataStatus({
          source: 'approved',
          datasetVersion: result.artifact.manifest.datasetVersion,
          targetCatalogCount: result.artifact.targets.length,
          mediaAssetCount: Object.keys(mediaAssets).length,
          mediaNodeCount: Object.keys(mediaNodes).length,
          reconstructionQueueCount: media?.reconstructionQueue.length ?? 0,
          mediaProviderFailureCount,
          warning: result.warning
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setRuntimeDataStatus((previous) => ({
          ...previous,
          warning: 'Approved dataset failed to load; using fixture scientific tree.'
        }));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const runtimeTargetMetadata = useMemo(
    () =>
      runtimeTargetMetadataOverrides.length > 0
        ? runtimeTargetMetadataOverrides
        : buildTargetMetadataFromCatalog(targetCatalogById),
    [runtimeTargetMetadataOverrides, targetCatalogById]
  );

  const targetNode = session.target
    ? playableTree.nodesById[session.target.targetId] ?? null
    : null;

  const targetCatalogTarget = session.target
    ? targetCatalogById[session.target.targetId] ?? null
    : null;

  const currentNode = playableTree.nodesById[session.currentNodeId] ?? null;

  const availableChoiceIds =
    session.phase === 'active' ? getAvailableChoices(session, playableTree) : [];

  const availableChoiceNodes = availableChoiceIds
    .map((choiceId) => playableTree.nodesById[choiceId])
    .filter((node): node is PhyloNode => Boolean(node));

  const currentNodeTraits = getDecisionTraits(currentNode);
  const canBacktrack =
    session.phase === 'active' &&
    session.backtrackingEnabled &&
    session.visitedNodeIds.length > 1;
  const isActiveGame = session.phase === 'active';
  const canExploreByClick =
    session.phase === 'configure-difficulty' ||
    session.phase === 'selecting-target' ||
    session.phase === 'results';
  const hasStartedGame = session.phase === 'active' || session.phase === 'results';

  const targetFamiliarityPercent = Math.round(configuredDifficulty.targetFamiliarity * 100);

  const scientificNodeCount = Object.keys(playableTree.nodesById).length;
  const rawScientificNodeCount = Object.keys(scientificTree.nodesById).length;
  const skippedNodeCount = Math.max(0, rawScientificNodeCount - scientificNodeCount);
  const targetEligibleCount = Object.values(playableTree.nodesById).filter(
    (node) => node.isTargetEligible
  ).length;

  const nodeDisplayName = (nodeId: string): string =>
    nodeName(playableTree, nodeId, targetCatalogById);

  const targetTitle =
    targetNode?.commonName ??
    targetNode?.displayName ??
    targetCatalogTarget?.commonName ??
    targetCatalogTarget?.scientificName ??
    'Pending Selection';

  const targetScientificName =
    targetNode?.scientificName ??
    targetCatalogTarget?.scientificName ??
    'Choose difficulty first, then target species is sampled.';

  const targetNodeMedia = targetNode ? nodeMediaByNodeId[targetNode.id] : undefined;
  const targetPrimaryAssetId = targetNodeMedia?.primaryAssetId;
  const targetPrimaryAsset = targetPrimaryAssetId
    ? mediaAssetsById[targetPrimaryAssetId]
    : undefined;
  const targetImageUrl = targetPrimaryAsset?.thumbnailUrl ?? targetPrimaryAsset?.url;
  const targetImageAttribution = targetPrimaryAsset?.attribution.attributionText;

  const nodeImageById = useMemo(() => {
    const next: Record<string, string> = {};

    for (const node of Object.values(playableTree.nodesById)) {
      const nodeMedia = nodeMediaByNodeId[node.id];
      const primaryAssetId = nodeMedia?.primaryAssetId;
      if (!primaryAssetId) {
        continue;
      }

      const asset = mediaAssetsById[primaryAssetId];
      const imageUrl = asset?.thumbnailUrl ?? asset?.url;
      if (!imageUrl) {
        continue;
      }

      next[node.id] = imageUrl;
    }

    return next;
  }, [mediaAssetsById, nodeMediaByNodeId, playableTree]);

  const renderModel = useMemo(
    () =>
      buildRenderModel(playableTree, {
        currentNodeId: session.currentNodeId,
        hoveredNodeId,
        visitedNodeIds: session.visitedNodeIds,
        ...(hasStartedGame ? { visibleNodeIds: session.visitedNodeIds } : {}),
        focusNodeId: session.currentNodeId,
        focusStrength: 0.24,
        nodeImageById
      }),
    [
      hoveredNodeId,
      hasStartedGame,
      isActiveGame,
      nodeImageById,
      playableTree,
      session.currentNodeId,
      session.visitedNodeIds
    ]
  );

  const renderBoundsRef = useRef(renderModel.bounds);

  useEffect(() => {
    renderBoundsRef.current = renderModel.bounds;
  }, [renderModel.bounds]);

  function setRendererCamera(nextCamera: CameraState): void {
    cameraRef.current = nextCamera;
    rendererRef.current?.setCamera(nextCamera);
  }

  function animateCameraTo(targetCamera: CameraState): void {
    if (cameraAnimationFrameRef.current !== null) {
      cancelAnimationFrame(cameraAnimationFrameRef.current);
    }

    const startCamera = cameraRef.current;
    const startedAt = performance.now();
    const durationMs = 720;

    const animate = (nowMs: number): void => {
      const progress = Math.min(1, (nowMs - startedAt) / durationMs);
      const easedProgress = easeInOutCubic(progress);
      setRendererCamera({
        ...targetCamera,
        x: startCamera.x + (targetCamera.x - startCamera.x) * easedProgress,
        y: startCamera.y + (targetCamera.y - startCamera.y) * easedProgress,
        zoom: startCamera.zoom + (targetCamera.zoom - startCamera.zoom) * easedProgress
      });

      if (progress < 1) {
        cameraAnimationFrameRef.current = requestAnimationFrame(animate);
      } else {
        cameraAnimationFrameRef.current = null;
      }
    };

    cameraAnimationFrameRef.current = requestAnimationFrame(animate);
  }

  function zoomAt(screenX: number, screenY: number, factor: number): void {
    const camera = cameraRef.current;
    const previousZoom = camera.zoom;
    const nextZoom = Math.max(0.05, Math.min(16, previousZoom * factor));

    const worldX = (screenX - camera.viewportWidth / 2) / previousZoom + camera.x;
    const worldY = (screenY - camera.viewportHeight / 2) / previousZoom + camera.y;

    const nextCamera: CameraState = {
      ...camera,
      zoom: nextZoom,
      x: worldX - (screenX - camera.viewportWidth / 2) / nextZoom,
      y: worldY - (screenY - camera.viewportHeight / 2) / nextZoom
    };

    setRendererCamera(nextCamera);
  }

  function startRunWithConfiguredDifficulty() {
    try {
      const initialSession = createInitialSession(
        playableTree.rootId,
        configuredDifficulty
      );
      const selectingSession = finalizeDifficulty(initialSession, configuredDifficulty);
      const targetId = selectTargetFromTree(
        playableTree,
        configuredDifficulty,
        runtimeTargetMetadata
      );

      setSession(assignTarget(selectingSession, targetId));
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Unable to start run.');
    }
  }

  function selectBranch(choiceId: string) {
    try {
      setSession((previous) =>
        chooseBranch(previous, playableTree, choiceId)
      );
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Unable to choose branch.');
    }
  }

  function jumpToNode(nodeId: string) {
    if (!playableTree.nodesById[nodeId]) {
      return;
    }

    const selectedAtIso = new Date().toISOString();
    setSession((previous) => {
      if (previous.phase === 'active') {
        return previous;
      }

      const nextVisitedNodeIds = buildPathFromRoot(playableTree, nodeId);
      return {
        ...previous,
        currentNodeId: nodeId,
        visitedNodeIds: nextVisitedNodeIds,
        navigationHistory: buildNavigationHistoryFromPath(nextVisitedNodeIds, selectedAtIso)
      };
    });
    setErrorText(null);
  }

  function scoreNow() {
    try {
      setSession((previous) => quitAndScoreNow(previous, playableTree));
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Unable to score current node.');
    }
  }

  function retryWithSameTarget() {
    setSession((previous) => retrySession(previous, { preserveTarget: true }));
    setErrorText(null);
  }

  function retryWithNewTarget() {
    try {
      setSession((previous) => {
        const reset = retrySession(previous, { preserveTarget: false });
        const targetId = selectTargetFromTree(
          playableTree,
          configuredDifficulty,
          runtimeTargetMetadata
        );

        return assignTarget(reset, targetId);
      });
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Unable to retry with new target.');
    }
  }

  function pickNewTarget() {
    if (session.phase === 'configure-difficulty' || session.phase === 'selecting-target') {
      startRunWithConfiguredDifficulty();
      return;
    }

    retryWithNewTarget();
  }

  function focusCameraOnCurrentNode() {
    const currentRenderNode = renderModel.nodes.find((node) => node.id === session.currentNodeId);
    if (!currentRenderNode) {
      return;
    }

    const camera = cameraRef.current;
    const nextCamera: CameraState = {
      ...camera,
      x: currentRenderNode.worldX,
      y: currentRenderNode.fisheyeTargetY,
      zoom: Math.max(camera.zoom, 0.92)
    };

    setRendererCamera(nextCamera);
  }

  useEffect(() => {
    if (!hasStartedGame || !rendererRef.current) {
      return;
    }

    const focusKey = `${session.phase}:${session.currentNodeId}`;
    if (lastFocusedSessionKeyRef.current === focusKey) {
      return;
    }

    const currentRenderNode = renderModel.nodes.find((node) => node.id === session.currentNodeId);
    if (!currentRenderNode) {
      return;
    }

    const camera = cameraRef.current;
    animateCameraTo(
      fitCameraToFocus(
        renderModel.bounds,
        currentRenderNode.worldX,
        currentRenderNode.fisheyeTargetY,
        camera.viewportWidth,
        camera.viewportHeight
      )
    );
    lastFocusedSessionKeyRef.current = focusKey;
  }, [hasStartedGame, renderModel, session.currentNodeId, session.phase]);

  useEffect(() => {
    if (!isActiveGame) {
      return;
    }

    setDifficultyPanelOpen(false);
    setAdvancedOpen(false);
  }, [isActiveGame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const renderer = new CanvasTreeRenderer();
    renderer.mount(canvas);
    rendererRef.current = renderer;

    const runFrame = (nowMs: number): void => {
      renderer.render(nowMs);
      animationFrameRef.current = requestAnimationFrame(runFrame);
    };

    animationFrameRef.current = requestAnimationFrame(runFrame);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }

      if (cameraAnimationFrameRef.current !== null) {
        cancelAnimationFrame(cameraAnimationFrameRef.current);
        cameraAnimationFrameRef.current = null;
      }

      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer) {
      return;
    }

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

      renderer.resize(width, height, dpr);

      const currentCamera = cameraRef.current;
      const resizedCamera: CameraState = {
        ...currentCamera,
        viewportWidth: width,
        viewportHeight: height
      };

      if (!hasAutoFitRef.current) {
        const fitted = fitCameraToBounds(renderBoundsRef.current, width, height);
        setRendererCamera(fitted);
        hasAutoFitRef.current = true;
        return;
      }

      setRendererCamera(resizedCamera);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setNodes(renderModel.nodes);
  }, [renderModel.nodes]);

  function onWheel(event: ReactWheelEvent<HTMLCanvasElement>): void {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const zoomFactor = Math.exp(-event.deltaY * 0.00125);

    zoomAt(screenX, screenY, zoomFactor);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);

    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };

    const gesture = gestureRef.current;
    gesture.pointers.set(event.pointerId, point);
    gesture.movementPx = 0;

    if (gesture.pointers.size === 2) {
      const [first, second] = [...gesture.pointers.values()];
      if (!first || !second) {
        return;
      }
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      gesture.lastPinch = {
        distance,
        midX: (first.x + second.x) / 2,
        midY: (first.y + second.y) / 2
      };
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const renderer = rendererRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    if (renderer) {
      const hitNodeId = renderer.hitTest(screenX, screenY);
      setHoveredNodeId((previous) => (previous === hitNodeId ? previous : hitNodeId));
    }

    const gesture = gestureRef.current;
    const previousPoint = gesture.pointers.get(event.pointerId);
    if (!previousPoint) {
      return;
    }

    const nextPoint = { x: screenX, y: screenY };
    gesture.pointers.set(event.pointerId, nextPoint);
    gesture.movementPx += Math.hypot(nextPoint.x - previousPoint.x, nextPoint.y - previousPoint.y);

    if (gesture.pointers.size === 1) {
      if (event.pointerType === 'mouse' && event.buttons === 0) {
        return;
      }

      const camera = cameraRef.current;
      const nextCamera: CameraState = {
        ...camera,
        x: camera.x - (nextPoint.x - previousPoint.x) / camera.zoom,
        y: camera.y - (nextPoint.y - previousPoint.y) / camera.zoom
      };

      setRendererCamera(nextCamera);
      return;
    }

    if (gesture.pointers.size >= 2) {
      const points = [...gesture.pointers.values()];
      const first = points[0];
      const second = points[1];
      if (!first || !second) {
        return;
      }
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const midX = (first.x + second.x) / 2;
      const midY = (first.y + second.y) / 2;

      if (gesture.lastPinch) {
        const zoomFactor = distance / Math.max(1, gesture.lastPinch.distance);
        zoomAt(midX, midY, zoomFactor);

        const camera = cameraRef.current;
        const panX = midX - gesture.lastPinch.midX;
        const panY = midY - gesture.lastPinch.midY;
        const pannedCamera: CameraState = {
          ...camera,
          x: camera.x - panX / camera.zoom,
          y: camera.y - panY / camera.zoom
        };

        setRendererCamera(pannedCamera);
      }

      gesture.lastPinch = {
        distance,
        midX,
        midY
      };
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const gesture = gestureRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    if (gesture.movementPx < 6 && rendererRef.current) {
      const hitNodeId = rendererRef.current.hitTest(screenX, screenY);
      if (!hitNodeId) {
        gesture.pointers.delete(event.pointerId);

        if (gesture.pointers.size < 2) {
          gesture.lastPinch = null;
        }
        return;
      }

      if (session.phase === 'active' && availableChoiceIds.includes(hitNodeId)) {
        selectBranch(hitNodeId);
      } else if (canExploreByClick) {
        jumpToNode(hitNodeId);
      }
    }

    gesture.pointers.delete(event.pointerId);

    if (gesture.pointers.size < 2) {
      gesture.lastPinch = null;
    }
  }

  return (
    <div className="app-shell">
      <main className="viewport" aria-label="Scientific tree viewport">
        <canvas
          ref={canvasRef}
          className="tree-canvas"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHoveredNodeId(null)}
          aria-label="Evolution tree canvas"
        ></canvas>

        <section className="top-hud panel" aria-label="Inline control bar">
          <div className="top-hud-row">
            <div className="top-hud-left">
              <div className="hud-chip" title={targetScientificName} aria-label="Current target species">
                <span className="hud-chip-icon target-chip-icon" aria-hidden="true">
                  {targetImageUrl ? (
                    <img className="target-avatar-image" src={targetImageUrl} alt="" />
                  ) : (
                    avatarText(targetTitle)
                  )}
                </span>
                <span className="hud-chip-label">Target</span>
                <span className="hud-chip-value">{targetTitle}</span>
              </div>

              <div className="hud-item">
                <button
                  type="button"
                  className="hud-chip hud-chip-button"
                  onClick={() => {
                    if (!isActiveGame) {
                      setDifficultyPanelOpen((value) => !value);
                    }
                  }}
                  aria-expanded={difficultyPanelOpen}
                  aria-controls="difficulty-flyout"
                  aria-label="Difficulty quick control"
                  disabled={isActiveGame}
                  title={isActiveGame ? 'Difficulty is locked during active runs.' : 'Open difficulty options'}
                >
                  <span className="hud-chip-icon" aria-hidden="true">D</span>
                  <span className="hud-chip-label">Difficulty</span>
                  <span className="hud-chip-value">{masterDifficultyPercent}%</span>
                </button>

                {difficultyPanelOpen && !isActiveGame ? (
                  <section id="difficulty-flyout" className="hud-flyout panel" aria-label="Difficulty controls">
                    <div className="row">
                      <h2>Difficulty</h2>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setAdvancedOpen((value) => !value)}
                        aria-expanded={advancedOpen}
                      >
                        {advancedOpen ? 'Hide advanced' : 'Show advanced'}
                      </button>
                    </div>

                    <label htmlFor="masterDifficulty">Master difficulty: {masterDifficultyPercent}%</label>
                    <input
                      id="masterDifficulty"
                      type="range"
                      min={0}
                      max={100}
                      value={masterDifficultyPercent}
                      onChange={(event) => setMasterDifficultyPercent(Number(event.target.value))}
                    />

                    {advancedOpen ? (
                      <div className="advanced-grid">
                        <label htmlFor="evolutionDepth">
                          Evolution Depth: {configuredDifficulty.evolutionDepth}
                        </label>
                        <input
                          id="evolutionDepth"
                          type="range"
                          min={8}
                          max={40}
                          value={configuredDifficulty.evolutionDepth}
                          onChange={(event) => setManualDepth(Number(event.target.value))}
                        />

                        <label htmlFor="targetFamiliarity">
                          Target Familiarity: {targetFamiliarityPercent}%
                        </label>
                        <input
                          id="targetFamiliarity"
                          type="range"
                          min={0}
                          max={100}
                          value={targetFamiliarityPercent}
                          onChange={(event) => setManualFamiliarity(Number(event.target.value))}
                        />

                        <label htmlFor="maxChoicesPerDecision">
                          Maximum Choices per Decision: {configuredDifficulty.maxChoicesPerDecision}
                        </label>
                        <input
                          id="maxChoicesPerDecision"
                          type="range"
                          min={2}
                          max={8}
                          value={configuredDifficulty.maxChoicesPerDecision}
                          onChange={(event) => setManualMaxChoices(Number(event.target.value))}
                        />

                        <label className="checkbox-row" htmlFor="backtrackingEnabled">
                          <input
                            id="backtrackingEnabled"
                            type="checkbox"
                            checked={backtrackingEnabled}
                            onChange={(event) => setBacktrackingEnabled(event.target.checked)}
                          />
                          Backtracking enabled
                        </label>
                      </div>
                    ) : null}

                  </section>
                ) : null}
              </div>

              <div className="hud-item">
                <button
                  type="button"
                  className="hud-icon-button"
                  onClick={() => setStatusPanelOpen((value) => !value)}
                  aria-expanded={statusPanelOpen}
                  aria-controls="layer-boundaries-flyout"
                  aria-label="Toggle Layer Boundaries information"
                  title="Layer boundaries information"
                >
                  i
                </button>

                {statusPanelOpen ? (
                  <section
                    id="layer-boundaries-flyout"
                    className="hud-flyout panel status-flyout"
                    aria-label="Layer Boundaries"
                  >
                    <div className="row">
                      <p className="label">Layer Boundaries</p>

                    </div>
                    <ul>
                      <li>Source Data: species-list parser + TXT repository</li>
                      <li>
                        Scientific Phylogeny: {runtimeDataStatus.source === 'approved' ? 'approved runtime artifact' : 'fixture fallback'} + domain algorithms
                      </li>
                      <li>Game Session: traversal, retry, backtracking, terminal and quit scoring</li>
                      <li>Game Projection: identity map until high-degree navigation grouping milestone</li>
                      <li>Render Model: Canvas2D renderer with culling, LOD, labels, fisheye</li>
                      <li>Runtime dataset version: {runtimeDataStatus.datasetVersion}</li>
                      <li>Compiled target catalog entries: {runtimeDataStatus.targetCatalogCount}</li>
                      <li>Target-eligible nodes in active scientific tree: {targetEligibleCount}</li>
                      <li>Renderable hydrated nodes: {scientificNodeCount} (compacted away: {skippedNodeCount})</li>
                      <li>Merged duplicate clade nodes: {playableTreeResult.mergedNodeCount}</li>
                      <li>Nodes with inferred fallback traits: {playableTreeResult.inferredTraitNodeCount}</li>
                      <li>Resolved media assets in artifact: {runtimeDataStatus.mediaAssetCount}</li>
                      <li>Nodes with media mapping: {runtimeDataStatus.mediaNodeCount}</li>
                      <li>Pending reconstruction queue entries: {runtimeDataStatus.reconstructionQueueCount}</li>
                      <li>Media provider failures during build: {runtimeDataStatus.mediaProviderFailureCount}</li>
                    </ul>

                    {runtimeDataStatus.warning ? (
                      <p className="tiny">Runtime dataset note: {runtimeDataStatus.warning}</p>
                    ) : null}

                    {targetImageAttribution ? (
                      <p className="tiny">Target media attribution: {targetImageAttribution}</p>
                    ) : null}

                    <p className="tiny">
                      Current node: {nodeDisplayName(session.currentNodeId)} | Path length: {session.visitedNodeIds.length}
                    </p>
                  </section>
                ) : null}
              </div>
            </div>

            <div className="top-hud-right">
              <div className="actions-row top-actions-row" aria-label="Top action menu">
                <button type="button" className="ghost" onClick={pickNewTarget}>
                  New Target
                </button>

                {session.phase === 'active' ? (
                  <>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setSession((previous) => backtrack(previous))}
                      disabled={!canBacktrack}
                    >
                      Backtrack
                    </button>
                    <button type="button" className="ghost danger" onClick={scoreNow}>
                      Quit / Score Now
                    </button>
                  </>
                ) : null}

                {session.phase === 'results' && session.results ? (
                  <>
                    <button type="button" className="ghost" onClick={retryWithSameTarget}>
                      Try Again
                    </button>
                  </>
                ) : null}
              </div>

              <button
                type="button"
                className="hud-icon-button target-focus-button"
                onClick={focusCameraOnCurrentNode}
                aria-label={`Focus camera on ${currentNode?.displayName ?? 'current node'}`}
                title="Focus camera on active node"
              >
                <span className="target-focus-glyph" aria-hidden="true"></span>
              </button>
            </div>
          </div>
        </section>

        <section className="decision-card panel" aria-label="Decision lens preview">
          <p className="label">Decision Lens</p>
          <h2>{currentNode?.displayName ?? 'Unknown node'}</h2>
          {currentNode?.description ? (
            <p className="decision-description">{currentNode.description}</p>
          ) : null}
          <div className="metric-row">
            <span className="metric-chip">Age: {describeNodeAge(currentNode)}</span>
            <span className="metric-chip">Confidence: {currentNode?.confidence ?? 'unresolved'}</span>
            <span className="metric-chip">Kind: {currentNode?.kind ?? 'unknown'}</span>
          </div>
          {currentNodeTraits.length > 0 ? (
            <div className="trait-row" aria-label="Current node traits">
              {currentNodeTraits.map((traitName) => (
                <span key={traitName} className="trait-chip">
                  {traitName}
                </span>
              ))}
            </div>
          ) : null}

          {session.phase === 'active' ? (
            <>
              <p className="muted">Choose a branch.</p>
              <div className="choice-grid">
                {availableChoiceNodes.map((choiceNode) => (
                  <button
                    key={choiceNode.id}
                    type="button"
                    className="choice"
                    onClick={() => selectBranch(choiceNode.id)}
                  >
                    <span className="choice-title">{choiceNode.displayName}</span>
                    <span className="choice-subtle">
                      {choiceNode.scientificName ?? (choiceNode.extant ? 'Extant lineage' : 'Extinct lineage')}
                    </span>
                    <span className="choice-hint">{describeChoiceHint(choiceNode)}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {session.phase === 'results' && session.results ? (
            <div className="results-box">
              <p className="label">Results</p>
              <p>
                Arrived: {nodeDisplayName(session.results.arrivedNodeId)} | Target:{' '}
                {nodeDisplayName(session.results.targetId)}
              </p>
              <p>MRCA: {session.results.mrcaId ? nodeDisplayName(session.results.mrcaId) : 'Unavailable'}</p>
              <p>
                Divergence estimate:{' '}
                {session.results.divergenceMa !== null
                  ? `${session.results.divergenceMa} Ma`
                  : 'Unavailable'}
              </p>
              <p>
                Shared lineage: {session.results.sharedLineageIds.map(nodeDisplayName).join(' -> ')}
              </p>
              <p>
                Shared traits:{' '}
                {session.results.sharedTraitNames.length > 0
                  ? session.results.sharedTraitNames.join(', ')
                  : 'No shared traits available in this fixture dataset'}
              </p>
              <p>Phylogenetic Relatedness Score: {session.results.phylogeneticRelatednessScore}</p>
              <p>
                Genomic similarity: {session.results.genomicSimilarity.status} ({session.results.genomicSimilarity.confidence})
              </p>
              <p className="tiny">{session.results.genomicSimilarity.provenanceNote}</p>
            </div>
          ) : null}

          {errorText ? <p className="error-text">{errorText}</p> : null}
        </section>
      </main>
    </div>
  );
}

export default App;
