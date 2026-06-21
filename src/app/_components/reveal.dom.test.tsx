// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Reveal } from "./reveal";

// jsdom ships neither matchMedia nor IntersectionObserver. Reveal guards both
// with optional chaining / typeof, so the *baseline* (no globals) exercises the
// SSR-safe "always visible" path; individual tests install fakes to drive the
// reduced-motion and below-the-fold branches.

type IOEntryInit = { isIntersecting: boolean };
let observers: FakeIntersectionObserver[] = [];

class FakeIntersectionObserver {
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    observers.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
  // Test helper: simulate the browser reporting intersection state.
  emit(entries: IOEntryInit[]) {
    this.callback(
      entries as unknown as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver
    );
  }
}

function installMatchMedia(reduce: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: reduce }),
  });
}

beforeEach(() => {
  observers = [];
});

afterEach(() => {
  // @ts-expect-error — tear the fakes back off the global between tests.
  delete window.matchMedia;
  // @ts-expect-error — same for the observer.
  delete window.IntersectionObserver;
  vi.restoreAllMocks();
});

describe("Reveal — visible by default", () => {
  it("renders children visible with no globals (SSR / no-JS / crawler path)", () => {
    render(
      <Reveal>
        <p>hero copy</p>
      </Reveal>
    );
    expect(screen.getByText("hero copy")).toBeInTheDocument();
    const wrapper = screen.getByText("hero copy").parentElement!;
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.className).toContain("translate-y-0");
    expect(wrapper.className).not.toContain("opacity-0");
  });

  it("forwards className and applies the stagger delay as a transition-delay style", () => {
    render(
      <Reveal className="custom-class" delay={120}>
        <p>delayed</p>
      </Reveal>
    );
    const wrapper = screen.getByText("delayed").parentElement!;
    expect(wrapper.className).toContain("custom-class");
    expect(wrapper.style.transitionDelay).toBe("120ms");
  });

  it("omits the transition-delay style when delay is 0", () => {
    render(
      <Reveal>
        <p>no delay</p>
      </Reveal>
    );
    const wrapper = screen.getByText("no delay").parentElement!;
    expect(wrapper.style.transitionDelay).toBe("");
  });
});

describe("Reveal — prefers-reduced-motion", () => {
  it("stays visible and never arms an observer when reduced motion is requested", async () => {
    installMatchMedia(true);
    window.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;

    render(
      <Reveal>
        <p>reduced</p>
      </Reveal>
    );

    // Give the rAF a chance to (not) run.
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const wrapper = screen.getByText("reduced").parentElement!;
    expect(wrapper.className).toContain("opacity-100");
    expect(observers).toHaveLength(0);
  });
});

describe("Reveal — below-the-fold arming", () => {
  it("hides an off-screen element, then fades it in when it scrolls into view", async () => {
    installMatchMedia(false);
    window.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    // Report the element as far below the fold so the rAF arms the fade.
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ top: 10_000 } as DOMRect);

    render(
      <Reveal>
        <p>below fold</p>
      </Reveal>
    );
    const wrapper = screen.getByText("below fold").parentElement!;

    // After the next frame the element is armed hidden and an observer watches it.
    await waitFor(() => expect(wrapper.className).toContain("opacity-0"));
    expect(wrapper.className).toContain("translate-y-4");
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toContain(wrapper);

    // Simulate it crossing into view → it reveals and the observer disconnects.
    rectSpy.mockReturnValue({ top: 100 } as DOMRect);
    observers[0].emit([{ isIntersecting: true }]);

    await waitFor(() => expect(wrapper.className).toContain("opacity-100"));
    expect(observers[0].disconnected).toBe(true);
  });

  it("leaves an already-on-screen element visible without arming a fade", async () => {
    installMatchMedia(false);
    window.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    // Above the fold → the rAF bails before hiding anything.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 50,
    } as DOMRect);

    render(
      <Reveal>
        <p>on screen</p>
      </Reveal>
    );
    const wrapper = screen.getByText("on screen").parentElement!;

    await new Promise((r) => requestAnimationFrame(() => r(null)));

    expect(wrapper.className).toContain("opacity-100");
    expect(observers).toHaveLength(0);
  });
});
