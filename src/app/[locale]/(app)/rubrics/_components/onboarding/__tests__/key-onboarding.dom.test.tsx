// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { OnboardingProvider } from "../onboarding-context";
import { GettingStartedCard } from "../getting-started-card";
import type { ProviderKeyRow } from "@/lib/llm/keys";
import enMessages from "../../../../../../../../messages/en.json";

// SetKeyDialog (reused inline by the key step) talks to a server action and the
// router; stub both so the modal renders in jsdom.
vi.mock("@/app/actions/provider-keys", () => ({
  saveProviderKey: vi.fn(),
  deleteProviderKey: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const PROVIDER_ROWS: ProviderKeyRow[] = [
  {
    provider: "anthropic",
    label: "Anthropic",
    runtimeReady: true,
    last4: null,
    hasKey: false,
    updatedAt: null,
  },
  {
    provider: "openai",
    label: "OpenAI",
    runtimeReady: true,
    last4: null,
    hasKey: false,
    updatedAt: null,
  },
];

function renderCard({
  isFreePlan,
  providerKeyCount = 0,
  rubricCount = 0,
  runCount = 0,
}: {
  isFreePlan: boolean;
  providerKeyCount?: number;
  rubricCount?: number;
  runCount?: number;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <OnboardingProvider
        data={{ rubricCount, runCount, providerKeyCount }}
        canWrite
        isFreePlan={isFreePlan}
      >
        <GettingStartedCard providerKeyRows={PROVIDER_ROWS} />
      </OnboardingProvider>
    </NextIntlClientProvider>,
  );
}

describe("Guided first-run key step (free-plan, plan-aware count)", () => {
  it("free plan leads with the key step and a 0/3 count", () => {
    renderCard({ isFreePlan: true });

    const card = screen.getByTestId("onboarding-card");
    expect(within(card).getByText("0/3")).toBeInTheDocument();

    // The key step's label leads the checklist, ahead of rubric + eval.
    const items = within(card).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Add a provider key");
    expect(items[1]).toHaveTextContent("Create your first rubric");
    expect(items[2]).toHaveTextContent("Run your first evaluation");

    // The coach-mark pins to the card's own CTA (no on-page control to anchor to).
    expect(screen.getByTestId("coach-mark")).toBeInTheDocument();
    expect(
      screen.getByText(/add your own LLM provider key/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add a provider key" }),
    ).toBeInTheDocument();
  });

  it("paid plan omits the key step and shows a 0/2 count", () => {
    renderCard({ isFreePlan: false });

    const card = screen.getByTestId("onboarding-card");
    expect(within(card).getByText("0/2")).toBeInTheDocument();
    expect(
      within(card).queryByText("Add a provider key"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/add your own LLM provider key/i),
    ).not.toBeInTheDocument();
  });

  it("free plan: rubric/eval coach-marks wait until a key exists", () => {
    // A key is added — the key step is satisfied (1/3) and the tutorial advances
    // to the rubric step, so the key CTA + coach-mark are gone.
    renderCard({ isFreePlan: true, providerKeyCount: 1 });

    const card = screen.getByTestId("onboarding-card");
    expect(within(card).getByText("1/3")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add a provider key" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/add your own LLM provider key/i),
    ).not.toBeInTheDocument();
  });

  it("the key CTA opens the existing SetKeyDialog inline (no navigation)", async () => {
    const user = userEvent.setup();
    renderCard({ isFreePlan: true });

    await user.click(screen.getByRole("button", { name: "Add a provider key" }));

    // The reused SetKeyDialog is open for the default (first runtime-ready) provider.
    expect(
      screen.getByRole("heading", { name: /Add Anthropic key/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
  });
});
