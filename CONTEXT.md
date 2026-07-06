# Baseline

An LLM evaluation platform where teams author rubrics and run evaluations against AI outputs.

## Language

### Access & Membership

**Team**:
A group of users who share ownership of rubrics and eval runs. Backed by an `organizations` row plus `memberships` (Supabase Auth has no org primitive, so we own this). Every rubric belongs to exactly one Team.
_Avoid_: Organization, org, group, workspace

**Contributor**:
A Team member who can create, edit, and delete any rubric or eval run within the team, and manage team membership. Stored as the `admin` membership role (`canWrite`).
_Avoid_: Admin, editor, owner

**Readonly Member**:
A Team member who can view rubrics and eval run results but cannot create, edit, delete, or run anything. Stored as the `member` membership role.
_Avoid_: Viewer, guest

**Invitation**:
A Contributor's email-addressed invite of one specific person into an existing Team, granting a membership role and nothing else — no billing benefit. Distinct from an Access Code.
_Avoid_: Invite code, team code

**Access Code**:
A bearer code a new customer presents at sign-up, redeemable a capped number of times before an optional expiry. While sign-up is gated, presenting one is the only way to create an account without an Invitation; a code may also carry a billing benefit — a card-required trial or a discount, optionally restricted to one Plan. Once the gate lifts, an Access Code carries only its billing benefit.
_Avoid_: Invite code, promo code, coupon, referral code

**Redemption**:
One use of an Access Code, claimed at sign-up by the person presenting it. Its billing benefit binds to the first Team the redeemer creates and is evaluated exactly once, at that Team's first checkout — applied if the chosen Plan matches the code's restriction, forfeited (with warning) if not. Joining someone else's Team never transfers it.
_Avoid_: Claim, code use, activation

### Evaluation

**Rubric**:
A structured definition of how an LLM output should be evaluated: scenario, expected outcome, evaluation mode, and weighted criteria. Owned by a Team, not an individual.
_Avoid_: Template, evaluation template, scoring guide

**Criterion**:
A single named dimension within a Rubric, with a weight and a set of scoring steps.
_Avoid_: Rule, dimension, metric

**Eval Run**:
A batch execution of a Rubric against one or more input rows. Belongs to a Rubric; visible to all members of the owning Team.
_Avoid_: Evaluation, job, execution, run

**Eval Run Row**:
A single input record within an Eval Run: user input, agent output, and optional expected output and retrieval context.
_Avoid_: Row, input, sample

**Run History**:
The time-ordered sequence of a Rubric's Eval Runs — all of them, including failed and skipped ones, however old. Optimization Runs are not part of it.
_Avoid_: Timeline, activity, run log

**Latest Score**:
A Rubric's most recent overall score: the score of its newest completed Eval Run, regardless of how long ago it ran. Once a Rubric has one completed run it always has a Latest Score — going quiet doesn't erase it.
_Avoid_: Current score, window score, recent score

### Scheduling

**Schedule**:
A recurring definition that spawns Eval Runs on a cadence, evaluating a Rubric against a connected System. Owned by a Team. A Schedule is a recipe — it produces Eval Runs, it is not itself one.
_Avoid_: Job, cron, task

**Connection**:
A Team-owned, reusable definition of how Baseline reaches a System. An `agent` Connection is one Baseline invokes to produce outputs live — either an **external endpoint** (the Team's own API) or a **Managed Agent** (Baseline's managed LLM running a Team-supplied prompt); a `dataset` Connection is a source Baseline reads historical input/output rows from. Referenced by Schedules and the optimization loop.
_Avoid_: Integration, datasource, bare "endpoint"

**System**:
The thing under evaluation that a Connection points at — an agent or model behind an API. May be the Team's own external agent, or Baseline's Managed Agent.
_Avoid_: Model, bot

**Managed Agent**:
An `agent` Connection whose System is Baseline's managed LLM running a Team-supplied prompt, rather than an external endpoint. Its prompt is a single Module, so an Optimization Run on a Managed Agent improves that one prompt directly — no external API to connect. Baseline runs the model, so the System's own inference draws on the Team's key for that provider (BYO if present, otherwise the Managed Key) — unlike an external agent, whose inference Baseline never pays for. A Managed Agent is a paid-plan feature: because it runs on the Managed Key, a Free Team can't use one. Selectable anywhere an agent Connection is — Optimization Runs, Eval Runs, and Schedules — on a paid plan only; in an Eval Run or Schedule its single Module's stored prompt runs as-is (no evolution), scored by the Rubric like any other System.
_Avoid_: Managed prompt, hosted agent, internal agent

### Optimization

**Optimization Run**:
A bounded search that evolves a connected agent's prompts to score better against a Rubric, by repeatedly proposing and testing prompt variants over a frozen set of input instances. Owned by a Team. Produces Candidates and Rollouts — it is not an Eval Run and does not appear in a Rubric's run history.
_Avoid_: Training run, tuning job, experiment

