// @vitest-environment jsdom
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { DashboardClient } from "./dashboard-client";
import { DAY_MS, toneFor, type DashRubric, type DashRun, type DashboardData } from "../_lib/dashboard-data";
import enMessages from "../../../../../../messages/en.json";
import frMessages from "../../../../../../messages/fr.json";

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => searchParams,
}));

// next-intl's navigation entry pulls in next/navigation, unresolvable in jsdom —
// mock the locale-aware Link this component uses to a plain anchor.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/analytics/client", () => ({ track: vi.fn() }));

// Render under the real next-intl provider so useTranslations/useLocale resolve
// against the actual English catalog (real ICU plurals, not a stubbed dict).
function renderDash(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

// ScoreWithTooltip lazy-fetches via a server action; stub the action module so
// importing it doesn't drag server-only code into jsdom.
vi.mock("@/app/actions/eval-runs", () => ({ getRunCriteriaBreakdown: vi.fn() }));
vi.mock("@/app/[locale]/(app)/rubrics/_components/run-eval-dialog", () => ({ RunEvalDialog: () => null }));

// The real chart needs ResizeObserver and pixel math; the domain prop is what
// the client computes, so expose it for assertions and skip the SVG.
vi.mock("./charts", () => ({
  ScoreTimeChart: ({ domain }: { domain: { t0: number; t1: number } }) => (
    <div data-testid="chart" data-t0={domain.t0} data-t1={domain.t1} />
  ),
  Sparkline: () => <svg />,
  StatusMix: () => <div />,
}));

const TODAY = new Date(2026, 5, 10, 12).getTime();

function rubric(id: string, name: string, i: number): DashRubric {
  return { id, name, mode: "prompt_response", createdAt: "2026-01-01T00:00:00Z", tone: toneFor(i), criteria: [] };
}

let runSeq = 0;
function run(rubricId: string, daysAgo: number, score: number | null, status: DashRun["status"] = "completed"): DashRun {
  runSeq += 1;
  return { id: `run-${runSeq}`, rubricId, runNo: runSeq, t: TODAY - daysAgo * DAY_MS, score, status };
}

// "Active" has a busy recent history; "Dormant" last ran ~4 months ago with a
// passing score — the regression this feature fixes is it vanishing entirely.
function makeData(): DashboardData {
  const active = rubric("rub-active", "Active rubric", 0);
  const dormant = rubric("rub-dormant", "Dormant rubric", 1);
  const runs = [
    ...Array.from({ length: 12 }, (_, i) => run("rub-active", 24 - i * 2, 0.7 + i * 0.01)),
    ...Array.from({ length: 10 }, (_, i) => run("rub-dormant", 140 - i * 2, 0.9)),
  ].sort((a, b) => a.t - b.t);
  return { teamName: "Acme", rubrics: [active, dormant], runs, today: TODAY };
}

function chartDomain() {
  const el = screen.getByTestId("chart");
  return { t0: Number(el.getAttribute("data-t0")), t1: Number(el.getAttribute("data-t1")) };
}

beforeEach(() => {
  searchParams = new URLSearchParams();
  window.history.replaceState(null, "", "/dashboard");
});

describe("latest-ever semantics", () => {
  it("keeps a dormant rubric on the leaderboard with its Latest Score and last-run note", () => {
    renderDash(<DashboardClient data={makeData()} canWrite />);
    // The truncating name div lives only in leaderboard rows (the chart chips
    // put the name directly inside a button).
    const row = screen
      .getByText("Dormant rubric", { selector: "div.truncate" })
      .closest("button") as HTMLElement;
    expect(within(row).getByText("90%")).toBeInTheDocument();
    expect(row).toHaveTextContent(/0 runs · last run \d+ days ago/);
  });

  it("renders relative times as 'ago' phrases in French, not minus notation", () => {
    render(
      <NextIntlClientProvider locale="fr" messages={frMessages} timeZone="UTC">
        <DashboardClient data={makeData()} canWrite />
      </NextIntlClientProvider>,
    );
    // Narrow style would render "-116 j"; short must give the "il y a" phrase.
    // \s throughout: Intl separates French phrase tokens with non-breaking spaces.
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/il\s+y\s+a\s+\d+\s+j/);
    expect(body).not.toMatch(/-\d+\s+j/);
  });

  it("counts dormant rubrics in the passing KPI", () => {
    renderDash(<DashboardClient data={makeData()} canWrite />);
    // Active latest ≈ 0.81 and Dormant 0.9 both pass → 2 / 2.
    const denominator = screen.getByText("/ 2");
    expect(denominator.previousElementSibling).toHaveTextContent("2");
  });
});

