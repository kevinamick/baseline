import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Routes reachable without a session. Everything else requires an authenticated
// Supabase user. `/auth/confirm` is the email-confirmation callback; the Clerk
// webhook lives under `/api/webhooks` until it is removed in the final cutover.
const PUBLIC_ROUTES = [
  /^\/$/,
  /^\/sign-in(?:\/.*)?$/,
  /^\/sign-up(?:\/.*)?$/,
  /^\/auth\/confirm(?:\/.*)?$/,
  /^\/api\/webhooks(?:\/.*)?$/,
];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((re) => re.test(pathname));
}

export async function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  // Refresh the session first so the rotated cookies ride on every response.
  const { user, response } = await updateSession(request, requestHeaders);

  // Unauthenticated requests to a protected route are sent to sign-in.
  // (The no-org → /onboarding redirect returns in #47, once memberships exist.)
  if (!user && !isPublicRoute(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
