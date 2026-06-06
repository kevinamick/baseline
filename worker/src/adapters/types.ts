import type { OptimizablePrompt } from "../agent.js";

// A dataset adapter reads complete historical rows (input + output already present)
// from where the customer logs production traffic. Each provider (custom HTTP, PostHog,
// later App Insights / CloudTrail / Cloud Logging) owns its own auth, query, and parse,
// but they all return the same DatasetRow[] that feeds the shared scoring pipeline.

export interface DatasetRow {
  user_input: string;
  agent_output: string;
  expected_output: string | null;
  retrieval_context: string | null;
}

// The Connection columns an adapter may read. `config` holds provider-specific bits
// (custom: { field_map }, posthog: { project_id, hogql }); `response_path` is the
// universal "path to the data in the response".
export interface DatasetConnection {
  id: string;
  kind: string;
  provider: string;
  endpoint: string;
  auth_header: string | null;
  auth_secret_id: string | null;
  request_template: unknown;
  response_path: string;
  config: unknown;
  // Agent kind only: declared optimizable prompt Modules (see agent.ts). Loaded so the
  // agent invoker can render {{prompt:<module>}} from each Module's seed; unused by adapters.
  // A loaded row stays a structural superset of AgentConnection, so it passes to
  // invokeAgent without a cast.
  optimizable_prompts?: OptimizablePrompt[] | null;
}

export interface FetchContext {
  windowStart: string; // ISO 8601 (UTC)
  windowEnd: string; // ISO 8601 (UTC)
  maxRows: number;
  authValue: string | null; // full header value, used verbatim (e.g. "Bearer ...")
}

export type DatasetAdapter = (
  connection: DatasetConnection,
  ctx: FetchContext
) => Promise<DatasetRow[]>;
