"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ACTIVE_ORG_COOKIE } from "@/lib/auth/active-org";
import { checkLimit, rateLimitMessage } from "@/lib/rate-limit/guard";
import { log } from "@/lib/logging/server";

// GDPR data-subject-rights flow (#69). Two self-serve rights on the account
// page, both acting on the *current session's* user — there is no id parameter
// to forge, the cookie-bound session is the authorization (mirrors account.ts):
//
//   • Right to erasure     → deleteAccount
//   • Right to portability → exportAccountData

export interface DeleteAccountState {
  error?: string;
}

export interface ExportResult {
  error?: string;
  /** Pretty-printed JSON of the user's personal data, ready to download. */
  json?: string;
  /** Suggested filename for the download. */
  filename?: string;
}

/**
 * Gather the signed-in user's personal data as a JSON document (right to data
 * portability). Reads through the service-role client so the export is complete
 * regardless of the caller's active-org RLS scope, but every query is pinned to
 * the *session* user id.
 *
 * `customers` is intentionally excluded: since team billing (ADR-0007) that
 * table is keyed by org, so it records the Team's billing relationship, not the
 * individual's personal data. The user's `memberships` capture their org
 * affiliations; `rubrics` are the content they authored.
 */
export async function exportAccountData(): Promise<ExportResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in to export your data." };

  // Authenticated surface (ADR-0010): each export runs several service-role
  // reads, so cap it per user. Visible 429 — nothing to enumerate.
  if (await checkLimit("exportAccountData", "user", user.id)) {
    return { error: rateLimitMessage() };
  }

  const [usersRow, memberships, rubrics] = await Promise.all([
    supabaseAdmin.from("users").select("*").eq("id", user.id).maybeSingle(),
    supabaseAdmin.from("memberships").select("*").eq("user_id", user.id),
    supabaseAdmin.from("rubrics").select("*").eq("created_by", user.id),
  ]);

  const firstError = usersRow.error ?? memberships.error ?? rubrics.error;
  if (firstError) {
    await log.error("account export query failed", {
      event: "account.export_failed",
      user_id: user.id,
      error: firstError,
    });
    return { error: "Could not export your data. Please try again." };
  }

  const payload = {
    exported_at: new Date().toISOString(),
    auth_profile: {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      last_sign_in_at: user.last_sign_in_at,
      user_metadata: user.user_metadata,
    },
    user: usersRow.data,
    memberships: memberships.data,
    rubrics: rubrics.data,
  };

  return {
    json: JSON.stringify(payload, null, 2),
    filename: `baseline-data-export-${user.id}.json`,
  };
}

/**
 * Delete the signed-in user's account (right to erasure). Guarded by a typed
 * confirmation — the form must echo the account's own email address — so a stray
 * click can't trigger it; the server re-validates the match, never trusting the
 * client gate. Acts only on the session user.
 *
 * Before removing the auth user we settle the orgs they solely administer so the
 * cascade never strands a shared team without an admin. The
 * `auth.users` → `public.users` → memberships / rubrics / connections /
 * schedules / eval_runs `on delete cascade` then erases the rest, and the
 * min-one-admin trigger exempts the cascade. We clear the session + active-org
 * cookie and route home.
 */
export async function deleteAccount(
  _prev: DeleteAccountState,
  formData: FormData
): Promise<DeleteAccountState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in to delete your account." };

  const confirm = String(formData.get("confirm") ?? "").trim().toLowerCase();
  if (!user.email || confirm !== user.email.toLowerCase()) {
    return { error: "Type your email address exactly to confirm deletion." };
  }

  await settleSoleAdminOrgs(user.id);

  const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id);
  if (error) {
    await log.error("account delete failed", {
      event: "account.delete_failed",
      user_id: user.id,
      error,
    });
    return { error: "Could not delete your account. Please try again." };
  }

  // Erasure is honored on the data side; record only an operational log line —
  // we don't fire a new identified analytics event for a user who is erasing.
  await log.info("account deleted", {
    event: "account.deleted",
    user_id: user.id,
  });

  // The auth user is gone, so the session cookies are dead — clear them and the
  // active-org pointer before routing home. signOut is best-effort (the session
  // is already invalid).
  await supabase.auth.signOut().catch(() => {});
  const cookieStore = await cookies();
  cookieStore.delete(ACTIVE_ORG_COOKIE);

  redirect("/");
}

/**
 * Ensure every org the user administers keeps an admin once the user is gone.
 * For each such org: if another admin remains, do nothing; otherwise promote the
 * oldest remaining member to admin; if the user is the org's only member, delete
 * the now-empty org (its org-scoped rows cascade away).
 *
 * Best-effort — failures are logged, not fatal. The DB's min-one-admin trigger
 * exempts the user-deletion cascade regardless, so erasure still proceeds; the
 * worst case is a team left for manual repair rather than a blocked deletion.
 */
async function settleSoleAdminOrgs(userId: string): Promise<void> {
  const { data: adminOf, error } = await supabaseAdmin
    .from("memberships")
    .select("org_id")
    .eq("user_id", userId)
    .eq("role", "admin");

  if (error || !adminOf) {
    await log.error("sole-admin settle: membership read failed", {
      event: "account.delete_settle_failed",
      user_id: userId,
      error,
    });
    return;
  }

  for (const { org_id } of adminOf) {
    const { data: others } = await supabaseAdmin
      .from("memberships")
      .select("user_id, role, created_at")
      .eq("org_id", org_id)
      .neq("user_id", userId)
      .order("created_at", { ascending: true });

    const rest = others ?? [];
    if (rest.some((m) => m.role === "admin")) continue; // org already keeps an admin

    if (rest.length === 0) {
      // The user is the org's only member — it would be orphaned by the cascade.
      // Remove it (cascades its rubrics / connections / schedules / customers).
      const { error: delErr } = await supabaseAdmin
        .from("organizations")
        .delete()
        .eq("id", org_id);
      if (delErr) {
        await log.error("sole-admin settle: org delete failed", {
          event: "account.delete_settle_failed",
          user_id: userId,
          org_id,
          error: delErr,
        });
      }
      continue;
    }

    // Promote the oldest remaining member so the team keeps an admin. A silent
    // failure here would let the cascade strand the team admin-less — the exact
    // case this guards — so surface it.
    const { error: promoteErr } = await supabaseAdmin
      .from("memberships")
      .update({ role: "admin" })
      .eq("org_id", org_id)
      .eq("user_id", rest[0].user_id);
    if (promoteErr) {
      await log.error("sole-admin settle: promote failed", {
        event: "account.delete_settle_failed",
        user_id: userId,
        org_id,
        error: promoteErr,
      });
    }
  }
}
