/**
 * Money formatting for billing surfaces (UI and email render the same Team's
 * numbers — one definition or they drift). Plain module: imported by client
 * components, server components, and email templates alike.
 */

/** Whole dollar amounts (caps, committed overage): "$5.00". */
export const fmtUsd = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * Unit rates are sub-cent ($0.0005/point) — currency formatting would round
 * them to a flat $0.00. At least cents, up to four decimals: "$1.50",
 * "$0.0005".
 */
export const fmtRate = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;