"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useOrganizationList } from "@clerk/nextjs";
import { createTeamErrorMessage } from "@/lib/clerk/create-team-error";
import { track } from "@/lib/analytics/client";

const inputCls =
  "w-full rounded-md border border-hairline-field bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/40";

export function CreateTeamForm() {
  const { isLoaded, createOrganization, setActive } = useOrganizationList();
  const router = useRouter();

  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Stays true through the post-create navigation so the button can't be
  // double-submitted while /rubrics loads. New teams land on Rubrics (not the
  // empty dashboard) to author their first rubric.
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
      className="form-reveal flex w-full max-w-md flex-col gap-5 rounded-2xl border border-hairline-cool bg-white p-8 shadow-card"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="team-name" className="text-[13px] font-medium text-ink">
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
            className="text-sm text-red-600"
          >
            {error}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={!isLoaded || submitting}
        className="w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-ink-soft disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create team"}
      </button>
    </form>
  );
}
