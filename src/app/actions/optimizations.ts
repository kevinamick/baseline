"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { requireContributor } from "@/lib/auth/require-contributor";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tenantDb } from "@/lib/supabase/tenant-db";
import { track } from "@/lib/analytics/server";
import { log } from "@/lib/logging/server";
import { getTemporalClient } from "@/lib/temporal/client";
import {
  OPTIMIZATION_RETRY_NOW_SIGNAL,
  OPTIMIZATION_TASK_QUEUE,
} from "@/lib/temporal/connection";
import { CreateOptimizationRunSchema } from "@/lib/validation/schemas";
import { firstIssueMessage } from "@/lib/validation/first-issue";
import {
  DEFAULT_SIMPLE_REFLECT_MODEL,
  providerForReflectModel,
  PROVIDER_DEFAULT_REFLECT_MODEL,
} from "@/lib/optimization/models";
import { isModelAvailableForProvider, liveModelsByProviderForOrg } from "@/lib/llm/live-models";
import { usableProvidersForOrg } from "@/lib/llm/usable-providers";
import { PROVIDER_LABELS, type LlmProvider } from "@/lib/llm/providers";
import { insertConnection } from "@/lib/connections/create";
import { snapshotDatasetInstances } from "@/lib/optimization/dataset-snapshot";
import { resolveEvalRunInstances } from "@/lib/optimization/eval-run-instances";
import {
  MAX_BUDGET_ROLLOUTS,
  maxViableInstances,
  minimumViableBudget,
} from "@/lib/optimization/budget";
import { KEY_SOURCE, resolveKeySource, missingKeyError } from "@/lib/llm/key-gate";
import { ESTIMATE_REFLECT_MODEL, isKnownModel } from "@/lib/llm/model-prices";
import {
  ACTIVE_OPTIMIZATION_STATUSES,
  isActiveOptimizationStatus,
  type OptimizationRunStatus,
  type OptimizationRunSummary,
} from "@/types/optimization";

// ---------- Wizard live models (#485) ----------

// The BYO providers' LIVE model lists for the optimization wizard, loaded ON DEMAND when the
// wizard opens rather than during the optimizations page render (#488). The live listing hits each
// BYO provider's list-models API, so folding it into the page render blocked TTFB up to the
// module's 3s timeout on a slow/unreachable provider; fetching it here — from a client-initiated
// server action the layout fires when "New run" is clicked — keeps the page's curated content off
// that latency entirely. Org-scoped off the auth context (never a client-passed provider list, so
// a caller can't probe another Team's key state); readonly members may call it since it only reads
// a catalog. Any failure resolves to an empty map — exactly the curated-only wizard — because
// liveModelsByProviderForOrg never throws.
export async function loadWizardLiveModels(): Promise<Partial<Record<LlmProvider, string[]>>> {
  const { orgId } = await getAuthContext();
  if (!orgId) return {};
  const usable = await usableProvidersForOrg(orgId);
  return liveModelsByProviderForOrg(
    orgId,
    usable.map((p) => p.provider),
  );
}

// ---------- Start ----------

