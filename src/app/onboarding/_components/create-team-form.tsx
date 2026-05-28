"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useOrganizationList } from "@clerk/nextjs";
import { createTeamErrorMessage } from "@/lib/clerk/create-team-error";
import { track } from "@/lib/analytics/client";

const inputCls =
  "w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 transition-shadow";

export function CreateTeamForm() {
  const { isLoaded, createOrganization, setActive } = useOrganizationList();
  const router = useRouter();

  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Stays true through the post-create navigation so the button can't be
  // double-submitted while /rubrics loads.
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || submitting) return;

    const trimmed = name.trim();
    if (!trimmed) {
      setError("Team name is required.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const org = await createOrganization({ name: trimmed });
      await setActive({ organization: org.id });
      track({ name: "team.created", props: { team_id: org.id } });
      router.push("/rubrics");
    } catch (err) {
      setError(createTeamErrorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="form-reveal w-full max-w-md rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 shadow-sm flex flex-col gap-5"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="team-name" className="text-sm font-medium">
          Team name
        </label>
        <input
          id="team-name"
          name="name"
          type="text"
          autoFocus
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          placeholder="e.g. Acme Engineering"
          className={inputCls}
          disabled={submitting}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "team-name-error" : undefined}
        />
        {error && (
          <p
            id="team-name-error"
            role="alert"
            className="text-sm text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={!isLoaded || submitting}
        className="w-full px-5 py-2.5 text-sm font-medium rounded-full bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create team"}
      </button>
    </form>
  );
}
