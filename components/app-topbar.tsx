"use client";

import { usePathname } from "next/navigation";
import type { Locale } from "@/lib/i18n";
import { LanguageToggle } from "@/components/language-toggle";

type NavCopy = Record<string, string>;

const routeLabels: Array<[string, string]> = [
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
  const match = routeLabels.find(([route]) =>
    pathname === route || pathname.startsWith(route + "/"),
  );
  const current = match ? copy[match[1]] : copy.overview;

  return (
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
        <div className="globalSearch" aria-label={copy.search}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" />
          </svg>
          <span>{copy.search}</span>
          <kbd>⌘ K</kbd>
        </div>
        <LanguageToggle locale={locale} />
        <div className="topbarEnv">
          <span className="statusDot" />
          {copy.environment}
        </div>
      </div>
    </header>
  );
}
