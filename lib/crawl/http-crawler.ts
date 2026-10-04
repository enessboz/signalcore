import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type CrawledLink = {
  url: string;
  anchorText: string | null;
  rel: string | null;
  nofollow: boolean;
};

export type HreflangReference = {
  hreflang: string;
  url: string;
};

export type RedirectHop = {
  url: string;
  status: number;
  location: string | null;
};

export type CrawledPage = {
  requestedUrl: string;
  url: string;
  redirectChain: RedirectHop[];
  statusCode: number | null;
  responseMs: number | null;
  contentType: string | null;
  contentLengthBytes: number | null;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  htmlLang: string | null;
  metaRefresh: string | null;
  hreflangs: HreflangReference[];
  h1s: string[];
  h2s: string[];
  h3s: string[];
  h4s: string[];
  h5s: string[];
  h6s: string[];
  wordCount: number;
  internalLinks: CrawledLink[];
  externalLinks: CrawledLink[];
  internalLinkCount: number;
  externalLinkCount: number;
  imageCount: number;
  missingAltCount: number;
  structuredDataCount: number;
  invalidStructuredDataCount: number;
  contentHash: string | null;
  indexable: boolean | null;
  indexabilityReason: string | null;
  fetchError: string | null;
  metadata: Record<string, unknown>;
};

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^0\./,
];

function isPrivateIp(address: string) {
  if (address === "::1" || address === "::" || address.startsWith("fe80:")) return true;
  if (/^(fc|fd)/i.test(address)) return true;

  if (isIP(address) === 4) {
    if (PRIVATE_V4.some((pattern) => pattern.test(address))) return true;
    const match = address.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
    const carrier = address.match(/^100\.(\d+)\./);
    if (carrier && Number(carrier[1]) >= 64 && Number(carrier[1]) <= 127) return true;
  }

  return false;
}

export async function assertPublicUrl(raw: string) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http/https URLs are allowed.");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Private/local hosts are not crawlable.");
  }

  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Private IPs are not crawlable.");
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("Host could not be resolved.");
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("Host resolves to a private IP and cannot be crawled.");
  }

  return url;
}

async function safeFetch(
  raw: string,
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    accept?: string;
  } = {},
) {
  let url = await assertPublicUrl(raw);
  const started = Date.now();
  const redirectChain: RedirectHop[] = [];

  for (let redirect = 0; redirect < 6; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": "SignalCoreBot/0.2 (+SEO audit; controlled project crawl)",
          Accept: options.accept || "text/html,application/xhtml+xml",
        },
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      redirectChain.push({
        url: url.toString(),
        status: response.status,
        location,
      });
      if (!location) {
        return {
          response,
          url,
          elapsed: Date.now() - started,
          text: "",
          bytes: 0,
          redirectChain,
        };
      }
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }

    const maxBytes = options.maxBytes || 2_000_000;
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxBytes) {
      throw new Error("Response exceeds crawl size limit (" + contentLength + " bytes).");
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error("Response exceeds crawl size limit (" + buffer.byteLength + " bytes).");
    }

    return {
      response,
      url,
      elapsed: Date.now() - started,
      text: new TextDecoder().decode(buffer),
      bytes: buffer.byteLength,
      redirectChain,
    };
  }

  throw new Error("Too many redirects.");
}

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

function cleanText(value: string) {
  return decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function tagContent(html: string, tag: string, max = 100) {
  const re = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "gi");
  return Array.from(html.matchAll(re))
    .map((match) => cleanText(match[1] || ""))
    .filter(Boolean)
    .slice(0, max);
}

function attr(tag: string, name: string) {
  const escaped = name.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
  const match = tag.match(
    new RegExp("\\b" + escaped + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"),
  );
  return decodeEntities(match?.[1] || match?.[2] || match?.[3] || "").trim() || null;
}

function findMeta(html: string, key: string) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const name = (attr(tag, "name") || attr(tag, "property") || "").toLowerCase();
    if (name === key.toLowerCase()) return attr(tag, "content");
  }
  return null;
}

function findMetaRefresh(html: string) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const httpEquiv = (attr(tag, "http-equiv") || "").toLowerCase();
    if (httpEquiv === "refresh") return attr(tag, "content");
  }
  return null;
}

