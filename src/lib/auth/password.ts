// Single source of truth for the minimum password length, shared by the
// account password-change action and its client form's `minLength`. Must stay
// in sync with `minimum_password_length` in supabase/config.toml — Supabase is
// the real enforcer; these are the inline guard and the native form hint.
export const MIN_PASSWORD_LENGTH = 6;
