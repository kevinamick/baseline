"use client";

import { signOut } from "@/app/actions/auth";
import { reset } from "@/lib/analytics/client";

/**
 * Sign-out control: a form that posts the `signOut` server action (which clears
 * the Supabase session and redirects to a public route). Firing analytics
 * `reset()` on click guarantees the distinct id is disconnected even though the
 * server redirect reloads the page before any auth-state listener could react.
 * `className` styles the button to fit each placement (nav menu, landing).
 */
export function SignOutButton({
  className,
  role,
}: {
  className?: string;
  role?: string;
}) {
  return (
    <form action={signOut}>
      <button
        type="submit"
        role={role}
        className={className}
        onClick={() => reset()}
      >
        Sign out
      </button>
    </form>
  );
}