**Optimization Mode**:
How an Optimization Run searches for a better prompt. Baseline offers two: **Simple**, which samples scored rewrite Candidates and keeps the best, and **Reflective** (the GEPA technique), which learns from the Rubric's natural-language feedback on recent Rollouts. Reflective is the only Mode for an external agent; for a paste-a-prompt Managed Agent, Simple is the default and a Team can switch to Reflective.
_Avoid_: Strategy, algorithm, engine

**Simple Mode**:
An Optimization Mode that improves a Managed Agent's single pasted prompt by generating random rewrite Candidates, scoring each against the Rubric over the frozen Instance set, and keeping the highest-scoring few to vary further — concentrating on score alone, with no Reflection. The default for a paste-a-prompt Managed Agent and suited to narrow tasks where feedback isn't needed (e.g. a JSON formatter); for a more demanding Rubric, a Team switches to Reflective.
_Avoid_: Quick mode, basic mode, random mode

**Module**:
A single named, independently-optimizable prompt within a connected agent. An agent has one or more Modules; the agent's Connection declares them. An Optimization Run improves one Module at a time.
_Avoid_: Component, step, node, sub-prompt

**Candidate**:
A specific set of prompts — one per Module — under test within an Optimization Run. Each Candidate is scored across the run's frozen instance set; the run returns the best one.
_Avoid_: Variant, individual, generation

**Instance**:
A single frozen input an Optimization Run scores every Candidate against — a user input with optional expected output and retrieval context. The set is fixed when the run starts, so every Candidate is judged on identical inputs.
_Avoid_: Row, sample, case, example

**Rollout**:
A single execution of a Candidate against an Instance, scored by the Rubric — the Optimization Run's internal unit of measurement. Distinct from an Eval Run: a Rollout is optimizer-internal and not directly visible to the Team.
_Avoid_: Trial, sample, run, attempt

**Reflection**:
The step that proposes a new prompt for a Module by reading its current prompt together with the Rubric's reasoning on recent Rollouts. Reflection is how a **Reflective** Optimization Run improves — it learns from natural-language feedback, not a score alone. A Simple Mode run does not reflect.
_Avoid_: Mutation, rewrite, tuning

### Billing

**Plan**:
The pricing tier a Team subscribes to (Free, Builder, Scale, Enterprise). Determines included Eval Points, included Optimization Runs, seat limits, retention, and the Managed Key markup. A Team has exactly one Plan.
_Avoid_: Tier, subscription level, package

**Eval Point**:
The unit a Team's Eval Runs consume, measuring platform work — orchestration and criterion scoring. Never includes token costs. Optimization Runs draw from their own per-Plan run allowance first and stay point-free within it; a paid Team's run *past* that allowance meters Eval Points too — one per scored Rollout's criteria work, the same measure as an eval row (ADR-0016). Free stays hard-walled (no points-funded path).
_Avoid_: Credit, token, usage unit

**Managed Key**:
A Baseline-owned LLM provider key a Team runs on. Token spend is metered and billed to the Team at provider cost plus the Plan's markup, as its own invoice line.
_Avoid_: Hosted key, platform key

**BYO Key**:
A Team's own LLM provider key; token costs are paid by the Team directly to the provider and never appear on a Baseline invoice.
_Avoid_: Customer key, own key

**Managed Spend Cap**:
A Team's hard monthly ceiling on Managed Key token spend. Defaulted by Plan, visible to and raisable by the Team; once reached, runs on Managed Keys refuse to start until the cap is raised or the month rolls over.
_Avoid_: Budget, quota, spending limit

**Retention Window**:
The Plan-determined span of Run History a Team can access. Runs aging out of the window are soft-deleted — recoverable by upgrade for 30 days — then permanently purged.
_Avoid_: Data retention limit, history limit, archive policy

**Overage Cap**:
A Team's opted-in monthly ceiling on usage beyond the Plan's included allotment — Eval Points, and (past the included run count) Optimization Runs, both now denominated in Eval Points and billed at the Plan's point overage rate (ADR-0016). Absent an Overage Cap, a Team hard-stops at its included allotment. Set by the Team, never defaulted on.
_Avoid_: Overage limit, soft limit, burst allowance

**Point Ledger**:
The append-only, Team-visible record of Eval Point activity: period grants, reservations made when a run is created, settlements when it reaches a terminal state, and releases of unused reservations. A Team's balance is always the sum of its ledger.
_Avoid_: Balance, credits table, usage log

**Cancellation**:
A Team's downgrade from a paid Plan to Free, scheduled when requested and taking effect at the end of the current billing period. Paid access continues until then, no mid-period refunds, and the Team can reverse it any time before it takes effect — as with any scheduled downgrade.
_Avoid_: Unsubscribe, termination, account closure

## Example dialogue

> "Who can delete a rubric?"
> "Any Contributor on the team that owns it — not just the person who created it."

> "Can a Readonly Member kick off an Eval Run?"
> "No. They can see the results of runs Contributors have started, but they can't create new ones."

> "I want to share our rubric with a consultant for review."
> "Invite them as a Readonly Member — they'll see everything but can't change anything."
