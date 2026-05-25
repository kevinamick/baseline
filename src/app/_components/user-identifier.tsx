"use client";

import { useUser } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import { identify, reset } from "@/lib/analytics/client";

export function UserIdentifier() {
  const { user, isLoaded } = useUser();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isLoaded) return;
    const prevUserId = prevUserIdRef.current;
    const currentUserId = user?.id ?? null;
    prevUserIdRef.current = currentUserId;

    if (currentUserId) {
      identify(currentUserId, {
        email: user!.primaryEmailAddress?.emailAddress,
        name: user!.fullName ?? undefined,
        created_at: user!.createdAt?.toISOString(),
      });
    } else if (prevUserId) {
      // User just signed out — reset to disconnect the anonymous session
      reset();
    }
  }, [isLoaded, user]);

  return null;
}
