// Asserts every worker report email carries the Baseline Design System chrome
// (wrapEmail / ctaButton / EMAIL) end-to-end through its real send function, routed
// via the dev Mailpit transport so the captured HTML is exactly what would be delivered.
// Mirrors the transport mocking used in emailer.test.ts / optimization-emailer.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSendMail, mockCreateTransport } = vi.hoisted(() => {
  const mockSendMail = vi.fn();
  return {
    mockSendMail,
    mockCreateTransport: vi.fn(() => ({ sendMail: mockSendMail })),
  };
});

vi.mock("resend", () => ({ Resend: class { emails = { send: vi.fn() }; } }));
vi.mock("nodemailer", () => ({ createTransport: mockCreateTransport }));

import { sendCompletionEmail, sendFailureEmail } from "./emailer.js";
import {
  sendOptimizationCompletionEmail,
  sendOptimizationFailureEmail,
  sendOptimizationPausedEmail,
} from "./optimization-emailer.js";

beforeEach(() => {
  mockSendMail.mockReset().mockResolvedValue({ messageId: "m1" });
  mockCreateTransport.mockClear();
  process.env.MAILPIT_SMTP_HOST = "127.0.0.1";
});

function lastHtml(): string {
  return mockSendMail.mock.calls[0][0].html as string;
}

// Baseline chrome markers: porcelain bg, cobalt logo, white card, dark mode, footer, CTA.
function expectThemed(html: string) {
  expect(html).toContain("<!DOCTYPE html>");
  expect(html).toContain("background:#F5F3EC");
  expect(html).toContain("Baseline");
  expect(html).toContain('class="em-card"');
  expect(html).toContain("prefers-color-scheme: dark");
  expect(html).toContain("support@baseline.run");
  expect(html).toContain('class="em-cta"');
}

describe("Baseline theming on worker report emails", () => {
  it("wraps the eval-run completion email", async () => {
    await sendCompletionEmail({
      to: ["user@example.com"],
      runId: "run_1",
      rubricName: "Customer Support Quality",
      overallScore: 0.876,
      rowCount: 124,
      appUrl: "https://app.baseline.run",
    });
    expectThemed(lastHtml());
  });

  it("wraps the eval-run failure email", async () => {
    await sendFailureEmail({
      to: ["user@example.com"],
      runId: "run_1",
      rubricName: "Customer Support Quality",
      errorMessage: "Provider returned HTTP 503 after 3 retries",
      appUrl: "https://app.baseline.run",
    });
    expectThemed(lastHtml());
  });

  it("wraps the optimization completion email", async () => {
    await sendOptimizationCompletionEmail("user@example.com", {
      runId: "run_2",
      connectionName: "Support Triage Agent",
      seedScore: 0.62,
      bestScore: 0.81,
      rolloutsUsed: 40,
      instanceCount: 8,
      appUrl: "https://app.baseline.run",
    });
    expectThemed(lastHtml());
  });

  it("wraps the optimization failure email", async () => {
    await sendOptimizationFailureEmail("user@example.com", {
      runId: "run_2",
      connectionName: "Support Triage Agent",
      errorMessage: "Agent endpoint unreachable (connection refused)",
      appUrl: "https://app.baseline.run",
    });
    expectThemed(lastHtml());
  });

  it("wraps the optimization paused email", async () => {
    await sendOptimizationPausedEmail("user@example.com", {
      runId: "run_2",
      connectionName: "Support Triage Agent",
      reason: "Your agent endpoint stopped responding",
      appUrl: "https://app.baseline.run",
    });
    expectThemed(lastHtml());
  });

  it("HTML-escapes caller-supplied previewText (closes the latent XSS)", async () => {
    await sendOptimizationCompletionEmail("user@example.com", {
      runId: "run_3",
      connectionName: "<img src=x onerror=alert(1)>",
      seedScore: 0.5,
      bestScore: 0.7,
      rolloutsUsed: 10,
      instanceCount: 2,
      appUrl: "https://app.baseline.run",
    });
    const html = lastHtml();
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });
});
