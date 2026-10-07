"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Locale } from "@/lib/i18n";
import { LanguageToggle } from "@/components/language-toggle";

type NavCopy = Record<string, string>;

const routeLabels: Array<[string, string]> = [
  ["/", "overview"],
  ["/command", "command"],
  ["/team", "team"],
  ["/brain", "brain"],
  ["/projects", "projects"],
  ["/agents", "agents"],
  ["/agent-uat", "agentUat"],
  ["/opportunities", "opportunities"],
  ["/outputs", "outputs"],
  ["/approvals", "approvals"],
  ["/operations", "operations"],
  ["/readiness", "readiness"],
  ["/costs", "costs"],
  ["/issues", "issues"],
  ["/sales", "sales"],
  ["/automations", "automations"],
  ["/settings", "settings"],
];

export function AppTopbar({
  locale,
  copy,
}: {
  locale: Locale;
  copy: NavCopy;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const match = routeLabels
    .filter(([route]) => route !== "/")
    .find(([route]) => pathname === route || pathname.startsWith(route + "/"));
  const current = match ? copy[match[1]] : copy.overview;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale === "tr" ? "tr-TR" : "en-US");
    return routeLabels
      .map(([href, key]) => ({ href, label: copy[key] || key }))
      .filter((item) =>
        needle ? item.label.toLocaleLowerCase().includes(needle) : true,
      )
      .slice(0, 9);
  }, [query, copy, locale]);

  function navigate(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  return (
    <>
      <header className="appTopbar">
        <div className="mobileBrand">
          <span className="brandMark compact">S</span>
          <strong>SignalCore</strong>
        </div>
        <div className="topbarBreadcrumb">
          <span>SignalCore</span>
          <span className="breadcrumbSlash">/</span>
          <strong>{current}</strong>
        </div>
        <div className="topbarActions">
          <button
            className="globalSearch"
            type="button"
            aria-label={copy.search}
            onClick={() => setOpen(true)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.2-3.2" />
            </svg>
            <span>{copy.search}</span>
            <kbd>⌘ K</kbd>
          </button>
          <LanguageToggle locale={locale} />
          <div className="topbarEnv">
            <span className="statusDot" />
            {copy.environment}
          </div>
        </div>
      </header>

      {open ? (
        <div
          className="commandOverlay"
          role="presentation"
          onMouseDown={() => setOpen(false)}
        >
          <div
            className="commandPalette"
            role="dialog"
            aria-modal="true"
            aria-label={copy.search}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="commandInput">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.2-3.2" />
              </svg>
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={copy.search}
              />
              <kbd>ESC</kbd>
            </div>
            <div className="commandResults">
              {results.length ? (
                results.map((item) => (
                  <button
                    type="button"
                    key={item.href}
                    onClick={() => navigate(item.href)}
                  >
                    <span className="commandResultIcon">↗</span>
                    <span>{item.label}</span>
                    <small>{item.href}</small>
                  </button>
                ))
              ) : (
                <div className="commandEmpty">
                  {locale === "tr" ? "Eşleşen ekran bulunamadı." : "No matching screen found."}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
