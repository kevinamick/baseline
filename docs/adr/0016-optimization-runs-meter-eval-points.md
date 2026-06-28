# Optimization Runs meter as Eval Points past the included run allowance

Supersedes the paragraph in ADR-0008 ("Meter 1 — Eval Points") that read
"Optimization Runs do not consume Eval Points; they draw from their own per-plan
run allowance ... We rejected metering Rollouts as Eval Points." That rejection
was made to keep the published "included runs" line honest. We keep the included
runs line honest a different way — by keeping it — and meter only what exceeds it.

**Decision.** An Optimization Run's platform work is priced in Eval Points by the
same formula as an Eval Run, per scored rollout:

    points = scored_rollouts × (base + per_criterion × |criteria|)   // base 10, per_criterion 5

reserved worst-case at creation as `budget_rollouts × (base + per_criterion×|criteria|)`
and settled at terminal state to the rollouts actually scored (the count of
distinct rollouts in `rollout_results`), releasing the remainder — the exact
reserve/settle/release contract of ADR-0009, on the same `point_ledger` (now keyed
by `opt_run_id` as well as `eval_run_id`). Unlike the eval settle, COMPLETED also
settles to the actual scored count: the reservation is the budget ceiling, and a
run almost always scores fewer rollouts than its budget (the loops stop early).

The per-plan included run-count allowance STAYS as the included benefit. A run
within the allowance reserves one run-allowance unit and costs zero points. Once
the allowance is exhausted, additional runs are allowed but reserve points instead
of hard-blocking — optimization overage is now denominated in Eval Points and flows
through the point meter's existing overage and shared Overage Cap (#183). The flat
per-run dollar overage (`optimizationRunOverageUsd`) is removed: one overage
currency (points) across both platform consumables is more legible than a points
line plus a dollars-per-run line.

**Free stays blocked (captain decision).** Free keeps 0 included Optimization Runs
and `maxBudgetRollouts` 0; the existing Free hard-stop / upgrade wall in
`startOptimizationRun` stays. The points-overage path is paid-only — only Builder
and Scale fall through to it once their included run-count is exhausted. Free is not
given a points-funded optimization path in this change.

**Per-run ceiling bounds worst-case point cost.** A run's worst-case reservation
is `maxBudgetRollouts × per-rollout cost`, so the per-plan `budget_rollouts`
ceiling is also the cap on how much a single run can draw: Free 0 (no runs),
Builder 200, Scale 400. Scale is deliberately 400 (not higher): it caps a single
run's worst case at ~6% of the 500k point allotment, keeping Scale's worst-case
season in line with Builder rather than letting one run drain a large share of
the allowance.

**Consequences.**
- Points remain a pure measure of platform work, computable before a run starts.
  What varies per run is whether that work is covered by the included-run benefit
  (free) or charged as overage — not the measure itself. A paid Team's 15th run is
  free; its 16th costs the run's full point cost. This included-then-metered cliff
  is the same shape Eval Points already have at the dollar layer.
- The ADR-0008 invariant "flat fees never absorb token costs" is untouched: token
  economics still live entirely on the managed dollar meter (Meter 2), which this
  change does not touch. An optimization on a managed key pays points (platform
  work) and managed dollars (tokens) independently, exactly as a managed eval run
  already does — no double-count.
- The run-count meter no longer needs to go negative; its negative-balance term in
  the cross-meter cap projection becomes inert, so `projected_overage_usd` collapses
  to a single (points) term and the run-overage rate is gone.
- Pre-run visibility: the optimization wizard shows the projected point cost
  (`budget_rollouts × per-rollout cost`) for paid Teams, mirroring the eval run
  dialog — "Included run" within the allowance, "up to N Eval Points" past it.

**Migration / back-compat.** Forward-only. In-flight runs at deploy hold only a
run-unit reservation; the legacy unit settle is unchanged and still closes them. The
point reserve/settle applies only to runs created after deploy (the settle is a no-op
when no point reservation exists, like the eval settle for unmetered runs).
`point_ledger` gains a nullable `opt_run_id` with its own partial unique indexes; the
`eval_run_id` columns and indexes are untouched. The reaper sweep-settles point
reservations alongside the unit reservations. Historical `overage_invoice_lines` rows
with `meter = 'runs'` still read and bill at their pinned `unit_usd`; no new run-meter
overage line is produced.

Decision principle (ADR-0008): billing transparency — every charge maps to a ledger
line the customer can verify. Metering optimization work in the same points the eval
ledger already shows, instead of an opaque parallel dollars-per-run line, serves that
principle.
