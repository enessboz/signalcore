import { createHash } from "node:crypto";
import { assertPublicUrl } from "@/lib/crawl/http-crawler";

export type RobotsRule = {
  directive: "allow" | "disallow";
  pattern: string;
};

export type RobotsPolicy = {
  robotsUrl: string;
  statusCode: number | null;
  fetchStatus: "succeeded" | "missing" | "failed";
  selectedAgent: string;
  rules: RobotsRule[];
  sitemapUrls: string[];
  crawlDelayMs: number | null;
  blocksAll: boolean;
  contentHash: string | null;
  error: string | null;
};

type Group = {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs: number | null;
};

function stripComment(line: string) {
  const index = line.indexOf("#");
  return (index >= 0 ? line.slice(0, index) : line).trim();
}

function patternRegex(pattern: string) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + (anchored ? "$" : ""), "i");
}

function ruleSpecificity(pattern: string) {
  return pattern.replace(/\*/g, "").replace(/\$$/, "").length;
}

function selectGroup(groups: Group[], userAgent: string) {
  const normalized = userAgent.toLowerCase();
  const exact = groups.filter((group) =>
    group.agents.some((agent) => {
      const token = agent.toLowerCase();
      return token !== "*" && normalized.includes(token);
    }),
  );

  if (exact.length) {
    const lengths = exact.flatMap((group) =>
      group.agents
        .filter(
          (agent) =>
            agent !== "*" && normalized.includes(agent.toLowerCase()),
        )
        .map((agent) => agent.length),
    );
    const longest = Math.max(...lengths);

    return exact.filter((group) =>
      group.agents.some(
        (agent) =>
          agent !== "*" &&
          normalized.includes(agent.toLowerCase()) &&
          agent.length === longest,
      ),
    );
  }

  return groups.filter((group) => group.agents.includes("*"));
}

export function parseRobots(
  text: string,
  userAgent = "SignalCoreBot",
): Omit<
  RobotsPolicy,
  "robotsUrl" | "statusCode" | "fetchStatus" | "contentHash" | "error"
> {
  const groups: Group[] = [];
  const sitemapUrls: string[] = [];
  let current: Group | null = null;
  let seenRuleInCurrent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line) {
      if (current && (current.rules.length || current.crawlDelayMs !== null)) {
        current = null;
        seenRuleInCurrent = false;
      }
      continue;
    }

    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "sitemap") {
      if (value) sitemapUrls.push(value);
      continue;
    }

    if (key === "user-agent") {
      const agent = value.toLowerCase();
      if (!agent) continue;

      if (!current || seenRuleInCurrent) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
        seenRuleInCurrent = false;
      }
      current.agents.push(agent);
      continue;
    }

    if (!current || !current.agents.length) continue;

    if (key === "allow" || key === "disallow") {
      seenRuleInCurrent = true;
      if (value) {
        current.rules.push({
          directive: key,
          pattern: value,
        });
      }
      continue;
    }

    if (key === "crawl-delay") {
      seenRuleInCurrent = true;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        current.crawlDelayMs = Math.min(Math.round(seconds * 1000), 60_000);
      }
    }
  }

  const selected = selectGroup(groups, userAgent);
  const rules = selected.flatMap((group) => group.rules);
  const delays = selected
    .map((group) => group.crawlDelayMs)
    .filter((value): value is number => value !== null);
  const crawlDelayMs = delays.length ? Math.max(...delays) : null;

  const probe: RobotsPolicy = {
    robotsUrl: "",
    statusCode: 200,
    fetchStatus: "succeeded",
    selectedAgent: selected.length
      ? selected.some((group) =>
          group.agents.some((agent) => agent !== "*"),
        )
        ? userAgent
        : "*"
      : "*",
    rules,
    sitemapUrls: Array.from(new Set(sitemapUrls)),
    crawlDelayMs,
    blocksAll: false,
    contentHash: null,
    error: null,
  };

  return {
    selectedAgent: probe.selectedAgent,
    rules,
    sitemapUrls: probe.sitemapUrls,
    crawlDelayMs,
    blocksAll: !isRobotsAllowed(probe, "/"),
  };
}

export function isRobotsAllowed(policy: RobotsPolicy, rawUrl: string) {
  if (policy.fetchStatus === "missing") return true;
  if (policy.fetchStatus === "failed") return false;
  if (!policy.rules.length) return true;

  let path = rawUrl;
  try {
    const parsed = new URL(rawUrl, "https://robots.invalid");
    path = parsed.pathname + parsed.search;
  } catch {
    // Keep supplied path.
  }

  const matches = policy.rules
    .filter((rule) => {
      try {
        return patternRegex(rule.pattern).test(path);
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      const specificity =
        ruleSpecificity(b.pattern) - ruleSpecificity(a.pattern);
      if (specificity !== 0) return specificity;
      if (a.directive === b.directive) return 0;
      return a.directive === "allow" ? -1 : 1;
    });

  if (!matches.length) return true;
  return matches[0]!.directive === "allow";
}

export async function fetchRobotsPolicy(
  origin: string,
  userAgent = "SignalCoreBot",
): Promise<RobotsPolicy> {
  const robotsUrl = new URL("/robots.txt", origin).toString();

  try {
    await assertPublicUrl(robotsUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);

    let response: Response;
    try {
      response = await fetch(robotsUrl, {
        headers: {
          "User-Agent": "SignalCoreBot/0.3 (+SEO audit; respects robots.txt)",
          Accept: "text/plain,*/*",
        },
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 500 || response.status === 429) {
      return {
        robotsUrl,
        statusCode: response.status,
        fetchStatus: "failed",
        selectedAgent: userAgent,
        rules: [],
        sitemapUrls: [],
        crawlDelayMs: null,
        blocksAll: true,
        contentHash: null,
        error:
          "robots.txt is temporarily unavailable (" +
          response.status +
          "); crawl is conservatively blocked.",
      };
    }

    if (response.status >= 400) {
      return {
        robotsUrl,
        statusCode: response.status,
        fetchStatus: "missing",
        selectedAgent: userAgent,
        rules: [],
        sitemapUrls: [],
        crawlDelayMs: null,
        blocksAll: false,
        contentHash: null,
        error: null,
      };
    }

    const text = (await response.text()).slice(0, 1_000_000);
    const parsed = parseRobots(text, userAgent);
    return {
      robotsUrl,
      statusCode: response.status,
      fetchStatus: "succeeded",
      ...parsed,
      contentHash: createHash("sha256").update(text).digest("hex"),
      error: null,
    };
  } catch (error) {
    return {
      robotsUrl,
      statusCode: null,
      fetchStatus: "failed",
      selectedAgent: userAgent,
      rules: [],
      sitemapUrls: [],
      crawlDelayMs: null,
      blocksAll: true,
      contentHash: null,
      error:
        error instanceof Error ? error.message : "robots.txt fetch failed.",
    };
  }
}
