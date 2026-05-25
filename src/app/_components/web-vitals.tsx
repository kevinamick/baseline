"use client";

import { useReportWebVitals } from "next/web-vitals";
import { track } from "@/lib/analytics/client";

export function WebVitals() {
  useReportWebVitals((metric) => {
    track({
      name: "system.web_vital",
      props: {
        metric: metric.name,
        value: metric.value,
        rating: metric.rating,
        navigation_type: metric.navigationType,
      },
    });
  });
  return null;
}
