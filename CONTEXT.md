# Baseline

An LLM evaluation platform: author rubrics and run evaluations against AI outputs, on your own machine with your own provider keys.

## Language

### Workspace

**Workspace**:
The one implicit owner of every Rubric, Connection, Schedule, and run in a Baseline install. There is no sign-in: whoever reaches the running app is the Workspace's sole Contributor (ADR-0020). Backed by a single fixed `organizations` row that every tenant table's `org_id` points at.
_Avoid_: Team, organization, org, account, tenant

**Contributor**:
The person using the Workspace. Creates, edits, deletes, and runs everything; there is no read-only role.
_Avoid_: Admin, editor, owner, member, user

### Evaluation

**Rubric**:
A structured definition of how an LLM output should be evaluated: scenario, expected outcome, evaluation mode, and weighted criteria. Owned by the Workspace.
_Avoid_: Template, evaluation template, scoring guide

**Criterion**:
A single named dimension within a Rubric, with a weight and a set of scoring steps.
_Avoid_: Rule, dimension, metric

**Eval Run**:
A batch execution of a Rubric against one or more input rows. Belongs to a Rubric.
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
A recurring definition that spawns Eval Runs on a cadence, evaluating a Rubric against a connected System. Owned by the Workspace. A Schedule is a recipe — it produces Eval Runs, it is not itself one.
_Avoid_: Job, cron, task

**Connection**:
A Workspace-owned, reusable definition of how Baseline reaches a System. An `agent` Connection is one Baseline invokes to produce outputs live — either an **external endpoint** (your own API) or a **Managed Agent** (Baseline's managed LLM running a Workspace-supplied prompt); a `dataset` Connection is a source Baseline reads historical input/output rows from. Referenced by Schedules and the optimization loop.
_Avoid_: Integration, datasource, bare "endpoint"

**System**:
The thing under evaluation that a Connection points at — an agent or model behind an API. May be your own external agent, or Baseline's Managed Agent.
_Avoid_: Model, bot

**Managed Agent**:
An `agent` Connection whose System is Baseline's managed LLM running a Workspace-supplied prompt, rather than an external endpoint. Its prompt is a single Module, so an Optimization Run on a Managed Agent improves that one prompt directly — no external API to connect. Baseline runs the model, so the System's own inference draws on the Workspace's Provider Key for that provider. Selectable anywhere an agent Connection is — Optimization Runs, Eval Runs, and Schedules; in an Eval Run or Schedule its single Module's stored prompt runs as-is (no evolution), scored by the Rubric like any other System.
_Avoid_: Managed prompt, hosted agent, internal agent

### Optimization

**Optimization Run**:
A bounded search that evolves a connected agent's prompts to score better against a Rubric, by repeatedly proposing and testing prompt variants over a frozen set of input instances. Owned by the Workspace. Produces Candidates and Rollouts — it is not an Eval Run and does not appear in a Rubric's run history.
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

**Golden Output**:
An Instance's expected output as an Optimization Run treats it: an authoritative example of a perfect response for that input, not a loose hint. When present, scoring judges a Candidate's output for whether it achieves the same outcome — outcome-equivalence, never textual similarity. The same field on an Eval Run Row stays optional context for the judge — the strength is a property of optimization, not of the data. There is no separate golden entity or flag, and mixed Instance sets (some rows with a Golden Output, some without) are normal. Internal term only: every user-facing surface calls the field "expected output."
_Avoid_: Golden data set (as an entity), ground truth, label, reference output

### Keys

**Provider Key**:
The Workspace's own LLM provider key, the one thing a run needs. Saved under Settings (stored encrypted in Vault) or supplied to the worker as an environment variable such as `ANTHROPIC_API_KEY`; a saved key wins over the environment for that provider. Token costs go straight to the provider; nothing is metered or capped by Baseline.
_Avoid_: BYO key, managed key, platform key

## Example dialogue

> "Who can delete a rubric?"
> "Any Contributor on the team that owns it — not just the person who created it."

> "Can a Readonly Member kick off an Eval Run?"
> "No. They can see the results of runs Contributors have started, but they can't create new ones."

> "I want to share our rubric with a consultant for review."
> "Invite them as a Readonly Member — they'll see everything but can't change anything."
