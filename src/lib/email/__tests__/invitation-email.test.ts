import { describe, it, expect, vi } from "vitest";

// invitation-email / i18n import "server-only", which throws outside a server bundle.
vi.mock("server-only", () => ({}));

import { buildInvitationEmail } from "../invitation-email";
import { resolveEmailLocale } from "../i18n";

describe("resolveEmailLocale (#241 precedence)", () => {
  it("prefers the recipient's locale, then the inviter's, then en", () => {
    expect(resolveEmailLocale({ recipientLocale: "es", inviterLocale: "fr" })).toBe("es");
    expect(resolveEmailLocale({ recipientLocale: null, inviterLocale: "fr" })).toBe("fr");
    expect(resolveEmailLocale({ recipientLocale: null, inviterLocale: null })).toBe("en");
  });

  it("skips unsupported locales at each step", () => {
    // A garbage recipient locale falls through to the inviter.
    expect(resolveEmailLocale({ recipientLocale: "zz", inviterLocale: "es" })).toBe("es");
    // Both unsupported → default.
    expect(resolveEmailLocale({ recipientLocale: "zz", inviterLocale: "qq" })).toBe("en");
  });
});

describe("buildInvitationEmail localization (#241)", () => {
  const base = { to: "new@member.com", orgName: "Acme", acceptUrl: "https://app/invite/accept?token=t" };

  it("renders subject + body in Spanish for an es recipient", async () => {
    const msg = await buildInvitationEmail({ ...base, locale: "es" });
    expect(msg.subject).toBe("Te han invitado a Acme en Baseline");
    expect(msg.html).toContain('lang="es"');
    expect(msg.html).toContain("Te han invitado a Acme");
    expect(msg.html).toContain("Aceptar invitación");
    // Localized footer chrome, not just the body.
    expect(msg.html).toContain("suscripción activa a Baseline");
  });

  it("renders in French for an fr recipient", async () => {
    const msg = await buildInvitationEmail({ ...base, locale: "fr" });
    expect(msg.subject).toBe("Invitation à rejoindre Acme sur Baseline");
    expect(msg.html).toContain('lang="fr"');
    expect(msg.html).toContain("Accepter l'invitation");
  });

  it("renders in English for the default locale", async () => {
    const msg = await buildInvitationEmail({ ...base, locale: "en" });
    expect(msg.subject).toBe("You've been invited to Acme on Baseline");
    expect(msg.html).toContain('lang="en"');
    expect(msg.html).toContain("Accept invitation");
  });

  it("falls back to English for an unsupported locale (no preference exists)", async () => {
    const msg = await buildInvitationEmail({ ...base, locale: "zz" });
    expect(msg.subject).toBe("You've been invited to Acme on Baseline");
    expect(msg.html).toContain('lang="en"');
  });

  it("keeps the org name escaped and the subject newline-stripped (header safety)", async () => {
    const msg = await buildInvitationEmail({
      ...base,
      orgName: "Acme\r\n<script>",
      locale: "en",
    });
    expect(msg.subject).not.toMatch(/[\r\n]/);
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
  });
});