function findHtmlLang(html: string) {
  const tag = html.match(/<html\b[^>]*>/i)?.[0];
  return tag ? attr(tag, "lang") : null;
}

function findCanonical(html: string, base: URL) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = (attr(tag, "rel") || "").toLowerCase().split(/\s+/);
    if (!rel.includes("canonical")) continue;
    const href = attr(tag, "href");
    if (!href) return null;
    try {
      return new URL(href, base).toString();
    } catch {
      return href;
    }
  }
  return null;
}

function findHreflangs(html: string, base: URL) {
  const out: HreflangReference[] = [];
  const seen = new Set<string>();
  const tags = html.match(/<link\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const rel = (attr(tag, "rel") || "").toLowerCase().split(/\s+/);
    const hreflang = attr(tag, "hreflang");
    const href = attr(tag, "href");
    if (!rel.includes("alternate") || !hreflang || !href) continue;

    try {
      const url = new URL(href, base).toString();
      const key = hreflang.toLowerCase() + "|" + url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ hreflang, url });
    } catch {
      // Ignore malformed hreflang URLs.
    }
  }

  return out.slice(0, 100);
}

function extractLinks(html: string, base: URL) {
  const internal: CrawledLink[] = [];
  const external: CrawledLink[] = [];
  const emails = new Set<string>();
  const phones = new Set<string>();
  const seenInternal = new Set<string>();
  const seenExternal = new Set<string>();
  const anchors = Array.from(
    html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi),
  ).slice(0, 4000);

  for (const match of anchors) {
    const openTag = "<a " + (match[1] || "") + ">";
    const href = attr(openTag, "href");
    if (!href || href.startsWith("#")) continue;

    if (href.toLowerCase().startsWith("mailto:")) {
      const email = href.slice(7).split("?")[0]?.trim().toLowerCase();
      if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) emails.add(email);
      continue;
    }

    if (href.toLowerCase().startsWith("tel:")) {
      const phone = href.slice(4).split("?")[0]?.trim();
      if (phone) phones.add(phone);
      continue;
    }

    try {
      const url = new URL(href, base);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      url.hash = "";
      const rel = attr(openTag, "rel");
      const relTokens = (rel || "").toLowerCase().split(/\s+/).filter(Boolean);
      const link: CrawledLink = {
        url: url.toString(),
        anchorText: cleanText(match[2] || "").slice(0, 500) || null,
        rel,
        nofollow: relTokens.includes("nofollow"),
      };

      const dedupeKey =
        link.url + "|" + (link.anchorText || "") + "|" + (link.rel || "");
      if (url.origin === base.origin) {
        if (!seenInternal.has(dedupeKey) && internal.length < 1500) {
          seenInternal.add(dedupeKey);
          internal.push(link);
        }
      } else if (!seenExternal.has(dedupeKey) && external.length < 500) {
        seenExternal.add(dedupeKey);
        external.push(link);
      }
    } catch {
      // Ignore malformed hrefs.
    }
  }

  return {
    internal,
    external,
    emails: [...emails],
    phones: [...phones],
  };
}

function imageStats(html: string) {
  const tags = html.match(/<img\b[^>]*>/gi) || [];
  let missingAlt = 0;
  for (const tag of tags) {
    const alt = attr(tag, "alt");
    if (alt === null || alt.trim() === "") missingAlt += 1;
  }
  return { imageCount: tags.length, missingAltCount: missingAlt };
}

function structuredDataStats(html: string) {
  const scripts = Array.from(
    html.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  );
  let invalid = 0;

  for (const script of scripts) {
    const raw = (script[1] || "").trim();
    if (!raw) {
      invalid += 1;
      continue;
    }
    try {
      JSON.parse(raw);
    } catch {
      invalid += 1;
    }
  }

  return {
    count: scripts.length,
    invalid,
  };
}

function visibleWordCount(html: string) {
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  const text = cleanText(cleaned);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function normalizeComparableUrl(raw: string | null) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) {
      url.port = "";
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return raw.trim();
  }
}

