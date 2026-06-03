"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { SignOutButton } from "./sign-out-button";
import { initials } from "@/lib/initials";
import { BellIcon } from "./icons";

// Center-menu sections. Flip `ready` to true (or drop it) once the page
// exists; the active-state logic below already handles every item the same way.
const NAV_ITEMS: { label: string; href: string; ready?: boolean }[] = [
  { label: "Dashboard", href: "/dashboard", ready: true },
  { label: "Rubrics", href: "/rubrics", ready: true },
  { label: "Schedules", href: "/schedules", ready: true },
];

// Shared center-menu item styling. Active = ink pill; inactive lifts on hover.
const navItemBase =
  "rounded-full px-4 py-[7px] text-[13px] font-medium transition-colors";
const navItemActive = "bg-ink text-white";
const navItemInactive = "text-zinc-700 hover:text-ink";

// Match the item's own route — exact, or a nested path under it (so /rubrics
// stays active on /rubrics/123 but not on /rubrics-archive).
function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavBarClient({
  orgName,
  email,
}: {
  orgName: string | null;
  email: string | null;
}) {
  const pathname = usePathname();

  return (
    <header className="shrink-0 flex items-center gap-3 px-6 py-4">
      {/* Logo pill */}
      <Link
        href="/"
        title="Home"
        className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-white px-[18px] py-[9px] text-sm font-semibold text-ink tracking-[-0.01em] transition-colors hover:bg-card-warm"
      >
        <Image src="/logo-mark.svg" width={20} height={20} alt="" priority />
        <span>Baseline</span>
      </Link>

      {/* Team display — the user's single org (switching arrives in #52). */}
      <div className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-white py-2 pl-2 pr-3.5 text-sm font-medium text-ink">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-ink">
          {initials(orgName)}
        </span>
        <span className="max-w-[180px] truncate">{orgName ?? "No team"}</span>
      </div>

      {/* Center menu */}
      <nav className="flex flex-1 items-center justify-center gap-0.5 rounded-full border border-hairline-cool bg-white p-[5px]">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          const className = `${navItemBase} ${active ? navItemActive : navItemInactive}`;
          // Dummy until the page exists — render a no-op button, not a dead link.
          return item.ready ? (
            <Link
              key={item.label}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={className}
            >
              {item.label}
            </Link>
          ) : (
            <button key={item.label} type="button" className={className}>
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Right cluster */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          title="Notifications"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline-cool bg-white text-ink transition-colors hover:bg-card-warm"
        >
          <BellIcon size={16} />
        </button>
        <AccountMenu email={email} />
      </div>
    </header>
  );
}

// The account menu replaces Clerk's <UserButton/>: an avatar that toggles a small
// disclosure popover with the signed-in email, a link to account management, and
// sign-out. It's a plain popover (not an ARIA `menu`) — the sign-out control is a
// <form>-wrapped button, which can't be a valid `menuitem`, and Tab already walks
// the two items. Focus moves into the popover on open and back to the trigger on
// Escape.
function AccountMenu({ email }: { email: string | null }) {
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
        aria-label="Account"
        title="Account"
        className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline-cool bg-white text-[11px] font-bold text-ink transition-colors hover:bg-card-warm"
      >
        {initials(email)}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-12 z-10 flex w-60 flex-col rounded-2xl border border-hairline-cool bg-white p-1.5 shadow-card"
        >
          <div className="px-3 py-2">
            <div className="text-[11px] text-zinc-500">Signed in as</div>
            <div className="truncate text-[13px] font-medium text-ink">
              {email ?? "your account"}
            </div>
          </div>
          <div className="my-1 h-px bg-hairline-cool" />
          <Link
            href="/settings/account"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2 text-left text-[13px] text-zinc-700 transition-colors hover:bg-card-warm hover:text-ink"
          >
            Manage account
          </Link>
          <SignOutButton className="w-full rounded-lg px-3 py-2 text-left text-[13px] text-zinc-700 transition-colors hover:bg-card-warm hover:text-ink" />
        </div>
      )}
    </div>
  );
}
