import { SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createCheckoutSession } from "@/app/actions/checkout";

export default async function Home() {
  const { userId } = await auth();

  const { data: customer } = userId
    ? await supabaseAdmin
        .from("customers")
        .select("stripe_subscription_id, email")
        .eq("clerk_user_id", userId)
        .maybeSingle()
    : { data: null };

  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <header className="w-full flex items-center justify-between px-8 py-4 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
        <span className="text-lg font-semibold tracking-tight">Baseline</span>
        <div className="flex items-center gap-3">
          {userId ? (
            <UserButton />
          ) : (
            <>
              <SignInButton mode="modal">
                <button className="px-4 py-2 text-sm font-medium rounded-full border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900 transition-colors">
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button className="px-4 py-2 text-sm font-medium rounded-full bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors">
                  Sign up
                </button>
              </SignUpButton>
            </>
          )}
        </div>
      </header>
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-center gap-6 px-8 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-black dark:text-white">
          AI Evaluation Platform
        </h1>
        <p className="text-lg text-zinc-500 dark:text-zinc-400 max-w-md">
          Measure, compare, and improve your AI models with rigorous,
          reproducible evaluations.
        </p>
        {!userId ? (
          <SignUpButton mode="modal">
            <button className="mt-2 px-6 py-3 text-sm font-medium rounded-full bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors">
              Get started free
            </button>
          </SignUpButton>
        ) : customer ? (
          <div className="mt-2 px-6 py-3 text-sm font-medium rounded-full bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100 border border-emerald-200 dark:border-emerald-900">
            Subscribed ✓ — {customer.stripe_subscription_id}
            {customer.email ? ` — ${customer.email}` : ""}
          </div>
        ) : (
          <form action={createCheckoutSession}>
            <button
              type="submit"
              className="mt-2 px-6 py-3 text-sm font-medium rounded-full bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors"
            >
              Subscribe
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
