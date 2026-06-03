import { signOut } from "@/app/actions/auth";

/**
 * Sign-out control: a form that posts the `signOut` server action. Centralizes
 * the wiring so future changes (loading state, confirm, analytics) land once.
 * `className` styles the button to fit each placement (nav bar, landing).
 */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={signOut}>
      <button type="submit" className={className}>
        Sign out
      </button>
    </form>
  );
}
