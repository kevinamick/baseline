"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { BrandMark } from "./brand-mark";
import { ThemeToggle } from "./theme-toggle";
import { initials } from "@/lib/initials";
import { BellIcon } from "./icons";
import { NavMenuSheet, navSheetItem } from "./nav-menu-sheet";

// Center-menu sections. Flip `ready` to true (or drop it) once the page
// exists; the active-state logic below already handles every item the same way.
const NAV_ITEMS: {
  key: "dashboard" | "rubrics" | "schedules" | "optimizations";
  href: string;
  ready?: boolean;
}[] = [
  { key: "dashboard", href: "/dashboard", ready: true },
  { key: "rubrics", href: "/rubrics", ready: true },
  { key: "schedules", href: "/schedules", ready: true },
  { key: "optimizations", href: "/optimizations", ready: true },
];

// Shared center-menu item styling. Active = ink pill; inactive lifts on hover.
const navItemBase =
  "rounded-full px-4 py-[7px] text-[13px] font-medium transition-colors";
const navItemActive = "bg-ink text-fg-on-ink";
const navItemInactive = "text-fg-2 hover:text-ink";

// Match the item's own route — exact, or a nested path under it (so /rubrics
// stays active on /rubrics/123 but not on /rubrics-archive).
function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavBarClient({ workspaceName }: { workspaceName: string }) {
  const pathname = usePathname();
  const t = useTranslations("AppShell");

  return (
    <header className="mx-auto flex w-full max-w-[1360px] shrink-0 items-center gap-3 px-6 py-4">
      {/* Logo pill */}
      <Link
        href="/"
        title={t("home")}
        className="flex shrink-0 items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold text-ink tracking-[-0.01em] transition-colors hover:bg-card-warm"
      >
        <BrandMark size={20} />
        <span>Baseline</span>
      </Link>

      {/* Workspace pill (ADR-0020): the one Local Workspace, a static label.
          Below md it moves into the mobile sheet to keep the bar from
          overflowing. */}
      <div className="hidden md:block">
        <WorkspacePill name={workspaceName} />
      </div>

      {/* Center menu — the primary destinations. Hidden below md, where they
          move into the mobile sheet. */}
      <nav className="hidden flex-1 items-center justify-center gap-0.5 rounded-full border border-hairline-cool bg-card p-[5px] md:flex">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          const className = `${navItemBase} ${active ? navItemActive : navItemInactive}`;
          // Dummy until the page exists — render a no-op button, not a dead link.
          return item.ready ? (
            <Link
              key={item.key}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={className}
            >
              {t(item.key)}
            </Link>
          ) : (
            <button key={item.key} type="button" className={className}>
              {t(item.key)}
            </button>
          );
        })}
      </nav>

      {/* Right cluster — `ml-auto` pushes it to the edge below md, where the
          flex-1 center nav (which normally does that) is hidden. */}
      <div className="ml-auto flex items-center gap-2">
        <NotificationBell />
        <MobileNavSheet pathname={pathname} workspaceName={workspaceName} />
        <SettingsMenu workspaceName={workspaceName} />
      </div>
    </header>
  );
}

// The mobile menu: surfaces the primary destinations and the Workspace label,
// both hidden from the bar below md. Reuses the shared paper-sheet primitive.
function MobileNavSheet({
  pathname,
  workspaceName,
}: {
  pathname: string | null;
  workspaceName: string;
}) {
  const t = useTranslations("AppShell");
  return (
    <NavMenuSheet label={t("menu")} triggerClassName="md:hidden">
      {(close) => (
        <>
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            const itemCls = `${navSheetItem} ${active ? "bg-card-warm text-ink" : ""}`;
            return item.ready ? (
              <Link
                key={item.key}
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={close}
                className={itemCls}
              >
                {t(item.key)}
              </Link>
            ) : (
              <button key={item.key} type="button" className={itemCls}>
                {t(item.key)}
              </button>
            );
          })}

          <div className="my-1 h-px bg-hairline-cool" />
          <div
            aria-current="true"
            className={`${navSheetItem} justify-between bg-card-warm text-ink`}
          >
            <span className="truncate">{workspaceName}</span>
          </div>
        </>
      )}
    </NavMenuSheet>
  );
}

// The Workspace pill: initials badge + name, capped so a long name truncates
// rather than overflowing into the nav.
function WorkspacePill({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card py-2 pl-2 pr-3.5 text-sm font-medium text-ink">
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-fg-on-accent">
        {initials(name)}
      </span>
      <span className="max-w-[150px] truncate">{name}</span>
    </div>
  );
}

function NotificationBell() {
  const t = useTranslations("AppShell");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (
        !popoverRef.current?.contains(t) &&
        !triggerRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t("notifications")}
        title={t("notifications")}
        className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline-cool bg-card text-ink transition-colors hover:bg-card-warm"
      >
        <BellIcon size={16} />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-12 z-10 flex w-72 flex-col rounded-2xl border border-hairline-cool bg-card p-1.5 shadow-card"
        >
          <div className="px-3 py-2 text-[11px] font-medium text-fg-3">
            {t("notifications")}
          </div>
          <div className="my-1 h-px bg-hairline-cool" />
          <div className="px-3 py-6 text-center text-[13px] text-fg-3">
            {t("notificationsEmpty")}
          </div>
        </div>
      )}
    </div>
  );
}

// The settings menu: a gear that toggles a small disclosure popover with the
// theme toggle and links to the Workspace's settings pages. A plain popover
// (not an ARIA `menu`) — Tab already walks the items. Focus moves into the
// popover on open and back to the trigger on Escape.
function SettingsMenu({ workspaceName }: { workspaceName: string }) {
  const t = useTranslations("AppShell");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (
        !popoverRef.current?.contains(t) &&
        !triggerRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus(); // restore focus to the trigger
      }
    }
    // Move focus into the popover (first interactive item) on open.
    popoverRef.current
      ?.querySelector<HTMLElement>("a, button")
      ?.focus();

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const itemCls =
    "rounded-lg px-3 py-2 text-left text-[13px] text-fg-2 transition-colors hover:bg-card-warm hover:text-ink";

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t("settings")}
        title={t("settings")}
        className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline-cool bg-card text-ink transition-colors hover:bg-card-warm"
      >
        <GearIcon />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-12 z-10 flex w-60 flex-col rounded-2xl border border-hairline-cool bg-card p-1.5 shadow-card"
        >
          <div className="px-3 py-2">
            <div className="text-[11px] text-fg-3">{t("workspace")}</div>
            <div className="truncate text-[13px] font-medium text-ink">
              {workspaceName}
            </div>
          </div>
          <div className="my-1 h-px bg-hairline-cool" />
          <ThemeToggle />
          <div className="my-1 h-px bg-hairline-cool" />
          <Link href="/settings/connections" onClick={() => setOpen(false)} className={itemCls}>
            {t("connections")}
          </Link>
          <Link href="/settings/team" onClick={() => setOpen(false)} className={itemCls}>
            {t("providerKeys")}
          </Link>
        </div>
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
