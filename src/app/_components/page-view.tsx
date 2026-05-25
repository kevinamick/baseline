"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { track } from "@/lib/analytics/client";
import {
  deviceProps,
  ensureSessionStarted,
} from "@/lib/analytics/client-context";

export function PageView() {
  const pathname = usePathname();
  useEffect(() => {
    ensureSessionStarted();
    track({
      name: "app.page_viewed",
      props: { path: pathname, ...deviceProps() },
    });
  }, [pathname]);
  return null;
}