// Start a manual, one-shot Optimization Run (#87). Authz (Contributor), resolve the instance
// set (inline rows, a dataset-Connection snapshot, #82, or an existing Eval Run's rows, #83)
// into a frozen set, enforce one active run per org, then start the durable Temporal workflow.
// Per ADR-0006 the workflow carries only the run id — Activities read the prompts/instances and
// write rollouts/results back to Postgres.
export async function startOptimizationRun(
  input: z.input<typeof CreateOptimizationRunSchema>
): Promise<{ optRunId: string } | { error: string }> {
  const gate = await requireContributor("start optimization runs");
  if ("error" in gate) return gate;
  const { ctx, userId, orgId } = gate;

  const parsed = CreateOptimizationRunSchema.safeParse(input);
  if (!parsed.success) {
    return { error: firstIssueMessage(parsed.error, "Invalid optimization run") };
  }
  const o = parsed.data;

  // Resolve the run's frozen instance set FIRST (#82, #83) — before any Run Gate call and before
  // the run row exists. 'inline' is a no-op (the wizard already resolved manual/CSV/JSON rows
  // client-side). 'dataset_snapshot' does the ONE fetch here: an org-scoped Connection lookup,
  // its credential decrypt, then a bounded adapter read over the chosen window. 'eval_run' does
  // an org-scoped read of an existing Eval Run's rows (#83), capped/ordered/agent_output-dropped
  // by resolveEvalRunInstances. Either way billing (which prices off instances.length), freezing
  // into optimization_inputs, and validation are byte-for-byte identical to the inline source,
  // and the worker needs no changes at all. An empty result or an unresolvable source (unreachable
  // Connection, unknown/foreign eval_run_id, a source with zero rows) refuses cleanly right here:
  // nothing has been created yet, so there is no run row or reservation to roll back.
  let instances: {
    userInput: string;
    expectedOutput?: string | null;
    retrievalContext?: string | null;
  }[];
  if (o.instancesSource.type === "inline") {
    instances = o.instancesSource.instances;
  } else if (o.instancesSource.type === "eval_run") {
    const resolved = await resolveEvalRunInstances(orgId, o.instancesSource.evalRunId);
    if ("error" in resolved) {
      return {
        error:
          resolved.error === "not_found"
            ? "Eval run not found"
            : "That eval run has no rows to seed instances from — pick another eval run.",
      };
    }
    instances = resolved.instances;
  } else {
    const { connectionId: datasetConnectionId, windowMinutes } = o.instancesSource;
    const { data: dsConn, error: dsConnErr } = await tenantDb(ctx)
      .from("connections")
      .select(
        "id",
        "kind",
        "provider",
        "endpoint",
        "auth_header",
        "auth_secret_id",
        "request_template",
        "response_path",
        "config"
      )
      .eq("id", datasetConnectionId)
      .maybeSingle();
    if (dsConnErr) throw dsConnErr;
    if (!dsConn) return { error: "Dataset connection not found" };
    if (dsConn.kind !== "dataset") {
      return { error: "Select a dataset connection to snapshot instances from" };
    }

    // Decrypt the Connection's credential (full header value), mirroring the worker's own
    // getAuthValue (worker/src/evalrun/activities.ts) — same RPC, same service-role grant.
    let authValue: string | null = null;
    if (dsConn.auth_secret_id) {
      const { data: secret, error: secretErr } = await supabaseAdmin.rpc("get_connection_auth", {
        p_secret_id: dsConn.auth_secret_id,
      });
      if (secretErr) {
        await log.error("dataset instance snapshot credential read failed", {
          event: "optimization_run.dataset_snapshot_credential_failed",
          org_id: orgId,
          connection_id: dsConn.id,
          error: secretErr,
        });
        return { error: "Couldn't read that Connection's credential. Please try again." };
      }
      authValue = (secret as string | null) ?? null;
    }

    const snapshot = await snapshotDatasetInstances(
      {
        id: dsConn.id,
        kind: dsConn.kind,
        provider: dsConn.provider,
        endpoint: dsConn.endpoint,
        auth_header: dsConn.auth_header,
        auth_secret_id: dsConn.auth_secret_id,
        request_template: dsConn.request_template,
        response_path: dsConn.response_path,
        config: dsConn.config,
      },
      authValue,
      windowMinutes
    );
    if ("error" in snapshot) {
      const failure = {
        event: "optimization_run.dataset_snapshot_failed",
        org_id: orgId,
        connection_id: dsConn.id,
        error_code: snapshot.error,
        detail: snapshot.detail,
      };
      // Mirrors previewDatasetConnection's escalation: an "endpoint" refusal is the SSRF/egress
      // signal, worth surfacing distinctly from ordinary source misconfiguration.
      if (snapshot.error === "endpoint") {
        await log.error("dataset instance snapshot blocked or unreachable", failure);
      } else {
        await log.warn("dataset instance snapshot failed", failure);
      }
      return { error: "Couldn't fetch rows from that Connection. Please try again." };
    }
    if (snapshot.instances.length === 0) {
      return {
        error:
          "That Connection had no rows in the selected window — pick a wider window or another source.",
      };
    }
    instances = snapshot.instances;
  }

  // Budget floor (#468, prod incident opt-4afa3642): refuse right here, before any Connection or
  // allowance work, a run whose budget can't survive its own seed baseline (a full pass over the
  // now-exact frozen instance set) plus at least one iteration — every budget smaller than the
  // instance count burns the whole budget scoring the seed, the iteration guard then refuses to
  // start iteration 1, and the run "completes" with best = seed and zero lift. instances.length is
  // exact for every source at this point (inline, dataset snapshot, eval run), so this is a hard
  // check, not an estimate. Mode-aware — see src/lib/optimization/budget.ts for why Reflective and
  // Simple Mode have different minimums.
  const minViableBudget = minimumViableBudget(o.mode, instances.length);

  // Budget-shape gates (ADR-0020: the only ceiling is the schema's MAX_BUDGET_ROLLOUTS).
  // For an instance count whose one-round floor exceeds the ceiling, NO budget value
  // satisfies both checks, so name the real remedies up front.
  if (minViableBudget > MAX_BUDGET_ROLLOUTS) {
    const maxInstances = maxViableInstances(o.mode, MAX_BUDGET_ROLLOUTS);
    const simpleFits =
      o.mode === "reflective" &&
      minimumViableBudget("simple", instances.length) <= MAX_BUDGET_ROLLOUTS;
    return {
      error: `${instances.length} instances need a rollout budget of at least ${minViableBudget} for one full optimization round, above the ${MAX_BUDGET_ROLLOUTS} cap. Use up to ${maxInstances} instances${simpleFits ? ", switch to Simple Mode," : ""}.`,
    };
  }
  if (o.budgetRollouts < minViableBudget) {
    return {
      error: `${instances.length} instances need a rollout budget of at least ${minViableBudget} (one full pass to score the seed, plus one iteration). Increase the budget or use fewer instances.`,
    };
  }
  if (o.budgetRollouts > MAX_BUDGET_ROLLOUTS) {
    // The wizard caps its input at the ceiling; be authoritative anyway.
    return { error: `Rollout budget can't exceed ${MAX_BUDGET_ROLLOUTS}.` };
  }

  // Verify the rubric belongs to the Workspace.
  const { data: rubric, error: rubricErr } = await tenantDb(ctx)
    .from("rubrics")
    .select("id")
    .eq("id", o.rubricId)
    .maybeSingle();
  if (rubricErr) throw rubricErr;
  if (!rubric) return { error: "Rubric not found" };

  // Resolve the agent Connection: an existing one (verify ownership + agent kind) or create one
  // inline from the wizard's System step (#108). A Connection created here is rolled back if the
  // run can't be started, so a failed start never leaves an orphan Connection behind.
  let connectionId: string;
  let createdConnectionId: string | null = null;
  // The Managed Agent's target model, if this run's System runs on the managed key (#291). Read
  // here off the authoritative ownership query so the spend estimate below has it without a second
  // round-trip — and with no separate read that could fail silently and drop the dominant term.
  let targetModel: string | null = null;
  if (o.newConnection) {
    const created = await insertConnection(orgId, userId, o.newConnection);
    if ("error" in created) return { error: created.error };
    connectionId = created.connectionId;
    createdConnectionId = created.connectionId;
    // The "Paste a prompt" mode (#293) inline-creates a Managed Agent: carry its target model
    // so the spend estimate below reserves the target-model term, exactly as the existing-managed
    // path does. The external "Connect your agent" mode leaves targetModel null.
    if (o.newConnection.type === "managed_agent") targetModel = o.newConnection.targetModel;
  } else if (o.connectionId) {
    // Only agents expose the {{prompt:*}} Modules an optimization run tunes.
    const { data: connection, error: connErr } = await tenantDb(ctx)
      .from("connections")
      .select("id", "kind", "optimizable_prompts", "agent_kind", "target_model")
      .eq("id", o.connectionId)
      .maybeSingle();
    if (connErr) throw connErr;
    if (!connection) return { error: "Connection not found" };
    if (connection.kind !== "agent") {
      return { error: "Optimization requires an agent connection" };
    }
    // The wizard hides Module-less connections, but be authoritative here too: with no Modules
    // there's nothing to tune — the loop would no-op on the seed and waste a rollout. (A
    // connection's Modules can also be removed after the list was rendered.)
    const moduleCount = Array.isArray(connection.optimizable_prompts)
      ? connection.optimizable_prompts.length
      : 0;
    if (moduleCount === 0) {
      return {
        error: "This agent connection has no optimizable Modules — add at least one to optimize it.",
      };
    }
    connectionId = connection.id;
    if (connection.agent_kind === "managed") targetModel = connection.target_model;
  } else {
    return { error: "Select or create an agent connection" };
  }

  const cleanupCreatedConnection = async () => {
    if (createdConnectionId) {
      await tenantDb(ctx).from("connections").delete().eq("id", createdConnectionId);
    }
  };

  // Simple Mode (ADR-0015) is gated to a paste-a-prompt Managed Agent: it's always single-Module
  // and runs on the managed key, which is what its score-only search assumes. targetModel is set
  // iff the System is a Managed Agent, so it doubles as the managed-ness check. Reject any other
  // System before reserving allowance, rolling back an inline-created Connection.
  const isManagedAgent = targetModel != null;
  if (o.mode === "simple" && !isManagedAgent) {
    await cleanupCreatedConnection();
    return { error: "Simple mode is only available for a paste-a-prompt Managed Agent." };
  }

  // Simple Mode reuses reflect_model as its generation model but defaults it to Haiku (not the
  // column's Sonnet default); an explicit override from the wizard still wins. Reflective runs
  // keep the column default when no override is given.
  const reflectModel =
    o.reflectModel ?? (o.mode === "simple" ? DEFAULT_SIMPLE_REFLECT_MODEL : null);

  // Resolve the run's provider: a run is single-provider, so the key gate must check the
  // provider that will actually run (not a hardcoded Anthropic default, #204).
  //
  // #485: the wizard submits the provider explicitly so a live-listed (non-registry) BYO model
  // can't be misrouted by providerForModel's Anthropic fallback. The claim is re-validated
  // server-side — the model must belong to that provider in the registry, or appear in that
  // provider's live list re-fetched here with the Team's own key (a managed-mode provider has no
  // live list, so it stays curated-only) — never trusted alone. An omitted provider (older
  // clients) keeps the pre-#485 derive-from-model behavior byte for byte.
  //
  // `runProvider` (below) is always derived for the key gate — a run must have a key for the
  // provider it will actually run on. `reflectProvider` (the STAMPED column) is separate: it is written only
  // when the pair was VALIDATED, because the worker treats a non-null reflect_provider as
  // "vouched for" and, for a non-registry id, hands it to the provider verbatim
  // (allowUnlistedReflectModel). Stamping an unvalidated guess there would send a bogus model id
  // to the API and mask a model-not-found as a BYO-key failure. So: an explicit provider that
  // passes re-validation is stamped; an omitted provider is stamped ONLY for a registry model
  // (where the registry IS the validation and the worker's own providerForModel fallback agrees),
  // and left null for a non-registry id so the worker falls back to the registry map exactly as
  // pre-#485 (an unknown model → the provider's default reflect model).
  const effectiveReflectModel = reflectModel ?? ESTIMATE_REFLECT_MODEL;
  let runProvider: LlmProvider;
  let reflectProviderToStamp: LlmProvider | null;
  if (o.reflectProvider) {
    // Validate the model the run will ACTUALLY use for this provider. When the client omits
    // reflectModel but names a provider (a non-shipped path — the wizard always sends the model),
    // the run falls back to that provider's DEFAULT reflect model at execution, so validate that —
    // NOT ESTIMATE_REFLECT_MODEL, an Anthropic id that would wrongly refuse every non-Anthropic
    // provider (#488 finding 4). A registry model of the provider passes without any fetch.
    const validationModel = o.reflectModel ?? PROVIDER_DEFAULT_REFLECT_MODEL[o.reflectProvider];
    const available = await isModelAvailableForProvider(
      orgId,
      o.reflectProvider,
      validationModel,
    );
    if (!available) {
      await cleanupCreatedConnection();
      return {
        error: `${validationModel} isn't available for ${PROVIDER_LABELS[o.reflectProvider]} right now. Pick another model.`,
      };
    }
    runProvider = o.reflectProvider;
    reflectProviderToStamp = o.reflectProvider;
  } else {
    runProvider = providerForReflectModel(effectiveReflectModel);
    reflectProviderToStamp = isKnownModel(effectiveReflectModel) ? runProvider : null;
  }

  // Provider-key gate (#184, ADR-0020): the run's reflect provider — and a Managed Agent's
  // target provider independently — must resolve to a usable key (Vault or env). An
  // Optimization Run is single-provider, so a key for some OTHER provider must not pass.
  const targetProvider = targetModel ? providerForReflectModel(targetModel) : null;
  for (const provider of targetProvider ? [runProvider, targetProvider] : [runProvider]) {
    if ((await resolveKeySource(orgId, provider)) === KEY_SOURCE.none) {
      await cleanupCreatedConnection();
      return { error: missingKeyError(provider) };
    }
  }

  // Insert the run as queued. The partial unique index (one active run per org) rejects a
  // concurrent second start with a 23505 — surface that as a friendly message.
  const { data: run, error: runErr } = await tenantDb(ctx)
    .from("optimization_runs")
    .insert({
      created_by: userId,
      connection_id: connectionId,
      rubric_id: o.rubricId,
      eval_type: o.evalType,
      budget_rollouts: o.budgetRollouts,
      max_iters: o.maxIters,
      plateau_patience: o.plateauPatience ?? null,
      mode: o.mode,
      ...(reflectModel ? { reflect_model: reflectModel } : {}),
      // The VALIDATED provider for the run's reflect/generation model (#485), or null when it
      // wasn't validated (an omitted-provider non-registry model). The worker's key resolution and
      // judge-model derivation read this, falling back to providerForModel when null (pre-#485
      // rows and unvalidated models) — the worker's registry fallback then handles an unknown id.
      reflect_provider: reflectProviderToStamp,
      status: "queued",
    })
    .select("id")
    .single();

  if (runErr || !run) {
    await cleanupCreatedConnection();
    if (runErr?.code === "23505") {
      return { error: "An optimization run is already active for this team" };
    }
    await log.error("optimization_runs insert failed", {
      event: "optimization_run.create_failed",
      org_id: orgId,
      error: runErr,
    });
    return { error: "Failed to start optimization run" };
  }

  // On any failure below, delete the run row so the Workspace isn't left with a stuck active
  // run blocking future starts (frees the partial-unique slot), and roll back any
  // inline-created Connection. Nothing else to release (ADR-0020: no reservations).
  const deleteRun = async () => {
    await tenantDb(ctx).from("optimization_runs").delete().eq("id", run.id);
    await cleanupCreatedConnection();
  };

  // Freeze the manually provided instances. On failure, delete the run row so the org isn't
  // left with a stuck active run blocking future starts (and frees the partial-unique slot),
  // and roll back any inline-created Connection.
  const { error: inputsErr } = await supabaseAdmin.from("optimization_inputs").insert(
    instances.map((row, i) => ({
      opt_run_id: run.id,
      instance_index: i,
      user_input: row.userInput,
      expected_output: row.expectedOutput ?? null,
      retrieval_context: row.retrievalContext ?? null,
    }))
  );
  if (inputsErr) {
    await log.error("optimization_inputs insert failed", {
      event: "optimization_run.inputs_insert_failed",
      opt_run_id: run.id,
      error: inputsErr,
    });
    await deleteRun();
    return { error: "Failed to save the input set" };
  }

  // Start the durable workflow by string name — workflow code must never enter the Next
  // bundle (it runs only inside the Temporal worker's sandbox).
  const workflowId = `opt-${run.id}`;
  try {
    const client = await getTemporalClient();
    // Dispatch by Mode (ADR-0015): Simple runs the Monte Carlo workflow, everything else GEPA.
    // Both share the task queue and carry only the run id.
    const workflowName =
      o.mode === "simple" ? "runSimpleOptimizationWorkflow" : "runOptimizationWorkflow";
    await client.workflow.start(workflowName, {
      taskQueue: OPTIMIZATION_TASK_QUEUE,
      workflowId,
      args: [{ optRunId: run.id }],
    });
  } catch (err) {
    await log.error("Failed to start optimization workflow", {
      event: "optimization_run.workflow_start_failed",
      opt_run_id: run.id,
      workflow_id: workflowId,
      error: err,
    });
    await deleteRun();
    return { error: "Failed to start optimization run" };
  }

  await tenantDb(ctx)
    .from("optimization_runs")
    .update({ workflow_id: workflowId })
    .eq("id", run.id);

  await log.info("optimization workflow started", {
    event: "optimization_run.workflow_started",
    opt_run_id: run.id,
    workflow_id: workflowId,
    org_id: orgId,
  });

  await track(
    {
      name: "optimization_run.started",
      props: { instance_count: instances.length, budget: o.budgetRollouts },
    },
    { userId }
  );

  revalidatePath("/optimizations");
  return { optRunId: run.id };
}

