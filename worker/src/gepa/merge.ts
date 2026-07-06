// System-aware merge/crossover (GEPA, arXiv:2507.19457 §merge; #84). Periodically, instead of
// mutating a single parent, combine two COMPLEMENTARY frontier Candidates' per-Module prompts
// into one hybrid and keep it only if it beats both parents' overall score. Pure, no I/O, no
// Date.now/Math.random — every decision here is a deterministic function of the pool/candidate
// state the workflow already holds, so (unlike sampleParent's win-weighted draw) merge needs no
// random input and is safe to call directly from the Temporal workflow sandbox (ADR-0006).
//
// Reflective + multi-Module only (#84): with a single Module a merge can never differ from its
// parents (there is nothing to recombine), so the workflow gates the whole feature on
// `modules.length > 1` before ever calling into this module. Simple Mode has no pool of
// complementary lineages (its selection is `topK` over a flat population, selection.ts) and
// never imports this module.

import type { ScoredCandidate } from "./pareto.js";

const EPSILON = 1e-9;

// Default merge cadence: attempt one merge every this-many completed mutation iterations.
// Frequent enough to matter within a typical run's iteration budget, infrequent enough that
// merge stays a periodic supplement to mutation rather than competing with it for rollout
// budget every round. Operator-overridable via the MERGE_EVERY_K_ITERS env var (worker-side,
// not user-surfaced — the same knob shape as EVAL_AGENT_FANOUT_CONCURRENCY): seedRun resolves
// it with resolveMergeEveryKIters below and carries it into the workflow as
// SeedRunResult.mergeEveryKIters, so one run keeps one cadence end to end — which also keeps
// the negative merge-iteration idempotency keys collision-free within a run (workflow.ts
// derives them from this value, and it never changes mid-run).
export const DEFAULT_MERGE_EVERY_K_ITERS = 5;

// Parse the MERGE_EVERY_K_ITERS env value defensively. Valid values are positive integers
// (1 = attempt a merge after every iteration); anything non-numeric, zero, or negative falls
// back to the default. Pure — the caller (seedRun, Node-only) reads process.env and passes the
// raw string in, so this module stays env-free and safe for the workflow sandbox to import.
export function resolveMergeEveryKIters(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MERGE_EVERY_K_ITERS;
}

// PostHog feature flag gating the whole merge step — an operational kill switch, targetable
// per-Team since it's evaluated with the run's org id as distinctId. Resolved ONCE per run in
// the seedRun Activity (the workflow sandbox must never read env or call PostHog) and carried
// into the workflow as SeedRunResult.mergeEnabled, mirroring how the eval fan-out concurrency
// rides an Activity result (worker/AGENTS.md); one resolution per run also keeps a run's
// behavior consistent end to end. Default matrix: telemetry.ts's isKillSwitchFlagEnabled.
export const SYSTEM_AWARE_MERGE_FLAG = "system-aware-merge";

export interface ComplementaryPair {
  aId: string;
  bId: string;
}

// instance -> the set of candidateIds tied for the best score on it (mirrors pareto.ts's
// winCounts, but keeps the actual winner sets instead of collapsing them to a count — merge
// needs to know WHICH instances two candidates each win, not just how many).
function instanceWinners(pool: ScoredCandidate[]): Map<number, Set<string>> {
  const maxima: Record<number, number> = {};
  for (const c of pool) {
    for (const [idx, score] of Object.entries(c.instanceScores)) {
      const i = Number(idx);
      if (!(i in maxima) || score > maxima[i]) maxima[i] = score;
    }
  }
  const winners = new Map<number, Set<string>>();
  for (const c of pool) {
    for (const [idx, score] of Object.entries(c.instanceScores)) {
      const i = Number(idx);
      if (score >= maxima[i] - EPSILON) {
        if (!winners.has(i)) winners.set(i, new Set());
        winners.get(i)!.add(c.candidateId);
      }
    }
  }
  return winners;
}

