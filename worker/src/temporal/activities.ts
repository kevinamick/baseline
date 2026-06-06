// Temporal Activities. Per ADR-0006, Activities are where all real data access lives —
// workflows carry only IDs and orchestrate; Activities read/write Postgres. This is the
// trivial tracer-bullet Activity; GEPA's rollout/judge/propose Activities arrive in later
// slices (#87+).

export async function ping(message: string): Promise<string> {
  return `pong: ${message}`;
}
