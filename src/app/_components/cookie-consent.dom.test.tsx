// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import userEvent from "@testing-library/user-event";
import { CookieConsent, openConsentManager } from "./cookie-consent";
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
      await screen.findByRole("region", { name: /cookie consent/i }),
    ).toBeInTheDocument();
  });

  it("renders nothing once a choice is already stored", () => {
    document.cookie = `${CONSENT_COOKIE}=accepted; Path=/`;
    render(<CookieConsent />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  // Regression: the server snapshot must render nothing even with no stored
  // choice, so a returning visitor who already chose doesn't see the banner
  // flash in during hydration before the cookie is read.
  it("renders nothing on the server (no hydration flash)", () => {
    expect(renderToStaticMarkup(<CookieConsent />)).toBe("");
  });

  it("records rejection and dismisses without reloading", async () => {
    render(<CookieConsent />);
    await userEvent.click(await screen.findByRole("button", { name: /reject/i }));

    expect(document.cookie).toContain(`${CONSENT_COOKIE}=rejected`);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("records acceptance and reloads to bring analytics online", async () => {
    render(<CookieConsent />);
    await userEvent.click(await screen.findByRole("button", { name: /accept/i }));

    expect(document.cookie).toContain(`${CONSENT_COOKIE}=accepted`);
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

describe("CookieConsent — revisiting a prior choice (#67)", () => {
  it("re-opens after a choice and shows the current state", async () => {
    document.cookie = `${CONSENT_COOKIE}=rejected; Path=/`;
    render(<CookieConsent />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    await act(async () => openConsentManager());

    expect(
      await screen.findByRole("region", { name: /cookie consent/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/analytics are currently/i)).toHaveTextContent(
      /off/i,
    );
  });

  it("switching rejected → accepted reloads to bring analytics online", async () => {
    document.cookie = `${CONSENT_COOKIE}=rejected; Path=/`;
    render(<CookieConsent />);
    await act(async () => openConsentManager());
    await userEvent.click(await screen.findByRole("button", { name: /accept/i }));

    expect(document.cookie).toContain(`${CONSENT_COOKIE}=accepted`);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("switching accepted → rejected reloads to tear analytics down", async () => {
    document.cookie = `${CONSENT_COOKIE}=accepted; Path=/`;
    render(<CookieConsent />);
    await act(async () => openConsentManager());
    await userEvent.click(await screen.findByRole("button", { name: /reject/i }));

    expect(document.cookie).toContain(`${CONSENT_COOKIE}=rejected`);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("re-confirming the same choice closes without reloading", async () => {
    document.cookie = `${CONSENT_COOKIE}=rejected; Path=/`;
    render(<CookieConsent />);
    await act(async () => openConsentManager());
    await userEvent.click(await screen.findByRole("button", { name: /reject/i }));

    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("the close button dismisses without changing the choice", async () => {
    document.cookie = `${CONSENT_COOKIE}=accepted; Path=/`;
    render(<CookieConsent />);
    await act(async () => openConsentManager());
    await userEvent.click(
      await screen.findByRole("button", { name: /close cookie preferences/i }),
    );

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(document.cookie).toContain(`${CONSENT_COOKIE}=accepted`);
    expect(reload).not.toHaveBeenCalled();
  });
});