// Per-candidate win count AND the actual instance set won, in the pool's own iteration order
// (stable across replays of the same pool — no Map/Set nondeterminism, since pool is built up
// by the workflow in a fixed sequence).
function frontierWinSets(pool: ScoredCandidate[]): Map<string, Set<number>> {
  const winners = instanceWinners(pool);
  const byCandidate = new Map<string, Set<number>>();
  for (const c of pool) byCandidate.set(c.candidateId, new Set());
  for (const [idx, ids] of winners) {
    for (const id of ids) byCandidate.get(id)!.add(idx);
  }
  return byCandidate;
}

// Pick two complementary Pareto-frontier Candidates: lineages that each win at least one
// instance the other does not (so recombining their Modules has a chance of covering more
// ground than either parent alone). Deterministic: candidates are considered in descending
// win-count order (a stable sort, so ties keep the pool's own insertion order), and the first
// complementary pair found in that order is returned — favoring the strongest, most-established
// frontier members as merge parents over long-tail single-instance specialists. Returns null
// when the frontier is degenerate: fewer than two winners, or every pair is non-complementary
// (e.g. one candidate's wins are a subset of the other's — merging would just reproduce the
// dominant parent).
export function selectComplementaryPair(pool: ScoredCandidate[]): ComplementaryPair | null {
  const winSets = frontierWinSets(pool);
  const frontier = [...winSets.entries()]
    .filter(([, wins]) => wins.size > 0)
    .sort((a, b) => b[1].size - a[1].size); // stable: ties keep pool order

  for (let i = 0; i < frontier.length; i++) {
    for (let j = i + 1; j < frontier.length; j++) {
      const [aId, aWins] = frontier[i];
      const [bId, bWins] = frontier[j];
      const aOnly = [...aWins].some((idx) => !bWins.has(idx));
      const bOnly = [...bWins].some((idx) => !aWins.has(idx));
      if (aOnly && bOnly) return { aId, bId };
    }
  }
  return null;
}

// A candidate identified by id with its full-set overall score — all the merge accept gate
// (`beatsBothParents`) needs. `CandidateWithPrompts` (below) is a strict superset for the
// combination step, which additionally needs the actual per-Module text.
export interface ScoredParent {
  candidateId: string;
  overallScore: number;
}

export interface CandidateWithPrompts extends ScoredParent {
  prompts: Record<string, string>;
}

export interface MergeCombination {
  prompts: Record<string, string>;
  // Which parent is `parent_id` (primary lineage, per the migration's convention) vs
  // `merged_from_id` (the secondary parent) — derived here so the Activity that persists the
  // row and the prompt-combination logic can never disagree about which parent is which.
  primaryParentId: string;
  secondaryParentId: string;
}

// Combine two complementary parents' per-Module prompts into one hybrid, deterministically.
// Heuristic (documented, deliberately simple per #84's brief — this is NOT reflection-guided
// crossover, just deterministic recombination): round-robin the Modules (in the run's declared
// order) between the two parents, starting with whichever parent has the higher overall
// (full-set) score — the stronger parent's voice carries slightly more weight on an odd Module
// count, while every Module still has a chance to come from either parent. A tie in overall
// score is broken by candidateId so the starting parent (and thus the whole assignment) stays
// deterministic and replay-safe with no additional randomness.
export function combineModulePrompts(
  a: CandidateWithPrompts,
  b: CandidateWithPrompts,
  modules: string[]
): MergeCombination {
  const aFirst =
    a.overallScore !== b.overallScore
      ? a.overallScore > b.overallScore
      : a.candidateId < b.candidateId;
  const [first, second] = aFirst ? [a, b] : [b, a];

  const prompts: Record<string, string> = {};
  modules.forEach((mod, i) => {
    const source = i % 2 === 0 ? first : second;
    prompts[mod] = source.prompts[mod] ?? "";
  });

  return { prompts, primaryParentId: first.candidateId, secondaryParentId: second.candidateId };
}

// The merge accept gate: keep the hybrid only if it STRICTLY beats both parents' overall score
// (GEPA's system-aware merge — a hybrid that merely matches one parent adds nothing to the
// pool). Mirrors pareto.ts's `accepts` in spirit (strict improvement, no ties) but against two
// baselines instead of one.
export function beatsBothParents(hybridScore: number, a: ScoredParent, b: ScoredParent): boolean {
  return hybridScore > a.overallScore && hybridScore > b.overallScore;
}