// ---------- Cancel ----------

// Cancel an active Optimization Run (#109): terminate its Temporal workflow and mark the run
// failed with a "Cancelled by <user>" reason (reusing the terminal `failed` status — no new
// enum). Cancelling frees the org's single active slot immediately, so a misconfigured run no
// longer locks the team out until budget exhaustion or the staleness reaper.
export async function cancelOptimizationRun(
  runId: string
): Promise<{ ok: true } | { error: string }> {
  const gate = await requireContributor("cancel optimization runs");
  if ("error" in gate) return gate;
  const { ctx, userId, orgId } = gate;
  const { email } = ctx;

  // Org-scoped: a caller can only cancel their own team's runs.
  const { data: run, error: runErr } = await tenantDb(ctx)
    .from("optimization_runs")
    .select("id", "status", "workflow_id")
    .eq("id", runId)
    .maybeSingle();
  if (runErr) throw runErr;
  if (!run) return { error: "Optimization run not found" };
  if (!isActiveOptimizationStatus(run.status as OptimizationRunStatus)) {
    return { error: "This run has already finished" };
  }

  const reason = `Cancelled by ${email ?? "a teammate"}`;

  // Terminate the durable workflow if one was started. terminate() is abrupt — the workflow's
  // own failure path doesn't run — so this action is authoritative for the run row below. The
  // workflow may already be gone (it finished between our read and now); log and proceed so the
  // org's active slot still frees.
  if (run.workflow_id) {
    try {
      const client = await getTemporalClient();
      await client.workflow.getHandle(run.workflow_id).terminate(reason);
    } catch (err) {
      await log.error("Failed to terminate optimization workflow", {
        event: "optimization_run.workflow_terminate_failed",
        opt_run_id: runId,
        workflow_id: run.workflow_id,
        error: err,
      });
    }
  }

  // Compare-and-set on the active statuses: if the run reached a terminal state between our
  // read and now (e.g. the workflow's completeRun landed first), the guard makes this a no-op
  // rather than clobbering a legitimately-completed run's result back to failed.
  const { data: updated, error: updErr } = await tenantDb(ctx)
    .from("optimization_runs")
    // paused_reason cleared: a cancelled run is no longer waiting on anything (#102).
    .update({ status: "failed", error_message: reason, paused_reason: null })
    .eq("id", runId)
    .in("status", ACTIVE_OPTIMIZATION_STATUSES)
    .select("id");
  if (updErr) {
    await log.error("Failed to mark optimization run cancelled", {
      event: "optimization_run.cancel_failed",
      opt_run_id: runId,
      error: updErr,
    });
    return { error: "Failed to cancel the run" };
  }
  if (!updated || updated.length === 0) {
    // No active row transitioned — the run finished first. Don't report a false cancel.
    return { error: "This run has already finished" };
  }

  // The allowance unit is NOT settled here: terminate() is abrupt and in-flight
  // activities can still commit rollouts for a few seconds, so settling now
  // could mis-derive "no work happened" and release a consumed unit. The
  // reaper's settlement sweep (~1 min cadence) settles the now-failed run after
  // those writes have quiesced, with the accurate worked/released outcome.

  // A user cancel terminates the workflow abruptly, so the worker never runs
  // completeRun/failRun — this is the only place a cancelled run's terminal
  // transition becomes a queryable Logs record, the cancel parallel to the
  // worker's `optimization_run.completed/failed`.
  await log.info("optimization run cancelled", {
    event: "optimization_run.cancelled",
    opt_run_id: runId,
    org_id: orgId,
  });

  await track({ name: "optimization_run.cancelled", props: {} }, { userId });
  revalidatePath("/optimizations");
  return { ok: true };
}

