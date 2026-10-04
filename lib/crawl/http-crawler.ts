import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type CrawledPage = {
  url: string;
  statusCode: number | null;
  responseMs: number | null;
  contentType: string | null;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robotsMeta: string | null;
  h1s: string[];
  h2s: string[];
  wordCount: number;
  internalLinkCount: number;
  externalLinkCount: number;
  imageCount: number;
  missingAltCount: number;
  structuredDataCount: number;
  contentHash: string | null;
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

  for (let redirect = 0; redirect < 5; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": "SignalCoreBot/0.1 (+SEO audit; controlled project crawl)",
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
      if (!location) return { response, url, elapsed: Date.now() - started, text: "" };
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

function tagContent(html: string, tag: string) {
  const re = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "gi");
  return Array.from(html.matchAll(re))
    .map((match) => cleanText(match[1] || ""))
    .filter(Boolean);
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

function extractLinks(html: string, base: URL) {
  const tags = html.match(/<a\b[^>]*>/gi) || [];
  const internal = new Set<string>();
  const external = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();

  for (const tag of tags) {
    const href = attr(tag, "href");
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
      if (url.hostname === base.hostname) internal.add(url.toString());
      else external.add(url.toString());
    } catch {
      // Ignore malformed hrefs.
    }
  }

  return {
    internal: [...internal],
    external: [...external],
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

function visibleWordCount(html: string) {
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  const text = cleanText(cleaned);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

export async function crawlPage(rawUrl: string, expectedOrigin: string): Promise<CrawledPage> {
  try {
    const result = await safeFetch(rawUrl);
    const finalUrl = result.url;
    const contentType = result.response.headers.get("content-type");
    const html = result.text;

    if (new URL(finalUrl).origin !== expectedOrigin) {
      return {
        url: finalUrl.toString(),
        statusCode: result.response.status,
        responseMs: result.elapsed,
        contentType,
        title: null,
        metaDescription: null,
        canonical: null,
        robotsMeta: null,
        h1s: [],
        h2s: [],
        wordCount: 0,
        internalLinkCount: 0,
        externalLinkCount: 0,
        imageCount: 0,
        missingAltCount: 0,
        structuredDataCount: 0,
        contentHash: null,
        fetchError: "Final URL left the project origin; body was not analyzed.",
        metadata: { redirected_outside_origin: true },
      };
    }

    if (!contentType?.toLowerCase().includes("text/html")) {
      return {
        url: finalUrl.toString(),
        statusCode: result.response.status,
        responseMs: result.elapsed,
        contentType,
        title: null,
        metaDescription: null,
        canonical: null,
        robotsMeta: null,
        h1s: [],
        h2s: [],
        wordCount: 0,
        internalLinkCount: 0,
        externalLinkCount: 0,
        imageCount: 0,
        missingAltCount: 0,
        structuredDataCount: 0,
        contentHash: createHash("sha256").update(html).digest("hex"),
        fetchError: null,
        metadata: { non_html: true },
      };
    }

    const title = tagContent(html, "title")[0] || null;
    const h1s = tagContent(html, "h1").slice(0, 20);
    const h2s = tagContent(html, "h2").slice(0, 50);
    const links = extractLinks(html, finalUrl);
    const images = imageStats(html);
    const structuredDataCount = (html.match(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>/gi,
    ) || []).length;

    return {
      url: finalUrl.toString(),
      statusCode: result.response.status,
      responseMs: result.elapsed,
      contentType,
      title,
      metaDescription: findMeta(html, "description"),
      canonical: findCanonical(html, finalUrl),
      robotsMeta: findMeta(html, "robots"),
      h1s,
      h2s,
      wordCount: visibleWordCount(html),
      internalLinkCount: links.internal.length,
      externalLinkCount: links.external.length,
      imageCount: images.imageCount,
      missingAltCount: images.missingAltCount,
      structuredDataCount,
      contentHash: createHash("sha256").update(html).digest("hex"),
      fetchError: null,
      metadata: {
        internal_links_sample: links.internal.slice(0, 25),
        external_links_sample: links.external.slice(0, 10),
        email_sample: links.emails.slice(0, 10),
        phone_sample: links.phones.slice(0, 10),
      },
    };
  } catch (error) {
    return {
      url: rawUrl,
      statusCode: null,
      responseMs: null,
      contentType: null,
      title: null,
      metaDescription: null,
      canonical: null,
      robotsMeta: null,
      h1s: [],
      h2s: [],
      wordCount: 0,
      internalLinkCount: 0,
      externalLinkCount: 0,
      imageCount: 0,
      missingAltCount: 0,
      structuredDataCount: 0,
      contentHash: null,
      fetchError: error instanceof Error ? error.message : "Fetch failed.",
      metadata: {},
    };
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
  return { text: result.text, status: result.response.status, finalUrl: result.url };
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

  while (sitemapQueue.length && seenSitemaps.size < 30 && discovered.size < maxUrls) {
    const sitemapUrl = sitemapQueue.shift()!;
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    try {
      const sitemap = await fetchText(sitemapUrl);
      if (sitemap.status < 200 || sitemap.status >= 400) continue;
      const locs = xmlLocs(sitemap.text);

      if (/<sitemapindex\b/i.test(sitemap.text)) {
        for (const loc of locs) {
          if (sitemapQueue.length >= 100) break;
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
  return {
    origin,
    urls: [home, ...Array.from(discovered).filter((url) => url !== home)].slice(0, maxUrls),
    sitemapCount: seenSitemaps.size,
  };
}
