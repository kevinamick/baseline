// Save-time validation for a PostHog dataset Connection's host (#221). A PostHog connection
// may only point at a PostHog host, so the adapter can't be repurposed as a generic
// server-side request proxy. This is the create-time gate (clear message in the wizard +
// rejection in the server action); the worker re-checks the same list at fetch time.
//
// The allowed-host list and matcher live in worker/src/adapters/posthog-hosts.ts and are
// imported across the package boundary — the same single-source pattern endpoint.ts uses for
// the shared IP-range classifier — so the app and worker can never disagree on which hosts
// count as PostHog.
import { isAllowedPosthogUrl } from "../../../worker/src/adapters/posthog-hosts";

export const POSTHOG_HOST_MESSAGE = "PostHog host must be a posthog.com address";

// True when `raw` parses and its host is an allowed PostHog host. This re-exports the worker's
// isAllowedPosthogUrl rather than re-implementing the parse-then-match wrapper, so the URL
// layer — like the host list it calls — has a single definition the two boundaries share and
// can't drift. Scheme/private-address checks are left to the shared endpoint validator
// (endpointUrlError); this answers only the PostHog-host question.
export const isAllowedPosthogHostUrl = isAllowedPosthogUrl;
