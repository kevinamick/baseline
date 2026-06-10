// Agent Connection invocation: turn a fixed input row into a fresh agent_output by
// calling the customer's existing HTTP endpoint. The Connection adapts to their API
// shape via a request body template ({{placeholders}}) and a dotted response path.

import { renderTemplate, extractString } from "./template.js";
import { validateTemplateModuleRefs } from "./prompt-refs.js";

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
  endpoint: string;
  auth_header: string | null;
  auth_secret_id: string | null;
  request_template: unknown;
  response_path: string;
  // The Modules this Connection declares. Null/absent for agents with no optimizable
  // prompts (the {{user_input}}-only case) and for non-agent kinds.
  optimizable_prompts?: OptimizablePrompt[] | null;
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

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // The stored secret IS the full header value (e.g. "Bearer sk-..."), so it is used verbatim.
  if (connection.auth_header && authValue) {
    headers[connection.auth_header] = authValue;
  }

  let res: Response;
  try {
    res = await fetch(connection.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    // fetch rejects on connection-level failures (endpoint down, DNS, TLS, timeout). These are
    // the "killed endpoint" case the circuit breaker exists for, so surface them as such.
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