// ---------- Retry now ----------

// Resume a paused Optimization Run immediately (#102). A run pauses when its agent endpoint
// suffers a sustained outage; the workflow auto-probes on a backoff schedule, but a user who
// knows the endpoint is back can skip the wait — this signals the live workflow, which
// resumes from exactly where it paused. The "Retry now" button (follow-up UI) calls this.
export async function retryOptimizationRun(
  runId: string
): Promise<{ ok: true } | { error: string }> {
  const gate = await requireContributor("retry optimization runs");
  if ("error" in gate) return gate;
  const { ctx, userId, orgId } = gate;

  // Org-scoped: a caller can only retry their own team's runs.
  const { data: run, error: runErr } = await tenantDb(ctx)
    .from("optimization_runs")
    .select("id", "status", "workflow_id")
    .eq("id", runId)
    .maybeSingle();
  if (runErr) throw runErr;
  if (!run) return { error: "Optimization run not found" };
  // The generated DB enum (database.types.ts) predates the "paused" status value
  // (#102) — cast past it, same as cancelOptimizationRun's read of this column.
  if ((run.status as OptimizationRunStatus) !== "paused") {
    return { error: "This run isn't paused" };
  }
  if (!run.workflow_id) return { error: "This run has no workflow to resume" };

  // Signal by name — workflow code must never enter the Next bundle (same rule as starting
  // by string name). Signalling is async on the workflow side: the run flips back to
  // 'running' when the workflow's resume Activity lands, not in this request.
  try {
    const client = await getTemporalClient();
    await client.workflow.getHandle(run.workflow_id as string).signal(OPTIMIZATION_RETRY_NOW_SIGNAL);
  } catch (err) {
    await log.error("Failed to signal optimization workflow", {
      event: "optimization_run.retry_signal_failed",
      opt_run_id: runId,
      workflow_id: run.workflow_id,
      error: err,
    });
    return { error: "Failed to retry the run" };
  }

  await log.info("optimization run retried", {
    event: "optimization_run.retried",
    opt_run_id: runId,
    org_id: orgId,
  });

  await track({ name: "optimization_run.retried", props: {} }, { userId });
  revalidatePath("/optimizations");
  return { ok: true };
}

