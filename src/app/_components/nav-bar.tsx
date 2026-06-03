"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { SignOutButton } from "./sign-out-button";
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

export function NavBar() {
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

      {/* Team picker — static placeholder until organizations land (#47). */}
      <div className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-white py-2 pl-2 pr-3.5 text-sm font-medium text-zinc-500">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-ink">
          —
        </span>
        <span className="max-w-[180px] truncate">No team</span>
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
        <SignOutButton className="flex h-10 items-center rounded-full border border-hairline-cool bg-white px-4 text-sm font-medium text-ink transition-colors hover:bg-card-warm" />
      </div>
    </header>
  );
}
