"use client";

import { useEffect, useOptimistic, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { SignOutButton } from "./sign-out-button";
import { BrandMark } from "./brand-mark";
import { ThemeToggle } from "./theme-toggle";
import { initials } from "@/lib/initials";
import { BellIcon } from "./icons";
import { switchOrg } from "@/app/actions/active-org";
import { NavMenuSheet, navSheetItem } from "./nav-menu-sheet";
import type { UserOrg } from "@/lib/auth/members";

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

export function NavBarClient({
  orgs,
  activeOrgId,
  email,
  canManageTeam = false,
}: {
  orgs: UserOrg[];
  activeOrgId: string | null;
  email: string | null;
  canManageTeam?: boolean;
}) {
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

      {/* Team display / switcher. With one org (or none) it's a static pill;
          with several the user can switch the active org (#52). Below md it
          moves into the mobile sheet to keep the bar from overflowing. */}
      <div className="hidden md:block">
        <OrgSwitcher orgs={orgs} activeOrgId={activeOrgId} />
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
        <MobileNavSheet
          pathname={pathname}
          orgs={orgs}
          activeOrgId={activeOrgId}
        />
        <AccountMenu email={email} canManageTeam={canManageTeam} />
      </div>
    </header>
  );
}

// The mobile menu: surfaces the primary destinations and (when the user belongs
// to more than one org) team switching, both of which are hidden from the bar
// below md. Reuses the shared paper-sheet primitive.
function MobileNavSheet({
  pathname,
  orgs,
  activeOrgId,
}: {
  pathname: string | null;
  orgs: UserOrg[];
  activeOrgId: string | null;
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

          {orgs.length > 1 && (
            <>
              <div className="my-1 h-px bg-hairline-cool" />
              <div className="px-3.5 py-1 text-[11px] font-medium text-fg-3">
                {t("switchTeam")}
              </div>
              {orgs.map((org) => {
                const active = org.orgId === activeOrgId;
                return active ? (
                  <div
                    key={org.orgId}
                    aria-current="true"
                    className={`${navSheetItem} justify-between bg-card-warm text-ink`}
                  >
                    <span className="truncate">{org.name}</span>
                    <CheckIcon />
                  </div>
                ) : (
                  <form
                    key={org.orgId}
                    action={async (formData) => {
                      await switchOrg(formData);
                      close();
                    }}
                  >
                    <input type="hidden" name="orgId" value={org.orgId} />
                    <button type="submit" className={`${navSheetItem} w-full`}>
                      <span className="truncate">{org.name}</span>
                    </button>
                  </form>
                );
              })}
            </>
          )}
        </>
      )}
    </NavMenuSheet>
  );
}

// Shared pill styling for the team display, so the static and interactive forms
// look identical.
const teamPillBase =
  "flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card py-2 pl-2 pr-3.5 text-sm font-medium text-ink";

function TeamPillContent({
  name,
  fixedWidth = true,
}: {
  name: string | null;
  /** The switcher pins the name to a fixed width (`w-[150px]`) so the pill
   *  doesn't resize as the active team changes. The static single-org pill
   *  never changes, so it sizes to content instead — but still caps at the same
   *  width (`max-w-[150px]`) so a short name centers without a dead gap while a
   *  long one still truncates rather than overflowing into the nav. */
  fixedWidth?: boolean;
}) {
  const t = useTranslations("AppShell");
  return (
    <>
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-fg-on-accent">
        {initials(name)}
      </span>
      <span className={`${fixedWidth ? "w-[150px]" : "max-w-[150px]"} truncate`}>
        {name ?? t("noTeam")}
      </span>
    </>
  );
}

