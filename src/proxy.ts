import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { buildCsp } from "@/lib/security/csp";

// Routes reachable without a session. Everything else requires an authenticated
// Supabase user. `/auth/confirm` is the email-confirmation/recovery callback and
// `/auth/callback` the OAuth code exchange — both run before a session exists.
// The Stripe webhook is server-to-server (it authenticates by signature, not a
// session). `/reset-password` is deliberately NOT here: the recovery link opens
// a session via /auth/confirm first, so it's reached as a protected route.
const PUBLIC_ROUTES = [
  /^\/$/,
  /^\/sign-in(?:\/.*)?$/,
  /^\/sign-up(?:\/.*)?$/,
  // The pricing page is public marketing — reachable signed-out so a prospect
  // can compare plans before creating an account (#179).
  /^\/pricing$/,
  /^\/forgot-password(?:\/.*)?$/,
  /^\/auth\/confirm(?:\/.*)?$/,
  /^\/auth\/callback(?:\/.*)?$/,
  // Invitation accept links must be reachable signed-out so a brand-new invitee
  // can land here and be sent to sign-up/sign-in (#50).
  /^\/invite(?:\/.*)?$/,
  /^\/api\/webhooks\/stripe(?:\/.*)?$/,
];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((re) => re.test(pathname));
}

export async function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  // Per-request CSP nonce. Setting the policy on the *request* headers lets Next
  // read the nonce and stamp it onto the inline scripts it injects; we mirror the
  // same policy onto every response below so the browser enforces it.
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  // Refresh the session first so the rotated cookies ride on every response.
  const { user, response } = await updateSession(request, requestHeaders);

  // Unauthenticated requests to a protected route are sent to sign-in.
  // (The no-org → /onboarding redirect returns in #47, once memberships exist.)
  if (!user && !isPublicRoute(request.nextUrl.pathname)) {
    const redirect = NextResponse.redirect(new URL("/sign-in", request.url));
    // Carry over the cookies @supabase/ssr rotated/cleared in updateSession,
    // and the request id, so the redirect doesn't desync the session.
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    redirect.headers.set("x-request-id", requestId);
    redirect.headers.set("content-security-policy", csp);
    return redirect;
  }

  response.headers.set("x-request-id", requestId);
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
