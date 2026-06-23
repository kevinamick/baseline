// Elite selection for Simple Mode (#316, ADR-0015) — the Monte Carlo analog of gepa/pareto.ts.
// Pure and sandbox-safe (no node built-ins, no I/O) so the Temporal workflow imports it directly
// and unit tests drive it without a DB. Selection is by overall full-set score alone: there is
// no Pareto frontier and no per-instance vector, only "keep the top-k, sample one to rewrite".

export interface ScoredSimpleCandidate {
  candidateId: string;
  // The Candidate's overall score on the full frozen Instance set.
  score: number;
}

// Keep the top-k Candidates by overall score, highest first. JS sort is stable, so ties hold
// their incoming order (earlier-discovered Candidate wins a tie). k <= 0 yields an empty set.
export function topK(pool: ScoredSimpleCandidate[], k: number): ScoredSimpleCandidate[] {
  if (k <= 0) return [];
  return [...pool].sort((a, b) => b.score - a.score).slice(0, k);
}

// Sample one elite to rewrite. `rand` is a [0,1) draw sourced in the workflow (replay-safe).
// Uniform across the elite set — the concentration is in the set being the top-k, not in any
// weighting within it (contrast GEPA's win-weighted Pareto sampler).
export function sampleElite(elites: ScoredSimpleCandidate[], rand: number): string {
  const i = Math.min(Math.floor(rand * elites.length), elites.length - 1);
  return elites[Math.max(i, 0)].candidateId;
}

// Did a Candidate scoring `score` beat every Candidate already in `pool`? Drives the plateau
// backstop — a round with no new best advances the no-improvement streak.
export function improvesBest(pool: ScoredSimpleCandidate[], score: number): boolean {
  let best = -Infinity;
  for (const c of pool) if (c.score > best) best = c.score;
  return score > best;
}