function indexability(input: {
  statusCode: number;
  contentType: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  canonical: string | null;
  finalUrl: string;
}) {
  if (input.statusCode < 200 || input.statusCode >= 300) {
    return { indexable: false, reason: "http_status_" + input.statusCode };
  }

  if (!input.contentType?.toLowerCase().includes("text/html")) {
    return { indexable: false, reason: "non_html" };
  }

  const robots = [input.robotsMeta, input.xRobotsTag]
    .filter(Boolean)
    .join(",")
    .toLowerCase();

  if (robots.includes("noindex")) {
    return { indexable: false, reason: "noindex" };
  }

  const canonical = normalizeComparableUrl(input.canonical);
  const finalUrl = normalizeComparableUrl(input.finalUrl);
  if (canonical && finalUrl && canonical !== finalUrl) {
    return { indexable: false, reason: "canonicalized" };
  }

  return { indexable: true, reason: "indexable_candidate" };
}

function emptyPage(rawUrl: string, error: string): CrawledPage {
  return {
    requestedUrl: rawUrl,
    url: rawUrl,
    redirectChain: [],
    statusCode: null,
    responseMs: null,
    contentType: null,
    contentLengthBytes: null,
    title: null,
    metaDescription: null,
    canonical: null,
    robotsMeta: null,
    xRobotsTag: null,
    htmlLang: null,
    metaRefresh: null,
    hreflangs: [],
    h1s: [],
    h2s: [],
    h3s: [],
    h4s: [],
    h5s: [],
    h6s: [],
    wordCount: 0,
    internalLinks: [],
    externalLinks: [],
    internalLinkCount: 0,
    externalLinkCount: 0,
    imageCount: 0,
    missingAltCount: 0,
    structuredDataCount: 0,
    invalidStructuredDataCount: 0,
    contentHash: null,
    indexable: false,
    indexabilityReason: "fetch_error",
    fetchError: error,
    metadata: {},
  };
}

export async function crawlPage(rawUrl: string, expectedOrigin: string): Promise<CrawledPage> {
  try {
    const result = await safeFetch(rawUrl);
    const finalUrl = result.url;
    const contentType = result.response.headers.get("content-type");
    const xRobotsTag = result.response.headers.get("x-robots-tag");
    const html = result.text;

    if (new URL(finalUrl).origin !== expectedOrigin) {
      return {
        ...emptyPage(rawUrl, "Final URL left the project origin; body was not analyzed."),
        url: finalUrl.toString(),
        redirectChain: result.redirectChain,
        statusCode: result.response.status,
        responseMs: result.elapsed,
        contentType,
        contentLengthBytes: result.bytes,
        xRobotsTag,
        indexabilityReason: "redirected_outside_origin",
        metadata: { redirected_outside_origin: true },
      };
    }

    if (!contentType?.toLowerCase().includes("text/html")) {
      const indexState = indexability({
        statusCode: result.response.status,
        contentType,
        robotsMeta: null,
        xRobotsTag,
        canonical: null,
        finalUrl: finalUrl.toString(),
      });

      return {
        ...emptyPage(rawUrl, ""),
        url: finalUrl.toString(),
        redirectChain: result.redirectChain,
        statusCode: result.response.status,
        responseMs: result.elapsed,
        contentType,
        contentLengthBytes: result.bytes,
        xRobotsTag,
        contentHash: createHash("sha256").update(html).digest("hex"),
        indexable: indexState.indexable,
        indexabilityReason: indexState.reason,
        fetchError: null,
        metadata: { non_html: true },
      };
    }

    const title = tagContent(html, "title", 1)[0] || null;
    const h1s = tagContent(html, "h1", 50);
    const h2s = tagContent(html, "h2", 100);
    const h3s = tagContent(html, "h3", 150);
    const h4s = tagContent(html, "h4", 150);
    const h5s = tagContent(html, "h5", 150);
    const h6s = tagContent(html, "h6", 150);
    const links = extractLinks(html, finalUrl);
    const images = imageStats(html);
    const structured = structuredDataStats(html);
    const robotsMeta = findMeta(html, "robots");
    const canonical = findCanonical(html, finalUrl);
    const hreflangs = findHreflangs(html, finalUrl);
    const indexState = indexability({
      statusCode: result.response.status,
      contentType,
      robotsMeta,
      xRobotsTag,
      canonical,
      finalUrl: finalUrl.toString(),
    });

    return {
      requestedUrl: rawUrl,
      url: finalUrl.toString(),
      redirectChain: result.redirectChain,
      statusCode: result.response.status,
      responseMs: result.elapsed,
      contentType,
      contentLengthBytes: result.bytes,
      title,
      metaDescription: findMeta(html, "description"),
      canonical,
      robotsMeta,
      xRobotsTag,
      htmlLang: findHtmlLang(html),
      metaRefresh: findMetaRefresh(html),
      hreflangs,
      h1s,
      h2s,
      h3s,
      h4s,
      h5s,
      h6s,
      wordCount: visibleWordCount(html),
      internalLinks: links.internal,
      externalLinks: links.external,
      internalLinkCount: links.internal.length,
      externalLinkCount: links.external.length,
      imageCount: images.imageCount,
      missingAltCount: images.missingAltCount,
      structuredDataCount: structured.count,
      invalidStructuredDataCount: structured.invalid,
      contentHash: createHash("sha256").update(html).digest("hex"),
      indexable: indexState.indexable,
      indexabilityReason: indexState.reason,
      fetchError: null,
      metadata: {
        internal_links_sample: links.internal.slice(0, 25).map((link) => link.url),
        external_links_sample: links.external.slice(0, 10).map((link) => link.url),
        email_sample: links.emails.slice(0, 10),
        phone_sample: links.phones.slice(0, 10),
        redirect_count: result.redirectChain.length,
        canonical_matches_final:
          normalizeComparableUrl(canonical) === normalizeComparableUrl(finalUrl.toString()),
      },
    };
  } catch (error) {
    return emptyPage(
      rawUrl,
      error instanceof Error ? error.message : "Fetch failed.",
    );
  }
}