// ---------- Read ----------

// Resolve a Supabase nested relation (object or single-element array, depending on the
// join) down to its `name`. Mirrors the helper the Schedules layout uses.
function nestedName(rel: unknown): string {
  if (Array.isArray(rel)) return String((rel[0] as { name?: unknown } | undefined)?.name ?? "—");
  if (rel && typeof rel === "object") return String((rel as { name?: unknown }).name ?? "—");
  return "—";
}

// A `numeric(4,3)` column (best_score, seed_score) can arrive as a string from PostgREST;
// coerce so the row's score math (fmtScore/hasLift) never sees a string. Shared by both
// score columns in both the list and detail reads below.
function nullableScore(value: unknown): number | null {
  return value == null ? null : Number(value);
}

// The Optimizations list is server-rendered and soft-refreshed (router.refresh) on an interval
// while a run is active, so the whole-history read+render re-fires every poll as the table grows
// (scheduled optimizations accrue runs). The most-recent window is all the surface needs: the
// single active run that gates hasActiveRun is always newest-first (one run per org at a time), no
// displayed total sums the list, and the list already shows a retention note (#187). Mirrors the
// rubric run-history .limit(100) on the eval-runs surface.
const OPTIMIZATION_RUNS_DISPLAY_LIMIT = 100;

