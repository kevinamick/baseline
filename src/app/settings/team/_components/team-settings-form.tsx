"use client";

import { useState } from "react";
import { useOrganization, useUser } from "@clerk/nextjs";

const inputCls =
  "w-full rounded-md border border-hairline-field bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/40";

export function TeamSettingsForm() {
  const { organization, memberships, invitations } = useOrganization({
    memberships: { infinite: true, pageSize: 50 },
    invitations: { infinite: true, pageSize: 50 },
  });
  const { user } = useUser();

  const [orgName, setOrgName] = useState(organization?.name ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  if (!organization) {
    return (
      <p className="text-sm text-ink/60">No active organization found.</p>
    );
  }

  async function handleSaveName(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = orgName.trim();
    if (!trimmed) {
      setNameError("Team name is required.");
      return;
    }
    setNameSaving(true);
    setNameError(null);
    setNameSaved(false);
    try {
      await organization!.update({ name: trimmed });
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch {
      setNameError("Failed to update team name. Please try again.");
    } finally {
      setNameSaving(false);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) {
      setInviteError("Email address is required.");
      return;
    }
    setInviting(true);
    setInviteError(null);
    try {
      await organization!.inviteMember({ emailAddress: email, role: "org:member" });
      setInviteEmail("");
      await invitations?.revalidate?.();
    } catch {
      setInviteError("Failed to send invitation. Check the email and try again.");
    } finally {
      setInviting(false);
    }
  }

  async function handleRemoveMember(membership: NonNullable<typeof memberships>["data"][number]) {
    if (!confirm(`Remove ${membership.publicUserData?.firstName ?? membership.publicUserData?.identifier} from the team?`)) return;
    try {
      await membership.destroy();
      await memberships?.revalidate?.();
    } catch {
      // silently ignore; membership list will reflect current state
    }
  }

  async function handleRevokeInvitation(invitation: NonNullable<typeof invitations>["data"][number]) {
    try {
      await invitation.revoke();
      await invitations?.revalidate?.();
    } catch {
      // silently ignore
    }
  }

  const currentUserId = user?.id;

  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      {/* Team name */}
      <section className="rounded-2xl border border-hairline-cool bg-white p-8 shadow-card">
        <h2 className="mb-5 text-base font-semibold text-ink">Team name</h2>
        <form onSubmit={handleSaveName} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="org-name" className="text-[13px] font-medium text-ink">
              Name
            </label>
            <input
              id="org-name"
              type="text"
              value={orgName}
              onChange={(e) => {
                setOrgName(e.target.value);
                if (nameError) setNameError(null);
                if (nameSaved) setNameSaved(false);
              }}
              className={inputCls}
              disabled={nameSaving}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? "org-name-error" : undefined}
            />
            {nameError && (
              <p id="org-name-error" role="alert" className="text-sm text-red-600">
                {nameError}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={nameSaving}
              className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-soft disabled:opacity-50"
            >
              {nameSaving ? "Saving…" : "Save"}
            </button>
            {nameSaved && (
              <span className="text-sm text-green-600">Saved!</span>
            )}
          </div>
        </form>
      </section>

      {/* Members */}
      <section className="rounded-2xl border border-hairline-cool bg-white p-8 shadow-card">
        <h2 className="mb-5 text-base font-semibold text-ink">Members</h2>
        {!memberships || memberships.isLoading ? (
          <p className="text-sm text-ink/60">Loading members…</p>
        ) : memberships.data && memberships.data.length > 0 ? (
          <ul className="flex flex-col divide-y divide-hairline-cool">
            {memberships.data.map((m) => {
              const name =
                [m.publicUserData?.firstName, m.publicUserData?.lastName]
                  .filter(Boolean)
                  .join(" ") ||
                m.publicUserData?.identifier ||
                "Unknown";
              const isCurrentUser = m.publicUserData?.userId === currentUserId;
              const isAdmin = m.role === "org:admin";
              return (
                <li key={m.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-ink">
                      {name}
                      {isCurrentUser && (
                        <span className="ml-1.5 text-[11px] text-ink/50">(you)</span>
                      )}
                    </span>
                    {m.publicUserData?.identifier && name !== m.publicUserData.identifier && (
                      <span className="text-xs text-ink/50">{m.publicUserData.identifier}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="rounded-full border border-hairline-cool px-2.5 py-0.5 text-[11px] font-medium text-ink/60">
                      {isAdmin ? "Admin" : "Member"}
                    </span>
                    {!isCurrentUser && (
                      <button
                        type="button"
                        onClick={() => handleRemoveMember(m)}
                        className="rounded-full border border-hairline-cool px-3 py-1 text-xs font-medium text-ink transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-ink/60">No members found.</p>
        )}
      </section>

      {/* Invite member */}
      <section className="rounded-2xl border border-hairline-cool bg-white p-8 shadow-card">
        <h2 className="mb-5 text-base font-semibold text-ink">Invite member</h2>
        <form onSubmit={handleInvite} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="invite-email" className="text-[13px] font-medium text-ink">
              Email address
            </label>
            <input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(e) => {
                setInviteEmail(e.target.value);
                if (inviteError) setInviteError(null);
              }}
              placeholder="colleague@example.com"
              className={inputCls}
              disabled={inviting}
              aria-invalid={inviteError ? true : undefined}
              aria-describedby={inviteError ? "invite-email-error" : undefined}
            />
            {inviteError && (
              <p id="invite-email-error" role="alert" className="text-sm text-red-600">
                {inviteError}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={inviting}
            className="w-fit rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-soft disabled:opacity-50"
          >
            {inviting ? "Sending…" : "Send invite"}
          </button>
        </form>
      </section>

      {/* Pending invitations */}
      {invitations && !invitations.isLoading && invitations.data && invitations.data.length > 0 && (
        <section className="rounded-2xl border border-hairline-cool bg-white p-8 shadow-card">
          <h2 className="mb-5 text-base font-semibold text-ink">Pending invitations</h2>
          <ul className="flex flex-col divide-y divide-hairline-cool">
            {invitations.data.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-4 py-3">
                <span className="text-sm text-ink">{inv.emailAddress}</span>
                <button
                  type="button"
                  onClick={() => handleRevokeInvitation(inv)}
                  className="rounded-full border border-hairline-cool px-3 py-1 text-xs font-medium text-ink transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
