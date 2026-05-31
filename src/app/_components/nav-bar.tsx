"use client";

import { useOrganization, useOrganizationList, UserButton } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { BellIcon, CheckIcon, ChevronDownIcon, SettingsIcon } from "./icons";
import { useLocale } from "@/lib/i18n/context";

function initials(name: string | undefined): string {
  if (!name) return "—";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "—";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

type NavItem = { labelKey: keyof ReturnType<typeof useLocale>["t"]["nav"]; href: string; ready?: boolean };
const NAV_ITEMS: NavItem[] = [
  { labelKey: "dashboard", href: "/dashboard", ready: true },
  { labelKey: "rubrics", href: "/rubrics", ready: true },
  { labelKey: "schedules", href: "/schedules" },
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
  const router = useRouter();
  const pathname = usePathname();
  const { organization, membership } = useOrganization();
  const { userMemberships, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { t } = useLocale();

  const orgs = userMemberships?.data ?? [];
  const isAdmin = membership?.role === "org:admin";

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  async function switchOrg(orgId: string) {
    if (orgId === organization?.id || !setActive) return;
    setSwitching(true);
    setOpen(false);
    try {
      await setActive({ organization: orgId });
      router.refresh();
    } finally {
      setSwitching(false);
    }
  }

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

      {/* Team picker */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={!isLoaded || switching}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-white py-2 pl-2 pr-3.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm disabled:opacity-50"
        >
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-ink">
            {initials(organization?.name)}
          </span>
          <span className="max-w-[180px] truncate">
            {switching ? t.nav.switching : (organization?.name ?? t.nav.noTeam)}
          </span>
          <ChevronDownIcon size={14} className="text-zinc-500" />
        </button>

        {open && (
          <div
            role="menu"
            className="absolute left-0 top-[calc(100%+6px)] z-30 flex min-w-[240px] flex-col gap-0.5 rounded-xl border border-hairline-cool bg-white p-1.5 shadow-lg form-reveal"
          >
            {orgs.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                  {t.nav.switchTeam}
                </span>
                {orgs.map((mem) => {
                  const active = mem.organization.id === organization?.id;
                  return (
                    <button
                      key={mem.organization.id}
                      onClick={() => switchOrg(mem.organization.id)}
                      className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium text-ink transition-colors hover:bg-card-warm ${
                        active ? "bg-accent-soft" : ""
                      }`}
                    >
                      <span
                        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                          active ? "bg-ink text-accent" : "bg-accent text-ink"
                        }`}
                      >
                        {initials(mem.organization.name)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {mem.organization.name}
                      </span>
                      {active && <CheckIcon size={14} className="text-zinc-600" />}
                    </button>
                  );
                })}
              </div>
            )}

            {isAdmin && (
              <>
                <div className="mx-1 my-1 h-px bg-hairline" />
                <Link
                  href="/settings/team"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-card-warm"
                >
                  <span className="inline-flex w-6 shrink-0 justify-center text-zinc-500">
                    <SettingsIcon size={14} />
                  </span>
                  {t.nav.teamSettings}
                </Link>
              </>
            )}
          </div>
        )}
      </div>

      {/* Center menu */}
      <nav className="flex flex-1 items-center justify-center gap-0.5 rounded-full border border-hairline-cool bg-white p-[5px]">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          const className = `${navItemBase} ${active ? navItemActive : navItemInactive}`;
          const label = t.nav[item.labelKey] as string;
          // Dummy until the page exists — render a no-op button, not a dead link.
          return item.ready ? (
            <Link
              key={item.labelKey}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={className}
            >
              {label}
            </Link>
          ) : (
            <button key={item.labelKey} type="button" className={className}>
              {label}
            </button>
          );
        })}
      </nav>

      {/* Right cluster */}
      <div className="flex items-center gap-2">        
        <button
          type="button"
          title={t.nav.notifications}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline-cool bg-white text-ink transition-colors hover:bg-card-warm"
        >
          <BellIcon size={16} />
        </button>
        <UserButton
          appearance={{
            elements: { avatarBox: "w-10 h-10" },
          }}
        />
      </div>
    </header>
  );
}
