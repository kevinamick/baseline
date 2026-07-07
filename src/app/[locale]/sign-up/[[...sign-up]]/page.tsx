import { SignUpForm } from "@/app/_components/auth-form";
import { AuthShell } from "@/app/_components/auth-shell";
import { enabledOAuthProviders } from "@/lib/auth/oauth";
import { noindex } from "@/lib/seo";
import { isSignupGated } from "@/lib/analytics/signup-gate";

export const metadata = noindex;

// The launch-phase Access Code gate (ADR-0017, #425) is a live PostHog flag, so
// this page must be evaluated per request rather than prerendered once at
// build — a static render would freeze whatever the flag read at build time for
// the life of the deployment, defeating the point of a no-deploy flag flip.
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  const gated = await isSignupGated();
  return (
    <AuthShell>
      <SignUpForm providers={enabledOAuthProviders()} gated={gated} />
    </AuthShell>
  );
}
