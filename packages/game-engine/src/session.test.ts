import { describe, expect, it } from 'vitest';

import { fixtureScientificPhylogeny } from '@evo-tree/domain';

import { defaultDifficulty } from './difficulty';
import {
  assignTarget,
  backtrack,
  chooseBranch,
  createInitialSession,
  finalizeDifficulty,
  getAvailableChoices,
  quitAndScoreNow,
  retrySession
} from './session';

function setupActiveSession(targetId = 'panthera-tigris') {
  const difficulty = defaultDifficulty();
  const initial = createInitialSession(fixtureScientificPhylogeny.rootId, difficulty);
  const selecting = finalizeDifficulty(initial, difficulty);
  return assignTarget(selecting, targetId, '2026-08-27T00:00:00.000Z');
}

describe('game session lifecycle', () => {
  it('requires difficulty finalization before active play semantics', () => {
    const difficulty = defaultDifficulty();
    const initial = createInitialSession(fixtureScientificPhylogeny.rootId, difficulty);

    expect(initial.phase).toBe('configure-difficulty');

    const selecting = finalizeDifficulty(initial, difficulty);
    expect(selecting.phase).toBe('selecting-target');

    const active = assignTarget(selecting, 'panthera-tigris');
    expect(active.phase).toBe('active');
    expect(active.target?.targetId).toBe('panthera-tigris');
    expect(active.currentNodeId).toBe('luca');
  });

  it('moves along valid branches and supports backtracking', () => {
    let session = setupActiveSession();

    expect(getAvailableChoices(session, fixtureScientificPhylogeny)).toEqual([
      'bacteria',
      'eukaryota'
    ]);

    session = chooseBranch(
      session,
      fixtureScientificPhylogeny,
      'eukaryota',
      '2026-08-27T00:00:01.000Z'
    );
    session = chooseBranch(
      session,
      fixtureScientificPhylogeny,
      'opisthokonta',
      '2026-08-27T00:00:02.000Z'
    );

    expect(session.currentNodeId).toBe('opisthokonta');
    expect(session.visitedNodeIds).toEqual(['luca', 'eukaryota', 'opisthokonta']);

    const backed = backtrack(session);
    expect(backed.currentNodeId).toBe('eukaryota');
    expect(backed.visitedNodeIds).toEqual(['luca', 'eukaryota']);
    expect(backed.navigationHistory).toHaveLength(1);
  });

  it('blocks backtracking when disabled', () => {
    const disabledDifficulty = {
      ...defaultDifficulty(),
      backtrackingEnabled: false
    };

    const initial = createInitialSession(fixtureScientificPhylogeny.rootId, disabledDifficulty);
    const selecting = finalizeDifficulty(initial, disabledDifficulty);
    let session = assignTarget(selecting, 'panthera-tigris');

    session = chooseBranch(session, fixtureScientificPhylogeny, 'eukaryota');
    const attempted = backtrack(session);

    expect(attempted.currentNodeId).toBe('eukaryota');
    expect(attempted.visitedNodeIds).toEqual(['luca', 'eukaryota']);
  });

  it('scores automatically when a terminal node is reached', () => {
    let session = setupActiveSession();
    const route = [
      'eukaryota',
      'opisthokonta',
      'metazoa',
      'bilateria',
      'deuterostomia',
      'chordata',
      'mammalia',
      'panthera',
      'panthera-tigris'
    ];

    for (const step of route) {
      session = chooseBranch(session, fixtureScientificPhylogeny, step);
    }

    expect(session.phase).toBe('results');
    expect(session.currentNodeId).toBe('panthera-tigris');
    expect(session.results?.reason).toBe('terminal-node');
    expect(session.results?.phylogeneticRelatednessScore).toBe(100);
  });

  it('supports quit-and-score-now at internal nodes', () => {
    let session = setupActiveSession();
    session = chooseBranch(session, fixtureScientificPhylogeny, 'eukaryota');

    const scored = quitAndScoreNow(session, fixtureScientificPhylogeny);

    expect(scored.phase).toBe('results');
    expect(scored.currentNodeId).toBe('eukaryota');
    expect(scored.results?.reason).toBe('quit-score-now');
    expect(scored.results?.mrcaId).toBe('eukaryota');
    expect((scored.results?.phylogeneticRelatednessScore ?? 0) < 100).toBe(true);
  });

  it('retries with preserved target or reroll-ready state', () => {
    let session = setupActiveSession();
    session = chooseBranch(session, fixtureScientificPhylogeny, 'eukaryota');

    const preserved = retrySession(session, {
      preserveTarget: true,
      selectedAtIso: '2026-08-27T00:05:00.000Z'
    });

    expect(preserved.phase).toBe('active');
    expect(preserved.currentNodeId).toBe('luca');
    expect(preserved.target?.targetId).toBe('panthera-tigris');

    const reroll = retrySession(session, {
      preserveTarget: false
    });

    expect(reroll.phase).toBe('selecting-target');
    expect(reroll.target).toBeNull();
    expect(reroll.currentNodeId).toBe('luca');
  });
});
