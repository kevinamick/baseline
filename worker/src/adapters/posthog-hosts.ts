// The single source of truth for which hosts the PostHog dataset adapter may issue
// server-side requests to (#221). Without this list the adapter would dereference any
// public HTTPS endpoint a tenant supplies — the generic SSRF egress guard (safe-fetch.ts)
// only blocks private/reserved addresses, so a tenant could still aim the adapter at any
// public host and use our infra (and the attached PostHog credential) as a request proxy.
//
// PostHog Cloud serves the query API from regional subdomains of posthog.com
// (us.posthog.com, eu.posthog.com, the legacy app.posthog.com). Any host under
// posthog.com is allowed. To support a self-hosted PostHog the product explicitly trusts,
// add its exact host here — it then matches by the `host === allowed` arm below.
//
// This module is imported by BOTH the worker adapter (fetch-time enforcement) and the
// app's save-time validator (src/lib/connections/posthog-host.ts), so the list can't drift
// between the two boundaries — mirroring how ip-ranges.ts is shared across the package line.
export const POSTHOG_ALLOWED_HOSTS = ["posthog.com"] as const;

// True when `hostname` is an allowed PostHog host: it equals an allowed entry, or is a
// subdomain of one. The leading-dot requirement on the suffix arm is what makes the match
// safe — "evilposthog.com" and "posthog.com.attacker.example" are both rejected because
// neither ends with ".posthog.com" nor equals "posthog.com".
//
// `hostname` is expected to be a bare host (no scheme/port). The WHATWG URL parser already
// lowercases names and canonicalizes IP literals; we additionally lowercase and strip a
// trailing dot ("posthog.com." resolves to the same host) so a caller passing a raw value
// can't slip past the match.
export function isAllowedPosthogHost(hostname: string): boolean {
  const host = hostname.replace(/\.+$/, "").toLowerCase();
  return POSTHOG_ALLOWED_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

// True when `rawUrl` parses and its host is an allowed PostHog host. Scheme/userinfo/private
// -address checks are NOT done here — those belong to the shared endpoint policy
// (endpointUrlError on save, safeFetch at fetch time); this answers only "is the host
// PostHog?".
export function isAllowedPosthogUrl(rawUrl: string): boolean {
  try {
    return isAllowedPosthogHost(new URL(rawUrl.trim()).hostname);
  } catch {
    return false;
  }
}
