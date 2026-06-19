/**
 * The third-party subprocessors Baseline relies on to run the service. Disclosed
 * publicly on /privacy to satisfy GDPR Art. 28 transparency. Each entry is drawn
 * from how the vendor is actually wired in the codebase — keep this in sync when
 * a provider is added or removed.
 *
 * `category` mirrors the cookie banner's split: "essential" subprocessors are
 * required to deliver the service; "analytics" ones only run once the visitor
 * has opted in via the consent banner.
 */

export const SUBPROCESSOR_CATEGORIES = ["essential", "analytics"] as const;
export type SubprocessorCategory = (typeof SUBPROCESSOR_CATEGORIES)[number];

export interface Subprocessor {
  name: string;
  purpose: string;
  /** Personal data the vendor may process on our behalf. */
  data: string;
  region: string;
  category: SubprocessorCategory;
}

export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: "Supabase",
    purpose: "Authentication and primary application database hosting",
    data: "Email address, name, organization memberships, and the data you create in the app",
    region: "United States",
    category: "essential",
  },
  {
    name: "Stripe",
    purpose: "Subscription billing and payment processing",
    data: "Billing contact, subscription identifiers, and payment details (card data is held by Stripe, never by us)",
    region: "United States / EU",
    category: "essential",
  },
  {
    name: "Resend",
    purpose: "Transactional and run-result email delivery",
    data: "Recipient email address and message content",
    region: "United States",
    category: "essential",
  },
  {
    name: "PostHog",
    purpose: "Product analytics to understand how features are used",
    data: "Product usage events, device/browser information, and IP address (profiles are created only for identified users)",
    region: "United States",
    category: "analytics",
  },
  {
    name: "Sentry",
    purpose: "Error monitoring and session replay on error for debugging",
    data: "Error reports, a replay of the session leading up to an error, and IP address",
    region: "United States",
    category: "analytics",
  },
] as const;
