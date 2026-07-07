// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONSENT_COOKIE } from "@/lib/consent/cookie";

// cookie-preferences-button.tsx's only production dependency is
// openConsentManager() from cookie-consent.tsx, which itself pulls in
// next-intl + the locale-aware Link. Mock those the same way
// cookie-consent.dom.test.tsx does, so importing either module here doesn't
// need the full App Router runtime.
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json"))
    .default as unknown as Record<string, Record<string, string>>;
  const useTranslations = (ns: string) => {
    const dict = en[ns] ?? {};
    const t = (key: string, values?: Record<string, unknown>) => {
      let s = dict[key] ?? key;
      if (values)
        for (const [k, v] of Object.entries(values))
          s = s.replaceAll(`{${k}}`, String(v));
      return s;
    };
    t.rich = (
      key: string,
      values: Record<string, unknown> = {},
    ): React.ReactNode => {
      let raw = dict[key] ?? key;
      for (const [k, v] of Object.entries(values))
        if (typeof v !== "function") raw = raw.replaceAll(`{${k}}`, String(v));
      const nodes: React.ReactNode[] = [];
      const re = /<(\w+)>(.*?)<\/\1>/g;
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw))) {
        if (m.index > last) nodes.push(raw.slice(last, m.index));
        const fn = values[m[1]];
        nodes.push(typeof fn === "function" ? fn(m[2]) : m[2]);
        last = re.lastIndex;
      }
      if (last < raw.length) nodes.push(raw.slice(last));
      return nodes;
    };
    return t;
  };
  return { useTranslations };
});

import { CookiePreferencesButton } from "./cookie-preferences-button";
import { CookieConsent } from "./cookie-consent";

// CookiePreferencesButton is a thin trigger: it renders a <button> and, on
// click, calls openConsentManager() from cookie-consent.tsx, which dispatches
// a "baseline:consentmanage" window event that CookieConsent listens for to
// re-open the banner (#67). It holds no state of its own and never touches
// document.cookie/localStorage directly, so the contract to verify here is
// "renders with the right label/className" and "clicking dispatches the
// manage event" (both as a direct spy and, end to end, against the real
// CookieConsent listener).

function clearCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}

beforeEach(() => {
  clearCookies();
  vi.stubGlobal("location", { protocol: "http:", reload: vi.fn() });
});

describe("CookiePreferencesButton", () => {
  it("renders a button with the default label", () => {
    render(<CookiePreferencesButton />);
    expect(
      screen.getByRole("button", { name: "Cookie preferences" }),
    ).toBeInTheDocument();
  });

  it("renders custom children as the accessible name", () => {
    render(<CookiePreferencesButton>Manage cookies</CookiePreferencesButton>);
    expect(
      screen.getByRole("button", { name: "Manage cookies" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cookie preferences" }),
    ).not.toBeInTheDocument();
  });

  it("applies the className prop to the button", () => {
    render(<CookiePreferencesButton className="text-sm underline" />);
    expect(
      screen.getByRole("button", { name: "Cookie preferences" }),
    ).toHaveClass("text-sm", "underline");
  });

  it("has no className when none is passed", () => {
    render(<CookiePreferencesButton />);
    expect(screen.getByRole("button")).not.toHaveAttribute("class");
  });

  it("is a plain (non-submit) button so it never triggers a host form", () => {
    render(<CookiePreferencesButton />);
    expect(
      screen.getByRole("button", { name: "Cookie preferences" }),
    ).toHaveAttribute("type", "button");
  });

  it("dispatches the consent-manage window event on click", async () => {
    const user = userEvent.setup();
    const onManage = vi.fn();
    window.addEventListener("baseline:consentmanage", onManage);

    render(<CookiePreferencesButton />);
    await user.click(screen.getByRole("button", { name: "Cookie preferences" }));

    expect(onManage).toHaveBeenCalledOnce();

    window.removeEventListener("baseline:consentmanage", onManage);
  });

  it("is keyboard-activatable (native button semantics, no custom handler)", async () => {
    const user = userEvent.setup();
    const onManage = vi.fn();
    window.addEventListener("baseline:consentmanage", onManage);

    render(<CookiePreferencesButton />);
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Cookie preferences" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onManage).toHaveBeenCalledOnce();

    window.removeEventListener("baseline:consentmanage", onManage);
  });

  it("re-opens the real CookieConsent banner when clicked (integration)", async () => {
    document.cookie = `${CONSENT_COOKIE}=rejected; Path=/`;

    const user = userEvent.setup();
    render(
      <>
        <CookieConsent />
        <CookiePreferencesButton />
      </>,
    );

    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cookie preferences" }));

    expect(
      await screen.findByRole("region", { name: /cookie consent/i }),
    ).toBeInTheDocument();
  });
});
