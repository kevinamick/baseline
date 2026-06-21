// Agent Connection invocation: turn a fixed input row into a fresh agent_output by
// calling the customer's existing HTTP endpoint. The Connection adapts to their API
// shape via a request body template ({{placeholders}}) and a dotted response path.

import { renderTemplate, extractString } from "./template.js";
import { validateTemplateModuleRefs } from "./prompt-refs.js";
import { safeFetch, tenantRequestHeaders, BlockedRequestError, type SafeResponse } from "./safe-fetch.js";
import type { TokenUsage } from "./providers/llm.js";

// Thrown when the customer's agent endpoint is the failing component: unreachable
// (connection refused / DNS / timeout) or a non-2xx response. The optimization loop's
// circuit breaker (#90) keys off this so a broken endpoint trips the breaker instead of
// burning the rollout budget. The class name is the contract — the rollout Activity rethrows
// it as an ApplicationFailure whose `type` is this name (see gepa/circuit-breaker.ts). A
// parse/contract failure on a 2xx body is NOT an endpoint failure and stays a plain Error.
export class AgentEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEndpointError";
  }
}

// A named optimizable prompt on an agent Connection: a Module the optimization loop can
// tune, plus the seed text used when no Candidate overrides it.
export interface OptimizablePrompt {
  name: string;
  seed: string;
}

export interface AgentConnection {
  id: string;
  kind: string;
  // 'external' (the default) reaches a customer HTTP endpoint; 'managed' (#290) runs the
  // prompt on Baseline's managed LLM. Absent on rows that predate the column → external.
  agent_kind?: string;
  // endpoint / response_path are null for a Managed Agent (it has no HTTP endpoint); the
  // shape CHECK guarantees they're non-null for an external agent.
  endpoint: string | null;
  auth_header: string | null;
  auth_secret_id: string | null;
  request_template: unknown;
  response_path: string | null;
  // The Anthropic model a Managed Agent runs the prompt on; null for an external agent.
  target_model?: string | null;
  // The Modules this Connection declares. Null/absent for agents with no optimizable
  // prompts (the {{user_input}}-only case) and for non-agent kinds.
  optimizable_prompts?: OptimizablePrompt[] | null;
}

// The slice of an LLM provider invokeManagedAgent needs (AnthropicProvider implements it).
// Narrowed to one method so the managed invoker is unit-testable with a stub completer.
export interface ManagedCompleter {
  complete(opts: {
    model: string;
    system: string;
    user: string;
  }): Promise<{ text: string; usage: TokenUsage }>;
}

export interface InvokableRow {
  row_index: number;
  user_input: string;
  expected_output: string | null;
  retrieval_context: string | null;
}

// A Candidate's prompts: a { module -> text } map injected into one invocation.
export type CandidatePrompts = Record<string, string>;

// Build the { module -> text } map rendered into {{prompt:<module>}} placeholders.
// Each declared Module resolves to the Candidate's prompt for it, falling back to the
// Module's seed. A Candidate referencing a Module the Connection doesn't declare is
// rejected — the optimization loop must only tune prompts the System actually exposes.
export function resolveCandidatePrompts(
  optimizablePrompts: OptimizablePrompt[] | null | undefined,
  candidate?: CandidatePrompts | null
): CandidatePrompts {
  const declared = optimizablePrompts ?? [];
  const declaredNames = new Set(declared.map((m) => m.name));

  // Defense-in-depth at the DB trust boundary: the create form enforces unique Module
  // names via zod, but a row could carry duplicates (manual SQL, a future import path).
  // last-wins would silently render the wrong seed, so fail loudly instead.
  if (declaredNames.size !== declared.length) {
    throw new Error("Connection declares duplicate optimizable prompt Module names");
  }

  if (candidate) {
    const undeclared = Object.keys(candidate).filter((name) => !declaredNames.has(name));
    if (undeclared.length > 0) {
      throw new Error(
        `Candidate prompts reference Module(s) not declared on the Connection: ${undeclared.join(", ")}`
      );
    }
  }

  const prompts: CandidatePrompts = {};
  for (const mod of declared) {
    // hasOwnProperty (not `candidate?.[name]`) so a Module named like an Object.prototype
    // member ("toString", "constructor", …) reads the Candidate's own value, not the
    // inherited function. `??`-style fallback is presence-based: an explicit empty-string
    // candidate is a deliberate "clear this Module" and overrides the seed; only an absent
    // value falls back.
    prompts[mod.name] =
      candidate && Object.prototype.hasOwnProperty.call(candidate, mod.name)
        ? candidate[mod.name]
        : mod.seed;
  }
  return prompts;
}

