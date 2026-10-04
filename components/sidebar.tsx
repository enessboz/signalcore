import Link from "next/link";

const sections = [
  ["Overview", "/"],
  ["Command", "/command"],
  ["Team Room", "/team"],
  ["Global Brain", "/brain"],
  ["Projects", "/projects"],
  ["Agents", "/agents"],
  ["Opportunities", "/opportunities"],
  ["Outputs", "/outputs"],
  ["Approvals", "/approvals"],
  ["System Readiness", "/readiness"],
  ["Issues & Regressions", "/issues"],
  ["Sales", "/sales"],
  ["Automations", "/automations"],
  ["Settings", "/settings"],
] as const;

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brandMark">S</span>
        <div>
          <strong>SignalCore</strong>
          <small>Evidence → Action</small>
        </div>
      </div>
      <nav>
        {sections.map(([label, href]) => (
          <Link key={href} href={href} className="navItem">
            {label}
          </Link>
        ))}
      </nav>
      <div className="sidebarFoot">
        <span className="statusDot" /> Foundation connected
      </div>
    </aside>
  );
}
