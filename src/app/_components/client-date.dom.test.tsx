// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ClientDate } from "./client-date";

function renderAt(locale: string, ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale={locale} messages={{}} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("ClientDate", () => {
  it("renders a medium date + short time with no seconds", async () => {
    renderAt("en", <ClientDate value="2026-07-02T16:13:04Z" />);
    // The exact string depends on the test runner's timezone; the invariants
    // are month-name shape (medium style) and no seconds component.
    await waitFor(() => expect(screen.queryByText("…")).not.toBeInTheDocument());
    const text = document.body.textContent ?? "";
    expect(text).toContain("Jul");
    expect(text).toMatch(/\d{1,2}:\d{2}/);
    expect(text).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it("formats in the app locale, not the browser's", async () => {
    renderAt("es", <ClientDate value="2026-07-02T16:13:04Z" dateOnly />);
    // Spanish medium date: "2 jul 2026".
    await waitFor(() => expect(document.body.textContent).toContain("jul"));
    expect(document.body.textContent).not.toContain("Jul 2");
  });

  it("localizes relative times without catalog keys", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    renderAt("fr", <ClientDate value={threeDaysAgo} relative />);
    // French narrow relative day: "il y a 3 j".
    await waitFor(() => expect(document.body.textContent).toContain("il y a 3"));
  });

  it("renders the placeholder for a null value", async () => {
    renderAt("en", <ClientDate value={null} />);
    await waitFor(() => expect(screen.getByText("—")).toBeInTheDocument());
  });
});
