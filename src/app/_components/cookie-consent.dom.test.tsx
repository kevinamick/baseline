// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CookieConsent } from "./cookie-consent";
import { CONSENT_COOKIE } from "@/lib/consent/cookie";

const reload = vi.fn();

function clearCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}

beforeEach(() => {
  reload.mockClear();
  clearCookies();
  // Stub `location` so writeConsent (reads protocol) and accept (calls reload)
  // don't touch jsdom's unimplemented navigation.
  vi.stubGlobal("location", { protocol: "http:", reload });
});

describe("CookieConsent", () => {
  it("shows the banner when no choice has been made", async () => {
    render(<CookieConsent />);
    expect(
      await screen.findByRole("dialog", { name: /cookie consent/i }),
    ).toBeInTheDocument();
  });

  it("renders nothing once a choice is already stored", () => {
    document.cookie = `${CONSENT_COOKIE}=accepted; Path=/`;
    render(<CookieConsent />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("records acceptance and dismisses without reloading", async () => {
    render(<CookieConsent />);
    await userEvent.click(await screen.findByRole("button", { name: /accept/i }));

    expect(document.cookie).toContain(`${CONSENT_COOKIE}=accepted`);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("records rejection and reloads to tear analytics down", async () => {
    render(<CookieConsent />);
    await userEvent.click(await screen.findByRole("button", { name: /reject/i }));

    expect(document.cookie).toContain(`${CONSENT_COOKIE}=rejected`);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("links to the privacy notice", async () => {
    render(<CookieConsent />);
    const link = await screen.findByRole("link", {
      name: /privacy & cookie notice/i,
    });
    expect(link).toHaveAttribute("href", "/privacy");
  });
});
