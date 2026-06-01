"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { EmailGroup } from "@/types/email-group";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeEmails(emails: string[]): string[] {
  return emails.map((e) => e.trim()).filter((e) => EMAIL_RE.test(e));
}

export async function listEmailGroups(): Promise<EmailGroup[]> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return [];

  const { data } = await supabaseAdmin
    .from("email_groups")
    .select("id, name, emails, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  return (data ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    emails: g.emails ?? [],
    createdAt: g.created_at,
  }));
}

export async function createEmailGroup(
  name: string,
  emails: string[]
): Promise<{ groupId: string } | { error: string }> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (orgRole !== "org:admin") return { error: "Only admins can manage email groups" };

  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Group name is required" };

  const validEmails = sanitizeEmails(emails);
  if (validEmails.length === 0) return { error: "At least one valid email is required" };

  const { data, error } = await supabaseAdmin
    .from("email_groups")
    .insert({ org_id: orgId, created_by: userId, name: trimmedName, emails: validEmails })
    .select("id")
    .single();

  if (error || !data) {
    console.error("email_groups insert failed", error);
    return { error: "Failed to create email group" };
  }

  revalidatePath("/settings/email-groups");
  return { groupId: data.id };
}

export async function updateEmailGroup(
  id: string,
  name: string,
  emails: string[]
): Promise<{ error: string } | void> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (orgRole !== "org:admin") return { error: "Only admins can manage email groups" };

  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Group name is required" };

  const validEmails = sanitizeEmails(emails);
  if (validEmails.length === 0) return { error: "At least one valid email is required" };

  const { error } = await supabaseAdmin
    .from("email_groups")
    .update({ name: trimmedName, emails: validEmails, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId);

  if (error) {
    console.error("email_groups update failed", error);
    return { error: "Failed to update email group" };
  }

  revalidatePath("/settings/email-groups");
}

export async function deleteEmailGroup(
  id: string
): Promise<{ error: string } | void> {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return { error: "Not authenticated" };
  if (orgRole !== "org:admin") return { error: "Only admins can manage email groups" };

  const { error } = await supabaseAdmin
    .from("email_groups")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);

  if (error) {
    console.error("email_groups delete failed", error);
    return { error: "Failed to delete email group" };
  }

  revalidatePath("/settings/email-groups");
}