// List the active team's Optimization Runs, newest first, for the Optimizations surface.
// A run has no name, so each row carries its agent Connection + Rubric names and status.
export async function listOptimizationRuns(): Promise<OptimizationRunSummary[]> {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return [];

  // Stays on the raw admin client: this read pulls a PostgREST embed
  // (`connections!inner(...)`, `rubrics!inner(...)`) that the typed tenantDb
  // `select(...columns)` can't express. It's still org-scoped by the explicit
  // `.eq("org_id", orgId)` below (mirrors getSchedule's embed read).
  const { data, error } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- PostgREST embed select tenantDb can't express; org-scoped by the explicit .eq("org_id") — see comment above
    .from("optimization_runs")
    .select(
      "id, status, best_score, seed_score, created_at, connections!inner(name), rubrics!inner(name)"
    )
    .eq("org_id", orgId)
    .is("deleted_at", null) // hide runs aged out of the plan's retention window (#187)
    .order("created_at", { ascending: false })
    .limit(OPTIMIZATION_RUNS_DISPLAY_LIMIT);
  if (error) throw error;
  const rows = data ?? [];

  return rows.map((r) => ({
    id: r.id as string,
    status: r.status as OptimizationRunStatus,
    best_score: nullableScore(r.best_score),
    // Persisted at the completion transition (#113) — null for a run completed before this
    // column existed, or one that isn't complete yet; either way the read surface claims no lift.
    seed_score: nullableScore(r.seed_score),
    created_at: r.created_at as string,
    connection_name: nestedName(r.connections),
    rubric_name: nestedName(r.rubrics),
  }));
}

