"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { track } from "@/lib/analytics/client";

export function CheckoutStatus() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const checkout = searchParams.get("checkout");

  useEffect(() => {
    if (checkout === "success") {
      track({ name: "billing.checkout_success" });
      router.replace("/");
    } else if (checkout === "cancel") {
      track({ name: "billing.checkout_cancelled" });
      router.replace("/");
    }
  }, [checkout, router]);

  return null;
}
