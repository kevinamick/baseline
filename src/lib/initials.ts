/**
 * Two-letter initials for an avatar/badge, derived from a name, org name, or
 * email. Emails use their local part ("jane.doe@x.com" -> "JD"); multi-word
 * input takes the first letter of the first two words ("Acme Engineering" ->
 * "AE"); a single word takes its first two letters ("acme" -> "AC").
 */
export function initials(input: string | null | undefined): string {
  if (!input) return "?";
  const base = input.includes("@") ? input.split("@")[0] : input;
  const words = base.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