// Read an Optimization Run's status + result for the active team. Returns null if the run
// isn't found in the caller's org (no cross-team leakage).
export async function getOptimizationRun(id: string) {
  const { userId, orgId } = await getAuthContext();
  if (!userId || !orgId) return null;

  // Stays on the raw admin client: this read pulls a PostgREST embed
  // (`connections!inner(...)`, `rubrics!inner(...)`) that the typed tenantDb
  // `select(...columns)` can't express. It's still org-scoped by the explicit
  // `.eq("org_id", orgId)` below (mirrors getSchedule's embed read).
  const { data: run, error: runError } = await supabaseAdmin
    // eslint-disable-next-line no-restricted-syntax -- PostgREST embed select tenantDb can't express; org-scoped by the explicit .eq("org_id") — see comment above
    .from("optimization_runs")
    .select("*, connections!inner(name), rubrics!inner(name)")
    .eq("id", id)
    .eq("org_id", orgId)
    .is("deleted_at", null) // a soft-deleted run's detail page 404s like any unknown id (#187)
    .maybeSingle();
  if (runError) throw runError;
  if (!run) return null;

  // The run row is fetched and gates everything below; the remaining child reads all key only on
  // the run id (plus already-known run columns), so they're mutually independent — fan them out in
  // one round trip instead of awaiting each in turn. This is the active-run detail page's poll
  // path, so collapsing the waterfall directly cuts per-poll latency.
  //
  // Derived progress for the in-progress detail (no persisted progress columns, per #105):
  // Candidates discovered so far, and rollouts spent — both head-counted from child rows. Only
  // computed for an active run, since a terminal run's detail shows its result, not progress.
  // Rollouts hang off candidates (no opt_run_id of their own), so count them through an inner
  // join on the run's candidates rather than fetching candidate ids and re-sending them in an
  // IN list — that avoids PostgREST's 1000-row cap and request-URL length limits entirely.
  const isActive = isActiveOptimizationStatus(run.status as OptimizationRunStatus);
  const [
    { count: instanceCount, error: instanceCountError },
    candidateCountRes,
    rolloutsRes,
    { data: seed, error: seedError },
    winnerRes,
  ] = await Promise.all([
    supabaseAdmin
      .from("optimization_inputs")
      .select("id", { count: "exact", head: true })
      .eq("opt_run_id", id),
    isActive
      ? supabaseAdmin
          .from("optimization_candidates")
          .select("id", { count: "exact", head: true })
          .eq("opt_run_id", id)
      : Promise.resolve(null),
    isActive
      ? supabaseAdmin
          .from("optimization_rollouts")
          .select("id, optimization_candidates!inner(opt_run_id)", { count: "exact", head: true })
          .eq("optimization_candidates.opt_run_id", id)
      : Promise.resolve(null),
    // Seed Candidate (generation 0) holds the Connection's seed prompts: the diff's "before"
    // and the lift baseline.
    supabaseAdmin
      .from("optimization_candidates")
      .select("id, prompts")
      .eq("opt_run_id", id)
      .eq("generation", 0)
      .maybeSingle(),
    // Winning Candidate (best_candidate_id) holds the diff's "after". Null until a run produces
    // a validated winner (i.e. not for queued/running/most failed runs).
    run.best_candidate_id
      ? supabaseAdmin
          .from("optimization_candidates")
          .select("prompts")
          .eq("id", run.best_candidate_id as string)
          .maybeSingle()
      : Promise.resolve(null),
  ]);
  if (instanceCountError) throw instanceCountError;

  let candidateCount = 0;
  let rolloutsSpent = 0;
  if (isActive) {
    if (candidateCountRes!.error) throw candidateCountRes!.error;
    candidateCount = candidateCountRes!.count ?? 0;
    if (rolloutsRes!.error) throw rolloutsRes!.error;
    rolloutsSpent = rolloutsRes!.count ?? 0;
  }

  if (seedError) throw seedError;

  let winningPrompts: Record<string, string> | null = null;
  if (run.best_candidate_id) {
    if (winnerRes!.error) throw winnerRes!.error;
    winningPrompts = (winnerRes!.data?.prompts as Record<string, string> | undefined) ?? null;
  }

  // Persisted at the completion transition (#113) — null for a run completed before this column
  // existed, or one that isn't complete yet; either way the detail view claims no lift.
  const seedScore = nullableScore(run.seed_score);

  return {
    run,
    instanceCount: instanceCount ?? 0,
    candidateCount,
    rolloutsSpent,
    seedPrompts: (seed?.prompts as Record<string, string> | undefined) ?? null,
    winningPrompts,
    seedScore,
    // Why the run is paused (#102) — e.g. "waiting for your endpoint to recover". Set while
    // status = 'paused', null otherwise (resume/fail/cancel clear it). Surfaced explicitly so
    // the detail view doesn't dig it out of the raw row.
    pausedReason: (run.paused_reason as string | null) ?? null,
    // Why a completed run ended without ever entering iteration 1 (#469) — a reason CODE
    // (TerminationReason), not prose; the detail panel translates it. Null for a normal
    // completion and for every non-completed run. Same shape as pausedReason above.
    terminationReason: (run.termination_reason as string | null) ?? null,
  };
}
