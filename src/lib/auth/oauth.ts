// Single source of truth for the social/OAuth providers Baseline supports.
// Add a provider here and it flows everywhere: the sign-in action's validation,
// the UI buttons, and the analytics event type. Keep in sync with the
// `[auth.external.<provider>]` blocks in supabase/config.toml.
export const OAUTH_PROVIDERS = ["google", "github"] as const;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return (
    typeof value === "string" &&
    (OAUTH_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Which providers to surface in the UI. OAuth needs real cloud credentials
 * (see .env.local.example) and can't run purely offline, so it's opt-in: list
 * the configured providers in `NEXT_PUBLIC_OAUTH_PROVIDERS` (comma-separated) to
 * show their buttons. Empty by default, so local dev stays clean out of the box.
 */
export function enabledOAuthProviders(): OAuthProvider[] {
  const configured = (process.env.NEXT_PUBLIC_OAUTH_PROVIDERS ?? "")
    .split(",")
    .map((p) => p.trim());
  return OAUTH_PROVIDERS.filter((p) => configured.includes(p));
}

/** Human-readable label for a provider, used on its sign-in button. */
export const OAUTH_PROVIDER_LABELS: Record<OAuthProvider, string> = {
  google: "Google",
  github: "GitHub",
};
