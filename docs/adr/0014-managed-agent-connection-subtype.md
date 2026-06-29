# Managed Agent: optimize a prompt against Baseline's managed LLM, modeled as an agent Connection subtype

To let a Team optimize a prompt without standing up an external agent, we run the
user's pasted prompt directly on Baseline's managed LLM and optimize *that* — a
**Managed Agent**. Rather than give it a separate run-local storage path, we model it
as a **subtype of the existing `agent` Connection** (`agent_kind = 'managed'`), so the
Optimization Run's whole spine — `connection_id` FK, `seedRun`/`rolloutCandidate`,
`optimizable_prompts` seeds, the Candidate/prompt-diff machinery, and the start wizard —
is reused unchanged, and the optimized prompt stays a first-class, re-runnable (later
schedulable) System. The cost is a small widening of the glossary: a Connection no longer
only reaches an *external* System.

## Status

Accepted.

## Considered options

**Run-local prompt (rejected).** Store the pasted prompt + target model directly on
`optimization_runs` with a nullable `connection_id`, no Connection at all. Lighter and a
closer match to the "just paste a prompt" feel, but it forks `seedRun`/`rolloutCandidate`
into "Connection vs no-Connection" branches, breaks the "an Optimization Run optimizes a
System reached via a Connection" invariant, and leaves the result non-reusable and
non-schedulable. We chose spine-reuse + reusability over the marginally simpler storage.

## Consequences

- **Execution.** A managed rollout swaps `invokeAgent(endpoint…)` for a direct
  `AnthropicProvider` call: the Module prompt becomes the system message, the Instance's
  `user_input` the user turn. No `request_template`, no `response_path`, no `{{…}}`
  templating.
- **Schema.** `connections.endpoint` / `response_path` / `request_template` become
  nullable, gated by a CHECK — `external` requires endpoint + response_path; `managed`
  requires a new `target_model` and forbids endpoint. The single Module lives in
  `optimizable_prompts` as today (`name = 'system'`).
- **Model choice.** The **target model** (what the prompt is optimized *for*) is
  user-selectable, defaulting to Haiku 4.5; it is independent of the reflect model. A
  prompt optimized for one model is a model-specific artifact.
- **Billing.** Baseline now runs the System, so its inference is metered and counts
  against the Managed Spend Cap exactly like judge tokens — and is the *dominant* spend
  term (≈ `target_model_price × budget_rollouts × instances`), so the pre-run estimate
  must include it. A paid Team with a BYO key for the provider runs it unmetered, per
  `resolve-key`.
- **Plan gate.** A Managed Agent is a paid-plan feature — it runs on the Managed Key,
  which Free Teams can't use. Optimization Runs are *already* Free-gated, so that surface
  needs no new gate; but a Managed Agent is also selectable in **Eval Runs**, **Schedules**,
  and the **Connections settings page** ("Add connection" dialog, #353), which *are* available
  on Free. So those surfaces need a new managed-specific gate: a Free Team is refused at
  eval-run start / schedule-create / `createConnection`, and the managed option is disabled
  (with an upsell) in their pickers, with `resolve-key` → `none` as the fail-closed backstop.
  The `createConnection` server action is the server-authoritative gate for the settings
  surface (`managedMarkupPct == null` ⇒ error); the UI disables the type button and shows an
  upgrade CTA but does not rely on that alone. In an Eval Run or Schedule the Managed Agent's
  single stored Module prompt runs as-is (no evolution), scored by the Rubric like any other
  System.
- **Security.** A Managed Agent makes no outbound HTTP, so it sidesteps the connections
  SSRF exposure entirely — there is no URL to point at an attacker.
