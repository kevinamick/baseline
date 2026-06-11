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
A Team-owned, reusable definition of how Baseline reaches an external System. An `agent` Connection is an endpoint Baseline invokes to produce outputs live; a `dataset` Connection is a source Baseline reads historical input/output rows from. Referenced by Schedules (and, later, the optimization loop).
_Avoid_: Integration, datasource, bare "endpoint"

**System**:
The thing under evaluation that a Connection points at — an agent or model behind an API.
_Avoid_: Model, bot

### Optimization

**Optimization Run**:
A bounded search that evolves a connected agent's prompts to score better against a Rubric, by repeatedly proposing and testing prompt variants over a frozen set of input instances. Owned by a Team. Produces Candidates and Rollouts — it is not an Eval Run and does not appear in a Rubric's run history.
_Avoid_: Training run, tuning job, experiment

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
The step that proposes a new prompt for a Module by reading its current prompt together with the Rubric's reasoning on recent Rollouts. Reflection is how an Optimization Run improves — it learns from natural-language feedback, not a score alone.
_Avoid_: Mutation, rewrite, tuning

## Example dialogue

> "Who can delete a rubric?"
> "Any Contributor on the team that owns it — not just the person who created it."

> "Can a Readonly Member kick off an Eval Run?"
> "No. They can see the results of runs Contributors have started, but they can't create new ones."

> "I want to share our rubric with a consultant for review."
> "Invite them as a Readonly Member — they'll see everything but can't change anything."
