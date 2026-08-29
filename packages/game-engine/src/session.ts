import type { DifficultyConfig, ScientificPhylogeny } from '@evo-tree/domain';

import { scoreNodeAgainstTarget, type GameScoreResult } from './scoring';

export type GamePhase =
  | 'configure-difficulty'
  | 'selecting-target'
  | 'active'
  | 'results';

export interface TargetSelection {
  targetId: string;
  selectedAtIso: string;
}

export interface NavigationStep {
  fromNodeId: string;
  toNodeId: string;
  selectedAtIso: string;
}

export interface GameSessionState {
  phase: GamePhase;
  difficulty: DifficultyConfig;
  scientificRootId: string;
  target: TargetSelection | null;
  currentNodeId: string;
  visitedNodeIds: string[];
  navigationHistory: NavigationStep[];
  backtrackingEnabled: boolean;
  results: GameScoreResult | null;
}

export function createInitialSession(
  rootNodeId: string,
  difficulty: DifficultyConfig
): GameSessionState {
  return {
    phase: 'configure-difficulty',
    difficulty,
    scientificRootId: rootNodeId,
    target: null,
    currentNodeId: rootNodeId,
    visitedNodeIds: [rootNodeId],
    navigationHistory: [],
    backtrackingEnabled: difficulty.backtrackingEnabled,
    results: null
  };
}

export function finalizeDifficulty(
  session: GameSessionState,
  difficulty: DifficultyConfig
): GameSessionState {
  return {
    ...session,
    phase: 'selecting-target',
    difficulty,
    backtrackingEnabled: difficulty.backtrackingEnabled,
    results: null
  };
}

export function assignTarget(
  session: GameSessionState,
  targetId: string,
  selectedAtIso = new Date().toISOString()
): GameSessionState {
  return {
    ...session,
    phase: 'active',
    target: {
      targetId,
      selectedAtIso
    },
    currentNodeId: session.scientificRootId,
    visitedNodeIds: [session.scientificRootId],
    navigationHistory: [],
    results: null
  };
}

export function getAvailableChoices(
  session: GameSessionState,
  tree: ScientificPhylogeny
): string[] {
  const currentNode = tree.nodesById[session.currentNodeId];
  if (!currentNode) {
    return [];
  }

  return [...currentNode.childIds];
}

export function chooseBranch(
  session: GameSessionState,
  tree: ScientificPhylogeny,
  childNodeId: string,
  selectedAtIso = new Date().toISOString()
): GameSessionState {
  if (session.phase !== 'active') {
    throw new Error('Cannot choose a branch unless the game is active.');
  }

  const currentNode = tree.nodesById[session.currentNodeId];
  if (!currentNode) {
    throw new Error(`Current node not found: ${session.currentNodeId}`);
  }

  if (!currentNode.childIds.includes(childNodeId)) {
    throw new Error(
      `Invalid branch choice "${childNodeId}" from node "${currentNode.id}".`
    );
  }

  const nextNode = tree.nodesById[childNodeId];
  if (!nextNode) {
    throw new Error(`Selected child node not found: ${childNodeId}`);
  }

  const nextVisitedNodeIds = [...session.visitedNodeIds, childNodeId];
  const nextNavigationHistory = [
    ...session.navigationHistory,
    {
      fromNodeId: currentNode.id,
      toNodeId: childNodeId,
      selectedAtIso
    }
  ];

  if (nextNode.childIds.length === 0) {
    if (!session.target) {
      throw new Error('Target must be assigned before traversal can be scored.');
    }

    const results = scoreNodeAgainstTarget(
      tree,
      childNodeId,
      session.target.targetId,
      'terminal-node'
    );

    return {
      ...session,
      phase: 'results',
      currentNodeId: childNodeId,
      visitedNodeIds: nextVisitedNodeIds,
      navigationHistory: nextNavigationHistory,
      results
    };
  }

  return {
    ...session,
    currentNodeId: childNodeId,
    visitedNodeIds: nextVisitedNodeIds,
    navigationHistory: nextNavigationHistory,
    results: null
  };
}

export function backtrack(session: GameSessionState): GameSessionState {
  if (session.phase !== 'active') {
    return session;
  }

  if (!session.backtrackingEnabled || session.visitedNodeIds.length <= 1) {
    return session;
  }

  const nextVisitedNodeIds = session.visitedNodeIds.slice(0, -1);
  const nextCurrentNodeId = nextVisitedNodeIds[nextVisitedNodeIds.length - 1];
  if (!nextCurrentNodeId) {
    return session;
  }

  const nextNavigationHistory = session.navigationHistory.slice(0, -1);

  return {
    ...session,
    currentNodeId: nextCurrentNodeId,
    visitedNodeIds: nextVisitedNodeIds,
    navigationHistory: nextNavigationHistory,
    results: null
  };
}

export function quitAndScoreNow(
  session: GameSessionState,
  tree: ScientificPhylogeny
): GameSessionState {
  if (session.phase !== 'active') {
    throw new Error('Quit/Score now is only available during an active session.');
  }

  if (!session.target) {
    throw new Error('Target must be assigned before scoring.');
  }

  const results = scoreNodeAgainstTarget(
    tree,
    session.currentNodeId,
    session.target.targetId,
    'quit-score-now'
  );

  return {
    ...session,
    phase: 'results',
    results
  };
}

export function retrySession(
  session: GameSessionState,
  options: {
    preserveTarget: boolean;
    selectedAtIso?: string;
  }
): GameSessionState {
  const resetState: GameSessionState = {
    ...session,
    currentNodeId: session.scientificRootId,
    visitedNodeIds: [session.scientificRootId],
    navigationHistory: [],
    results: null
  };

  if (options.preserveTarget && session.target) {
    return {
      ...resetState,
      phase: 'active',
      target: {
        targetId: session.target.targetId,
        selectedAtIso: options.selectedAtIso ?? session.target.selectedAtIso
      }
    };
  }

  return {
    ...resetState,
    phase: 'selecting-target',
    target: null
  };
}
