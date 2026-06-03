"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { identify, reset } from "@/lib/analytics/client";

export function UserIdentifier() {
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const supabase = createClient();

    // `onAuthStateChange` fires `INITIAL_SESSION` on mount and again on every
    // sign-in/sign-out, so it covers both the first paint and later transitions.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      const prevUserId = prevUserIdRef.current;
      const currentUserId = user?.id ?? null;
      prevUserIdRef.current = currentUserId;

      if (currentUserId) {
        identify(currentUserId, {
          email: user!.email,
          created_at: user!.created_at,
        });
      } else if (prevUserId) {
        // Just signed out — reset to disconnect the anonymous session.
        reset();
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  return null;
}