function xmlLocs(xml: string) {
  return Array.from(xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi))
    .map((match) => decodeEntities(match[1] || "").trim())
    .filter(Boolean);
}

async function fetchText(url: string, maxBytes = 5_000_000) {
  const result = await safeFetch(url, {
    maxBytes,
    timeoutMs: 12000,
    accept: "application/xml,text/xml,text/plain,*/*",
  });
  return {
    text: result.text,
    status: result.response.status,
    finalUrl: result.url,
  };
}

export async function discoverSitemapUrls(seed: string, maxUrls: number) {
  const seedUrl = await assertPublicUrl(seed);
  const origin = seedUrl.origin;
  const sitemapCandidates = new Set<string>();

  try {
    const robots = await fetchText(new URL("/robots.txt", origin).toString(), 1_000_000);
    for (const match of robots.text.matchAll(/^\s*Sitemap:\s*(.+)\s*$/gim)) {
      const candidate = match[1]?.trim();
      if (candidate) sitemapCandidates.add(candidate);
    }
  } catch {
    // robots.txt is optional.
  }

  sitemapCandidates.add(new URL("/sitemap.xml", origin).toString());
  sitemapCandidates.add(new URL("/sitemap_index.xml", origin).toString());

  const discovered = new Set<string>();
  const sitemapQueue = [...sitemapCandidates];
  const seenSitemaps = new Set<string>();

  while (sitemapQueue.length && seenSitemaps.size < 50 && discovered.size < maxUrls) {
    const sitemapUrl = sitemapQueue.shift()!;
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    try {
      const sitemap = await fetchText(sitemapUrl);
      if (sitemap.status < 200 || sitemap.status >= 400) continue;
      const locs = xmlLocs(sitemap.text);

      if (/<sitemapindex\b/i.test(sitemap.text)) {
        for (const loc of locs) {
          if (sitemapQueue.length >= 200) break;
          try {
            const parsed = new URL(loc);
            if (parsed.origin === origin) sitemapQueue.push(parsed.toString());
          } catch {
            // Ignore invalid sitemap entries.
          }
        }
      } else {
        for (const loc of locs) {
          if (discovered.size >= maxUrls) break;
          try {
            const parsed = new URL(loc);
            if (parsed.origin !== origin) continue;
            parsed.hash = "";
            discovered.add(parsed.toString());
          } catch {
            // Ignore invalid URLs.
          }
        }
      }
    } catch {
      // Keep trying other sitemap candidates.
    }
  }

  const home = new URL("/", origin).toString();
  const sitemapUrls = Array.from(discovered).slice(0, maxUrls);
  return {
    origin,
    urls: [home, ...sitemapUrls.filter((url) => url !== home)].slice(0, maxUrls),
    sitemapUrls,
    sitemapSources: [...seenSitemaps],
    sitemapCount: seenSitemaps.size,
  };
}
