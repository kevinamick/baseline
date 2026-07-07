import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Fragment, type ReactElement } from "react";

const mockCookiesGet = vi.fn();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mockCookiesGet })),
  headers: vi.fn(async () => new Headers({ "x-nonce": "test-nonce-abc" })),
}));
// `server-only` throws if imported outside a server bundle (pulled in via
// @/lib/consent/server); stub it for the test env.
vi.mock("server-only", () => ({}));

import { GoogleAnalytics } from "./google-analytics";

// #448: the GA4 loader tag renders nothing at all — no <script>, no request,
// no `_ga` cookie — unless BOTH NEXT_PUBLIC_GA_MEASUREMENT_ID is configured
// AND the visitor has accepted analytics (analytics_consent=accepted, read
// server-side via next/headers `cookies()`, mocked above). Same posture as
// the PostHog client init (#68), enforced server-side here.
//
// GoogleAnalytics is an async Server Component, so this asserts on the
// returned React element tree directly rather than mounting it (Server
// Components aren't renderable via ReactDOM/RTL the way the sibling
// org-json-ld.dom.test.tsx's synchronous component is).

type ScriptProps = {
  src?: string;
  async?: boolean;
  nonce?: string;
  dangerouslySetInnerHTML?: { __html: string };
};

function childScripts(element: ReactElement | null) {
  expect(element).not.toBeNull();
  expect(element!.type).toBe(Fragment);
  const children = (element!.props as { children: ReactElement<ScriptProps>[] })
    .children;
  expect(children).toHaveLength(2);
  return children;
}

describe("GoogleAnalytics", () => {
  beforeEach(() => {
    mockCookiesGet.mockReset();
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders nothing when NEXT_PUBLIC_GA_MEASUREMENT_ID is unset, even with consent accepted", async () => {
    mockCookiesGet.mockReturnValue({ value: "accepted" });
    expect(await GoogleAnalytics()).toBeNull();
  });

  it("renders nothing when configured but no consent decision has been made", async () => {
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "G-TEST12345");
    mockCookiesGet.mockReturnValue(undefined);
    expect(await GoogleAnalytics()).toBeNull();
  });

  it("renders nothing when configured and the visitor rejected", async () => {
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "G-TEST12345");
    mockCookiesGet.mockReturnValue({ value: "rejected" });
    expect(await GoogleAnalytics()).toBeNull();
  });

  it("renders the gtag loader + config scripts, nonced, when configured and accepted", async () => {
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "G-TEST12345");
    mockCookiesGet.mockReturnValue({ value: "accepted" });
    const element = await GoogleAnalytics();
    const [loader, config] = childScripts(element);

    expect(loader.props.src).toBe(
      "https://www.googletagmanager.com/gtag/js?id=G-TEST12345",
    );
    expect(loader.props.async).toBe(true);
    expect(loader.props.nonce).toBe("test-nonce-abc");

    expect(config.props.nonce).toBe("test-nonce-abc");
    const html = config.props.dangerouslySetInnerHTML?.__html ?? "";
    expect(html).toContain("gtag('config', 'G-TEST12345');");
    expect(html).toContain("gtag('js', new Date());");
  });
});