describe("range modes", () => {
  it("defaults to Auto and re-fits when focus moves to a dormant rubric", async () => {
    const user = userEvent.setup();
    renderDash(<DashboardClient data={makeData()} canWrite />);

    // Initially focused on the active rubric: a tight window, well inside 90d.
    expect(chartDomain().t0).toBeGreaterThan(TODAY - 40 * DAY_MS);
    expect(screen.getByTestId("chart-span")).toHaveTextContent("· auto");

    await user.click(screen.getByRole("button", { name: "Focus Dormant rubric" }));
    // Auto zooms out past the dormant rubric's newest run (~120d ago).
    expect(chartDomain().t0).toBeLessThan(TODAY - 120 * DAY_MS);
  });

  it("pins a preset across focus changes and returns on Auto", async () => {
    const user = userEvent.setup();
    renderDash(<DashboardClient data={makeData()} canWrite />);

    await user.click(screen.getByRole("button", { name: "90d" }));
    expect(chartDomain().t0).toBe(TODAY - 90 * DAY_MS);
    expect(screen.getByTestId("chart-span")).toHaveTextContent("· 90d");

    await user.click(screen.getByRole("button", { name: "Focus Dormant rubric" }));
    expect(chartDomain().t0).toBe(TODAY - 90 * DAY_MS); // still pinned

    await user.click(screen.getByRole("button", { name: "Auto" }));
    expect(chartDomain().t0).toBeLessThan(TODAY - 120 * DAY_MS); // re-fits to focus
  });

  it("resyncs to defaults when the nav Dashboard link clears the URL params (#177)", () => {
    // Arrive on a shared link with a pinned range, non-default focus, and a
    // hidden series.
    searchParams = new URLSearchParams("range=90&focus=rub-dormant&hidden=rub-dormant");
    window.history.replaceState(null, "", "/dashboard?range=90&focus=rub-dormant&hidden=rub-dormant");
    const data = makeData();
    // A fresh element per render pass: re-rendering the identical element
    // reference lets React bail out without calling the component again.
    const tree = () => (
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <DashboardClient data={data} canWrite />
      </NextIntlClientProvider>
    );
    const { rerender } = render(tree());
    expect(chartDomain().t0).toBe(TODAY - 90 * DAY_MS);
    expect(screen.getByRole("button", { name: "Show Dormant rubric on chart" })).toBeInTheDocument();

    // Clicking the nav Dashboard link clears the params on the same route —
    // the NavBar lives in the persistent (app) layout, so the client does NOT
    // remount; only searchParams changes.
    searchParams = new URLSearchParams();
    window.history.replaceState(null, "", "/dashboard");
    rerender(tree());

    // State resets to the default view (auto range fitted to the first
    // rubric's recent runs, nothing hidden)…
    expect(screen.getByTestId("chart-span")).toHaveTextContent("· auto");
    expect(chartDomain().t0).toBeGreaterThan(TODAY - 40 * DAY_MS);
    expect(screen.getByRole("button", { name: "Hide Dormant rubric from chart" })).toBeInTheDocument();
    // …and the writer effect must not rewrite the stale params back into the
    // cleaned URL.
    expect(window.location.search).toBe("");
  });

  it("initializes from URL params and writes state back shallowly", async () => {
    const user = userEvent.setup();
    searchParams = new URLSearchParams("range=7");
    renderDash(<DashboardClient data={makeData()} canWrite />);

    expect(chartDomain().t0).toBe(TODAY - 7 * DAY_MS);

    await user.click(screen.getByRole("button", { name: "90d" }));
    expect(window.location.search).toContain("range=90");

    await user.click(screen.getByRole("button", { name: "Focus Dormant rubric" }));
    expect(window.location.search).toContain("focus=rub-dormant");
  });
});

describe("failed-runs KPI pill", () => {
  it("shows the calm all-clear chip when no runs failed", () => {
    renderDash(<DashboardClient data={makeData()} canWrite />);
    expect(screen.getByText("all clear")).toBeInTheDocument();
    expect(screen.queryByText("attention")).not.toBeInTheDocument();
  });

  it("swaps to the attention chip when a run in the window failed", () => {
    const data = makeData();
    data.runs.push(run("rub-active", 1, null, "failed"));
    renderDash(<DashboardClient data={data} canWrite />);
    expect(screen.getByText("attention")).toBeInTheDocument();
    expect(screen.queryByText("all clear")).not.toBeInTheDocument();
  });
});
