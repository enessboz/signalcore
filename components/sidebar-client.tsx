"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LanguageToggle } from "@/components/language-toggle";
import type { Locale } from "@/lib/i18n";

type NavCopy = Record<string, string>;

type Item = {
  key: string;
  href: string;
  icon: string;
};

const groups: Array<{ label: string; items: Item[] }> = [
  {
    label: "workspace",
    items: [
      { key: "overview", href: "/", icon: "grid" },
      { key: "command", href: "/command", icon: "spark" },
      { key: "team", href: "/team", icon: "users" },
      { key: "projects", href: "/projects", icon: "folder" },
    ],
  },
  {
    label: "intelligence",
    items: [
      { key: "brain", href: "/brain", icon: "brain" },
      { key: "opportunities", href: "/opportunities", icon: "trend" },
      { key: "issues", href: "/issues", icon: "alert" },
      { key: "agents", href: "/agents", icon: "bot" },
      { key: "agentUat", href: "/agent-uat", icon: "check" },
    ],
  },
  {
    label: "operationsGroup",
    items: [
      { key: "outputs", href: "/outputs", icon: "file" },
      { key: "approvals", href: "/approvals", icon: "shield" },
      { key: "operations", href: "/operations", icon: "pulse" },
      { key: "automations", href: "/automations", icon: "bolt" },
      { key: "sales", href: "/sales", icon: "briefcase" },
    ],
  },
  {
    label: "system",
    items: [
      { key: "readiness", href: "/readiness", icon: "gauge" },
      { key: "costs", href: "/costs", icon: "coins" },
      { key: "outputProfiles", href: "/output-profiles", icon: "sliders" },
      { key: "settings", href: "/settings", icon: "settings" },
    ],
  },
];

function Icon({ name }: { name: string }) {
  const common = {
    width: 17,
    height: 17,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    spark: <><path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
    folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/>,
    brain: <><path d="M9.5 4.5A3 3 0 0 0 4 6v.5A3.5 3.5 0 0 0 5.5 13H6"/><path d="M14.5 4.5A3 3 0 0 1 20 6v.5a3.5 3.5 0 0 1-1.5 6.5H18"/><path d="M12 3v18"/><path d="M8 8h4"/><path d="M12 16h4"/><path d="M7 13a3 3 0 0 0 5 2.2"/><path d="M17 13a3 3 0 0 1-5 2.2"/></>,
    trend: <><path d="M3 17 9 11l4 4 8-8"/><path d="M15 7h6v6"/></>,
    alert: <><path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></>,
    bot: <><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M9 11h.01M15 11h.01M8 15h8"/><path d="M12 3v4"/></>,
    check: <><path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="9"/></>,
    file: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/><path d="M9 13h6M9 17h6"/></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>,
    pulse: <><path d="M3 12h4l2-5 4 10 2-5h6"/></>,
    bolt: <path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z"/>,
    briefcase: <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"/></>,
    gauge: <><path d="M4 14a8 8 0 1 1 16 0"/><path d="m12 14 4-4"/><path d="M6 18h12"/></>,
    coins: <><ellipse cx="8" cy="6" rx="5" ry="3"/><path d="M3 6v4c0 1.7 2.2 3 5 3s5-1.3 5-3V6"/><path d="M13 9.5c.9-.3 1.9-.5 3-.5 2.8 0 5 1.3 5 3s-2.2 3-5 3c-1.1 0-2.1-.2-3-.5"/><path d="M11 17c.9.6 2.3 1 4 1 2.8 0 5-1.3 5-3v-3"/></>,
    sliders: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3h4a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  };
  return <svg {...common}>{paths[name] || paths.grid}</svg>;
}

export function SidebarClient({
  locale,
  copy,
}: {
  locale: Locale;
  copy: NavCopy;
}) {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brandMark">
          <span className="brandPulse" />
          S
        </span>
        <div className="brandCopy">
          <strong>SignalCore</strong>
          <small>{copy.evidenceAction}</small>
        </div>
      </div>

      <nav className="sidebarNav">
        {groups.map((group) => (
          <div className="navGroup" key={group.label}>
            <span className="navGroupLabel">{copy[group.label]}</span>
            <div className="navGroupItems">
              {group.items.map((item) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname === item.href ||
                      pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={"navItem" + (active ? " active" : "")}
                  >
                    <span className="navIcon"><Icon name={item.icon} /></span>
                    <span>{copy[item.key]}</span>
                    {active ? <span className="navActiveDot" /> : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebarFooter">
        <div className="sidebarStatus">
          <span className="statusDot" />
          <div>
            <strong>{copy.environment}</strong>
            <small>{copy.connected}</small>
          </div>
        </div>
        <LanguageToggle locale={locale} />
      </div>
    </aside>
  );
}
