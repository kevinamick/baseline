"use client";

import { useState } from "react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Normalize a raw email-field value (trim, strip trailing comma) and validate it.
// Returns the cleaned address if valid, else null.
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().replace(/,$/, "");
  return trimmed && EMAIL_RE.test(trimmed) ? trimmed : null;
}

export interface EmailTags {
  emails: string[];
  input: string;
  setInput: (value: string) => void;
  commit: () => void;
  remove: (email: string) => void;
  resolve: () => string[];
  add: (newEmails: string[]) => void;
}

// A tag-style email input: owns both the committed list and the uncommitted draft
// in the text box. Callers add via Enter/comma/blur and read the final list with
// resolve(), which folds in any valid draft so the last-typed address is never
// dropped on submit — without the rest of the form knowing the input has a buffer.
export function useEmailTags(initialEmails: string[] = []): EmailTags {
  const [emails, setEmails] = useState<string[]>(initialEmails);
  const [input, setInput] = useState("");

  function commit() {
    const email = normalizeEmail(input);
    if (!email) return;
    setEmails((prev) => (prev.includes(email) ? prev : [...prev, email]));
    setInput("");
  }

  function remove(email: string) {
    setEmails((prev) => prev.filter((e) => e !== email));
  }

  function resolve(): string[] {
    const pending = normalizeEmail(input);
    return pending && !emails.includes(pending) ? [...emails, pending] : emails;
  }

  function add(newEmails: string[]) {
    const valid = newEmails.map((e) => normalizeEmail(e)).filter((e): e is string => e !== null);
    setEmails((prev) => {
      const deduped = [...prev];
      for (const e of valid) {
        if (!deduped.includes(e)) deduped.push(e);
      }
      return deduped;
    });
  }

  return { emails, input, setInput, commit, remove, resolve, add };
}

// Presentational chip-input for the email tags. The parent owns the `tags` state
// (via useEmailTags) so it can read resolve() at submit time. `id` wires the input
// to its surrounding <Field> label.
export function EmailTagsField({ id, tags }: { id: string; tags: EmailTags }) {
  return (
    <div
      className="flex min-h-[42px] flex-wrap gap-1.5 rounded-md border border-hairline-field bg-white p-2"
      onClick={() => document.getElementById(id)?.focus()}
    >
      {tags.emails.map((email) => (
        <span
          key={email}
          className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs text-accent-ink"
        >
          {email}
          <button
            type="button"
            onClick={() => tags.remove(email)}
            aria-label={`Remove ${email}`}
            className="leading-none text-accent-ink/60 hover:text-accent-ink"
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        value={tags.input}
        onChange={(e) => tags.setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            tags.commit();
          }
        }}
        onBlur={tags.commit}
        placeholder={tags.emails.length === 0 ? "you@example.com, then Enter" : ""}
        className="flex-1 min-w-[160px] bg-transparent text-sm outline-none"
      />
    </div>
  );
}