// Invoke the agent once for a single input row and return its output. When a Candidate
// prompt map is supplied, its prompts render into {{prompt:<module>}} placeholders;
// otherwise each declared Module renders from its seed.
export async function invokeAgent(
  connection: AgentConnection,
  row: InvokableRow,
  authValue: string | null,
  candidate?: CandidatePrompts | null
): Promise<string> {
  // Config integrity, not an endpoint failure: an external agent must carry both. The shape
  // CHECK enforces this in the DB; this guard narrows the now-nullable types and backstops a
  // hand-edited row. A plain Error (not AgentEndpointError) so it doesn't read as a live outage.
  if (!connection.endpoint || !connection.response_path) {
    throw new Error("External agent Connection is missing endpoint or response_path");
  }

  const vars: Record<string, string> = {
    user_input: row.user_input,
    expected_output: row.expected_output ?? "",
    retrieval_context: row.retrieval_context ?? "",
  };

  const prompts = resolveCandidatePrompts(connection.optimizable_prompts, candidate);

  const template = connection.request_template ?? { input: "{{user_input}}" };

  // Validate the inverse of resolveCandidatePrompts: every {{prompt:X}} the template
  // references must be a declared Module. Otherwise a typo ({{prompt:systme}}) or a stray
  // reference renders to "" and the agent is silently sent an empty prompt. The SAME rule
  // (validateTemplateModuleRefs) runs at Connection save time in insertConnection, so this
  // guard is defense-in-depth for rows that predate it or bypassed the app boundary. The
  // soft warning (declared-but-unreferenced) is irrelevant at invocation time and ignored.
  const checked = validateTemplateModuleRefs(template, Object.keys(prompts));
  if ("error" in checked) {
    throw new Error(checked.error);
  }

  const body = renderTemplate(template, vars, prompts);

  // Outbound headers + their matching allowlist (#222): a JSON body plus the Connection's own
  // auth header, and nothing else — safeFetch drops anything not on the derived allowlist, so no
  // internal/telemetry header can ride along even if something upstream injects one.
  const { headers, allowedHeaders } = tenantRequestHeaders({
    authHeader: connection.auth_header,
    authValue,
    json: true,
  });

  let res: SafeResponse;
  try {
    // safeFetch (#219) applies the SSRF egress guard at fetch time: it refuses private /
    // reserved targets, pins the connection to a validated IP, and refuses redirects.
    res = await safeFetch(connection.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      allowedHeaders,
    });
  } catch (err) {
    // safeFetch rejects on connection-level failures (endpoint down, DNS, TLS, timeout) and on
    // egress-policy blocks. Both surface as AgentEndpointError so the circuit breaker (#90)
    // recognizes them — the class name is the contract (see gepa/circuit-breaker.ts).
    if (err instanceof BlockedRequestError) {
      throw new AgentEndpointError(
        `Agent endpoint ${connection.endpoint} blocked by egress guard: ${err.message}`
      );
    }
    throw new AgentEndpointError(
      `Agent endpoint ${connection.endpoint} is unreachable: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    throw new AgentEndpointError(`Agent endpoint ${connection.endpoint} returned HTTP ${res.status}`);
  }

  const json = await res.json();
  return extractString(json, connection.response_path);
}

// Invoke a Managed Agent (#290, ADR-0014): instead of POSTing a customer endpoint, run the
// Candidate's prompt on Baseline's managed LLM. The declared Modules' resolved text become the
// system message (a Managed Agent declares one Module; if it ever declares more they join in
// declaration order), and the instance's user_input is the user turn. Returns the model's text
// output and the call's token usage, which the optimization loop meters as managed spend (#291).
// There is no outbound HTTP here, so — unlike invokeAgent — there is no SSRF surface and no
// AgentEndpointError / circuit-breaker path; a provider error is a plain (retryable) Error.
export async function invokeManagedAgent(
  connection: AgentConnection,
  row: InvokableRow,
  completer: ManagedCompleter,
  candidate?: CandidatePrompts | null
): Promise<{ text: string; usage: TokenUsage }> {
  if (!connection.target_model) {
    throw new Error("Managed Agent Connection is missing target_model");
  }
  const prompts = resolveCandidatePrompts(connection.optimizable_prompts, candidate);
  const system = Object.values(prompts).join("\n\n");
  // A Managed Agent with no declared Module would run the model on an empty system prompt and
  // silently optimize nothing. The wizard (#293) enforces exactly one Module up front; until
  // then, fail loudly rather than no-op. (resolveCandidatePrompts returns {} for an empty list.)
  if (!system.trim()) {
    throw new Error("Managed Agent Connection declares no Module prompt to run");
  }
  const { text, usage } = await completer.complete({
    model: connection.target_model,
    system,
    user: row.user_input,
  });
  return { text, usage };
}
