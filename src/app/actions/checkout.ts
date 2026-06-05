"use server";

import { getAuthContext } from "@/lib/auth/context";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { track } from "@/lib/analytics/server";

export async function createCheckoutSession() {
  const { userId } = await getAuthContext();
  if (!userId) throw new Error("Not signed in");

  const priceId = process.env.STRIPE_PRICE_ID!;
  const requestId = (await headers()).get("x-request-id");

  await track(
    {
      name: "billing.checkout_started",
      props: { user_id: userId, price_id: priceId },
    },
    { userId, requestId }
  );

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: userId,
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/?checkout=success`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/?checkout=cancel`,
  });

  redirect(session.url!);
}
