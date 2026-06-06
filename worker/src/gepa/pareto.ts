// Pure Pareto-selection helpers for the GEPA loop (arXiv:2507.19457, candidate selection).
// No I/O, so they unit-test without a DB and are safe to call from the deterministic Temporal
// workflow sandbox — the one nondeterministic input, a random draw, is passed in by the caller
// (Math.random() is deterministic and replay-safe inside a Temporal workflow).

// Float guard for "best on this instance": scores within EPSILON of the max count as a tie,
// so two candidates that are equal up to rounding both keep their win.
const EPSILON = 1e-9;

export interface ScoredCandidate {
  candidateId: string;
  // Per-instance score vector: instance_index -> weighted score. Pool members are all scored
  // on the identical frozen set, so they share the same instance keys.
  instanceScores: Record<number, number>;
}

// The best score achieved on each instance across the whole pool.
export function instanceMaxima(pool: ScoredCandidate[]): Record<number, number> {
  const maxima: Record<number, number> = {};
  for (const c of pool) {
    for (const [idx, score] of Object.entries(c.instanceScores)) {
      const i = Number(idx);
      if (!(i in maxima) || score > maxima[i]) maxima[i] = score;
    }
  }
  return maxima;
}

// GEPA's per-instance win count: for each instance, every candidate within EPSILON of the
// best score on that instance scores a win (ties share the instance). Candidates with >= 1
// win form the Pareto frontier. Returns only winners, candidateId -> win count, in a stable
// order (first instance each candidate wins) so sampling is reproducible on workflow replay.
export function winCounts(pool: ScoredCandidate[]): Map<string, number> {
  const maxima = instanceMaxima(pool);
  const wins = new Map<string, number>();
  for (const [idx, best] of Object.entries(maxima)) {
    const i = Number(idx);
    for (const c of pool) {
      const s = c.instanceScores[i];
      if (s !== undefined && s >= best - EPSILON) {
        wins.set(c.candidateId, (wins.get(c.candidateId) ?? 0) + 1);
      }
    }
  }
  return wins;
}

// The Pareto frontier: candidates that win on at least one instance.
export function paretoFrontier(pool: ScoredCandidate[]): string[] {
  return [...winCounts(pool).keys()];
}

// Sample a parent from the frontier, weighted by win count. GEPA biases toward candidates
// that win on more instances while keeping every diverse winner reachable (so the search
// doesn't collapse to a single best-average local optimum). `random` is a value in [0, 1)
// supplied by the caller. Returns the last frontier member for float-rounding edges, and
// falls back to the last pool member when no candidate has any score yet (degenerate input),
// so it never returns undefined.
export function sampleParent(pool: ScoredCandidate[], random: number): string {
  const entries = [...winCounts(pool).entries()];
  if (entries.length === 0) return pool[pool.length - 1]?.candidateId ?? "";

  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let threshold = random * total;
  for (const [candidateId, w] of entries) {
    threshold -= w;
    if (threshold < 0) return candidateId;
  }
  return entries[entries.length - 1][0];
}

// Accept/reject gate for reflective mutation: keep the child only if it strictly beats the
// parent on the minibatch. GEPA rejects ties so a mutation never drifts in for no measured gain.
export function accepts(childScore: number, parentScore: number): boolean {
  return childScore > parentScore;
}

// Did the candidate strictly improve the per-instance best on at least one instance? This is
// the "frontier gain" the plateau backstop watches: an accepted child that beats no instance
// max (it won on average but expands the frontier nowhere) still counts toward the plateau.
export function improvesFrontier(
  maxima: Record<number, number>,
  candidate: ScoredCandidate
): boolean {
  for (const [idx, score] of Object.entries(candidate.instanceScores)) {
    const i = Number(idx);
    if (!(i in maxima) || score > maxima[i] + EPSILON) return true;
  }
  return false;
}
