# Baseline

An LLM evaluation platform where teams author rubrics and run evaluations against AI outputs.

## Language

### Access & Membership

**Team**:
A group of users who share ownership of rubrics and eval runs. Backed by a Clerk Organization. Every rubric belongs to exactly one Team.
_Avoid_: Organization, org, group, workspace

**Contributor**:
A Team member who can create, edit, and delete any rubric or eval run within the team, and manage team membership. Maps to the `org:admin` Clerk role.
_Avoid_: Admin, editor, owner

**Readonly Member**:
A Team member who can view rubrics and eval run results but cannot create, edit, delete, or run anything. Maps to the `org:member` Clerk role.
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

## Example dialogue

> "Who can delete a rubric?"
> "Any Contributor on the team that owns it — not just the person who created it."

> "Can a Readonly Member kick off an Eval Run?"
> "No. They can see the results of runs Contributors have started, but they can't create new ones."

> "I want to share our rubric with a consultant for review."
> "Invite them as a Readonly Member — they'll see everything but can't change anything."
