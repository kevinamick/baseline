import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics/server";

export async function POST(req: NextRequest) {
  let event;
  try {
    event = await verifyWebhook(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid signature";
    return new Response(`Webhook Error: ${msg}`, { status: 400 });
  }

  if (event.type === "user.created") {
    const userId = event.data.id;
    const primaryEmail = event.data.email_addresses?.find(
      (e) => e.id === event.data.primary_email_address_id
    )?.email_address;
    const emailDomain = primaryEmail?.split("@")[1];

    const { error } = await supabaseAdmin
      .from("users")
      .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });

    if (error) {
      console.error("users upsert failed", { eventId: event.data.id, error });
      return new Response("Database error", { status: 500 });
    }

    await track(
      {
        name: "auth.user_signed_up",
        props: { user_id: userId, email_domain: emailDomain },
      },
      { userId, requestId: req.headers.get("x-request-id") }
    );
  }

  if (event.type === "organization.created") {
    const orgId = event.data.id;
    const { error } = await supabaseAdmin
      .from("organizations")
      .upsert({ id: orgId }, { onConflict: "id", ignoreDuplicates: true });

    if (error) {
      console.error("organizations upsert failed", { eventId: orgId, error });
      return new Response("Database error", { status: 500 });
    }
  }

  if (event.type === "organization.deleted") {
    const orgId = event.data.id;
    if (orgId) {
      const { error } = await supabaseAdmin
        .from("organizations")
        .delete()
        .eq("id", orgId);

      if (error) {
        console.error("organizations delete failed", { eventId: orgId, error });
        return new Response("Database error", { status: 500 });
      }
    }
  }

  return new Response(null, { status: 200 });
}