// The active-org switcher replaces Clerk's org picker (#52). With a single org
// (or none) there's nothing to switch to, so it's a static pill; with several it
// becomes a popover that posts `switchOrg` for the chosen org. Open/outside-click/
// Escape/focus behavior mirrors AccountMenu below.
function OrgSwitcher({
  orgs,
  activeOrgId,
}: {
  orgs: UserOrg[];
  activeOrgId: string | null;
}) {
  const t = useTranslations("AppShell");
  const [open, setOpen] = useState(false);
  // Optimistic active org: reflects the selected team instantly while switchOrg
  // round-trips, and auto-reverts to `activeOrgId` if the action fails. Updated
  // inside the form action (a transition), as useOptimistic requires.
  const [optimisticActiveId, setOptimisticActiveId] = useOptimistic(activeOrgId);
  const [lastActiveId, setLastActiveId] = useState(optimisticActiveId);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const active =
    orgs.find((o) => o.orgId === optimisticActiveId) ?? orgs[0] ?? null;

  // Close the popover as soon as the active org changes. We deliberately *don't*
  // close in the submit button's onClick: setOpen(false) there unmounts the form
  // before React can dispatch the `switchOrg` server action, so the switch
  // silently no-ops. Keying off the optimistic value instead closes it instantly
  // on selection (React's recommended adjust-state-during-render pattern).
  if (lastActiveId !== optimisticActiveId) {
    setLastActiveId(optimisticActiveId);
    setOpen(false);
  }

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
    popoverRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // One org or none: nothing to switch to.
  if (orgs.length <= 1) {
    return (
      <div className={teamPillBase}>
        <TeamPillContent name={active?.name ?? null} fixedWidth={false} />
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("switchTeam")}
        className={`${teamPillBase} transition-colors hover:bg-card-warm`}
      >
        <TeamPillContent name={active?.name ?? null} />
        <ChevronDown />
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="menu"
          className="absolute left-0 top-12 z-10 flex w-60 flex-col rounded-2xl border border-hairline-cool bg-card p-1.5 shadow-card"
        >
          <div className="px-3 py-2 text-[11px] text-fg-3">{t("switchTeam")}</div>
          {orgs.map((org) => {
            const isActive = org.orgId === active?.orgId;
            return isActive ? (
              <div
                key={org.orgId}
                role="menuitem"
                aria-current="true"
                className="flex items-center justify-between gap-2 rounded-lg bg-card-warm px-3 py-2 text-[13px] font-medium text-ink"
              >
                <span className="truncate">{org.name}</span>
                <CheckIcon />
              </div>
            ) : (
              <form
                key={org.orgId}
                action={async (formData) => {
                  // Inside the form action (a transition): reflect the pick
                  // immediately, then let switchOrg persist + revalidate. If it
                  // throws, the optimistic value reverts to the real active org.
                  setOptimisticActiveId(org.orgId);
                  await switchOrg(formData);
                }}
              >
                <input type="hidden" name="orgId" value={org.orgId} />
                <button
                  type="submit"
                  role="menuitem"
                  className="w-full truncate rounded-lg px-3 py-2 text-left text-[13px] text-fg-2 transition-colors hover:bg-card-warm hover:text-ink"
                >
                  {org.name}
                </button>
              </form>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChevronDown() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-fg-4"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-ink"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
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

// The account menu replaces Clerk's <UserButton/>: an avatar that toggles a small
// disclosure popover with the signed-in email, a link to account management, and
// sign-out. It's a plain popover (not an ARIA `menu`) — the sign-out control is a
// <form>-wrapped button, which can't be a valid `menuitem`, and Tab already walks
// the two items. Focus moves into the popover on open and back to the trigger on
// Escape.
function AccountMenu({
  email,
  canManageTeam,
}: {
  email: string | null;
  canManageTeam: boolean;
}) {
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

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t("account")}
        title={t("account")}
        className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline-cool bg-card text-[11px] font-bold text-ink transition-colors hover:bg-card-warm"
      >
        {initials(email)}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-12 z-10 flex w-60 flex-col rounded-2xl border border-hairline-cool bg-card p-1.5 shadow-card"
        >
          <div className="px-3 py-2">
            <div className="text-[11px] text-fg-3">{t("signedInAs")}</div>
            <div className="truncate text-[13px] font-medium text-ink">
              {email ?? t("yourAccount")}
            </div>
          </div>
          <div className="my-1 h-px bg-hairline-cool" />
          <ThemeToggle />
          <div className="my-1 h-px bg-hairline-cool" />
          <Link
            href="/settings/account"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2 text-left text-[13px] text-fg-2 transition-colors hover:bg-card-warm hover:text-ink"
          >
            {t("manageAccount")}
          </Link>
          <Link
            href="/settings/connections"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2 text-left text-[13px] text-fg-2 transition-colors hover:bg-card-warm hover:text-ink"
          >
            {t("connections")}
          </Link>
          {canManageTeam && (
            <>
              <Link
                href="/settings/team"
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2 text-left text-[13px] text-fg-2 transition-colors hover:bg-card-warm hover:text-ink"
              >
                {t("teamSettings")}
              </Link>
              <Link
                href="/settings/billing"
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2 text-left text-[13px] text-fg-2 transition-colors hover:bg-card-warm hover:text-ink"
              >
                {t("billing")}
              </Link>
            </>
          )}
          <SignOutButton className="w-full rounded-lg px-3 py-2 text-left text-[13px] text-fg-2 transition-colors hover:bg-card-warm hover:text-ink" />
        </div>
      )}
    </div>
  );
}
