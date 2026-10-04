export type AgentUatScenario = {
  key: string;
  name: string;
  expectedAgentKey: string;
  mode: "direct" | "router";
  request: string;
};

const specialistCases: Record<string, Array<[string, string]>> = {
  seo_lead: [
    ["Prioritize current SEO work", "Review the current project evidence and prioritize the three SEO actions that deserve attention first. Do not invent evidence."],
    ["Synthesize cross-source risks", "Synthesize the strongest current SEO risks across available first-party, crawl and rank evidence. Separate facts from recommendations."],
    ["Quarter planning", "Based only on current project evidence, propose a concise next-quarter SEO focus. State data limitations explicitly."],
    ["Resolve conflicting signals", "Look for conflicting SEO signals in the available evidence and explain which should be trusted first and why."],
    ["Executive SEO decision", "Give an executive SEO decision brief: what matters now, what can wait, and what evidence supports that prioritization."],
  ],
  data_analyst: [
    ["First-party trend review", "Review available GSC and GA4 evidence for meaningful performance changes. Do not infer missing data."],
    ["Landing page performance", "Analyze available landing-page performance evidence and identify supported gains, losses or data gaps."],
    ["Measurement mismatch", "Check whether available search visibility and analytics behavior tell a consistent story. Highlight only evidence-backed mismatches."],
    ["Data quality before analysis", "Assess whether first-party data coverage is sufficient for trend analysis. If not, explain exactly what is missing."],
    ["Performance anomaly", "Identify the most material supported analytics anomaly in the current project and explain its business relevance."],
  ],
  technical_seo: [
    ["Latest crawl issue", "Review the latest crawl evidence and identify the most important supported technical SEO issue. Do not invent crawl facts."],
    ["Indexability review", "Review current technical evidence for indexability, canonical, robots or HTTP-status conflicts and prioritize only supported issues."],
    ["Internal linking review", "Assess current crawl evidence for internal-link architecture problems such as broken targets, redirects, depth or orphan candidates."],
    ["Regression review", "Check current technical evidence for regressions versus prior crawl state. If no regression evidence exists, say so."],
    ["International technical review", "Review available hreflang, canonical and language evidence for international SEO problems without assuming pages not in the crawl."],
  ],
  research_content: [
    ["Search demand opportunity", "Use available query and ranking evidence to identify one defensible content opportunity. Do not invent keyword volume."],
    ["Content gap hypothesis", "Form a content-gap hypothesis from current first-party evidence and clearly label what still needs external research."],
    ["Existing page expansion", "Identify an existing page that may deserve expansion based on available query/page evidence, if the evidence supports one."],
    ["Intent alignment", "Review available query-to-page evidence for search-intent or page-ownership mismatch and recommend a research next step."],
    ["Content prioritization", "Prioritize current evidence-backed content opportunities by likely SEO relevance without fabricating traffic forecasts."],
  ],
  reporting_output: [
    ["Executive summary", "Prepare a concise executive summary from the current approved project findings and evidence. Preserve uncertainty."],
    ["Client-ready issue brief", "Turn the strongest current supported SEO issue into a client-ready issue brief with evidence and recommended next action."],
    ["Presentation outline", "Create a short presentation outline from current evidence: situation, evidence, impact, recommendation, next step."],
    ["Monthly recap", "Prepare a factual monthly-style recap from currently available evidence and explicitly mention any data coverage limitations."],
    ["Decision memo", "Create a decision memo that distinguishes observed evidence, interpretation and recommended action."],
  ],
  developer: [
    ["Repository-safe fix plan", "Review available repository context and current technical evidence, then propose a code-level fix plan without claiming to change code."],
    ["SEO implementation risk", "Identify a supported implementation risk in the available repository/project context and explain how to validate it safely."],
    ["Technical task specification", "Turn the strongest supported technical issue into a developer-ready implementation task with acceptance criteria."],
    ["Regression debugging plan", "If current evidence suggests a technical regression, propose a debugging sequence using repository and crawl evidence only."],
    ["Change proposal approval", "Propose a safe code or configuration change for a supported issue. Any GitHub or production write must remain a proposed action requiring approval."],
  ],
  sales_lead: [
    ["Prospect evidence review", "Review available prospect/project evidence and summarize the strongest defensible sales angle without inventing company facts."],
    ["Qualification rationale", "Assess whether the current evidence supports prioritizing this prospect. Separate known evidence from unknowns."],
    ["Audit-to-value narrative", "Turn current public audit evidence into a concise value narrative without making unsupported ROI claims."],
    ["Sales deck storyline", "Propose a sales deck storyline using only current prospect evidence and clearly mark missing proof points."],
    ["Outreach safety", "Draft the internal strategy for a potential outreach angle, but do not send outreach and route any external contact action through approval."],
  ],
};

export const AGENT_UAT_SCENARIOS: AgentUatScenario[] = [
  ...Object.entries(specialistCases).flatMap(([agentKey, cases]) =>
    cases.map(([name, request], index) => ({
      key: agentKey + "-" + String(index + 1),
      name,
      expectedAgentKey: agentKey,
      mode: "direct" as const,
      request,
    })),
  ),
  {
    key: "router-technical",
    name: "Route technical SEO",
    expectedAgentKey: "technical_seo",
    mode: "router",
    request: "Review the latest crawl and tell me the most important technical SEO problem.",
  },
  {
    key: "router-analytics",
    name: "Route analytics",
    expectedAgentKey: "data_analyst",
    mode: "router",
    request: "Analyze our GSC and GA4 performance changes and tell me what moved.",
  },
  {
    key: "router-content",
    name: "Route content strategy",
    expectedAgentKey: "research_content",
    mode: "router",
    request: "Find an evidence-backed content opportunity from our search query data.",
  },
  {
    key: "router-reporting",
    name: "Route reporting",
    expectedAgentKey: "reporting_output",
    mode: "router",
    request: "Prepare a client-ready executive report from our current findings.",
  },
  {
    key: "router-developer",
    name: "Route developer",
    expectedAgentKey: "developer",
    mode: "router",
    request: "Review the repository context and propose the implementation plan for our technical SEO issue.",
  },
  {
    key: "router-sales",
    name: "Route sales",
    expectedAgentKey: "sales_lead",
    mode: "router",
    request: "Review this prospect evidence and propose the strongest sales angle without sending outreach.",
  },
  {
    key: "router-seo-lead",
    name: "Route SEO leadership",
    expectedAgentKey: "seo_lead",
    mode: "router",
    request: "Prioritize our current SEO findings and tell me what we should work on first.",
  },
];

export function getAgentUatScenario(key: string) {
  return AGENT_UAT_SCENARIOS.find((scenario) => scenario.key === key) || null;
}
