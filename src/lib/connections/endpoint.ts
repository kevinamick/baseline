// A Connection endpoint must use HTTPS in production so the credential is encrypted
// in flight. In development (and tests) we allow http too, so local testing against a
// mock agent works without certs. process.env.NODE_ENV is available at runtime on the
// server (zod path) and inlined at build time on the client (wizard), so both agree.

export const ENDPOINT_HTTPS_MESSAGE = "Endpoint must use HTTPS";

export function isAllowedEndpointUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  // http is permitted only outside production.
  if (url.protocol === "http:") return process.env.NODE_ENV === "development";
  return false;
}
