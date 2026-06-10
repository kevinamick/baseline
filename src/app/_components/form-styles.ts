// The app-wide canonical text-input style. Several forms outside the wizards still
// carry byte-identical private copies (auth-form, rubric-dialog, create-team-form,
// invite-member-form, …) — deduping those onto this constant is a follow-up; new
// form fields should import it from here.
export const inputCls =
  "w-full rounded-md border border-hairline-field bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/40";
