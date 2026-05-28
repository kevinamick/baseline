"use client";

import { useOrganization, useOrganizationList, UserButton } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";

export function NavBar() {
  const router = useRouter();
  const { organization, membership } = useOrganization();
  const { userMemberships, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
    <header className="shrink-0 h-12 flex items-center px-4 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
      {/* Wordmark */}
      <span className="text-xs font-semibold tracking-[0.15em] uppercase text-zinc-400 dark:text-zinc-500 select-none mr-4">
        baseline
      </span>

      <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mr-4" />

      {/* Team selector */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={!isLoaded || switching}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-sm font-medium text-zinc-800 dark:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          <span className="max-w-[180px] truncate">
            {switching ? "Switching…" : (organization?.name ?? "No team")}
          </span>
          <ChevronIcon open={open} />
        </button>

        {open && (
          <div className="absolute top-full left-0 mt-1.5 w-56 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-lg shadow-zinc-200/60 dark:shadow-black/30 overflow-hidden z-50">
            {orgs.length > 0 && (
              <div className="py-1">
                <p className="px-3 py-1.5 text-[10px] font-semibold tracking-widest uppercase text-zinc-400 dark:text-zinc-600">
                  Your teams
                </p>
                {orgs.map((mem) => {
                  const active = mem.organization.id === organization?.id;
                  return (
                    <button
                      key={mem.organization.id}
                      onClick={() => switchOrg(mem.organization.id)}
                      className={`w-full flex items-center px-3 py-2 text-sm text-left border-l-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors ${
                        active
                          ? "border-l-zinc-800 dark:border-l-zinc-200"
                          : "border-l-transparent"
                      }`}
                    >
                      <span className={`truncate ${active ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"}`}>
                        {mem.organization.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {isAdmin && (
              <>
                <div className="h-px bg-zinc-100 dark:bg-zinc-800 mx-3" />
                <div className="py-1">
                  <Link
                    href="/settings/team"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors"
                  >
                    <span className="w-4 shrink-0 flex items-center justify-center">
                      <SettingsIcon />
                    </span>
                    Team settings
                  </Link>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Right: user button */}
      <div className="ml-auto flex items-center">
        <UserButton />
      </div>
    </header>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-zinc-400 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
