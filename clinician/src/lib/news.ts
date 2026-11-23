/** Public news feeds shown on the clinician start page. Fetched server-side; links are limited to each agency's own site. */
export const newsSources = [
  {
    id: "fhm",
    name: "Folkhälsomyndigheten",
    url: "https://www.folkhalsomyndigheten.se/nyheter-och-press/nyhetsarkiv/?syndication=rss",
    home: "https://www.folkhalsomyndigheten.se/nyheter-och-press/nyhetsarkiv/",
  },
  {
    id: "lv",
    name: "Läkemedelsverket",
    url: "https://www.lakemedelsverket.se/api/newslist/newsrss?query=&pageTypeId=&from=&to=",
    home: "https://www.lakemedelsverket.se/sv/nyheter",
  },
  {
    id: "sos",
    name: "Socialstyrelsen",
    url: "https://www.socialstyrelsen.se/om-socialstyrelsen/pressrum/press/RssFeed/?url=https://www.socialstyrelsen.se/om-socialstyrelsen/pressrum/press/",
    home: "https://www.socialstyrelsen.se/om-socialstyrelsen/pressrum/press/",
  },
] as const;

export type NewsItem = { title: string; link: string; date: string | null };
export type NewsSource = { source: string; name: string; home: string; ok: boolean; items: NewsItem[] };

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(text: string) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return entities[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}
function tag(block: string, name: string) {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decode(m[1]) : "";
}
function link(block: string) {
  const rss = tag(block, "link");
  if (rss) return rss;
  const atom = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = atom.find((a) => !/rel="/i.test(a) || /rel="alternate"/i.test(a)) ?? atom[0];
  return pick ? decode(/href="([^"]*)"/i.exec(pick)?.[1] ?? "") : "";
}
/** Only https links on the agency's own domain; anything else falls back to its news page. */
export function safeLink(href: string, home: string) {
  try {
    const url = new URL(href);
    const site = new URL(home).hostname.replace(/^www\./, "");
    if (url.protocol === "https:" && (url.hostname === site || url.hostname.endsWith("." + site))) return url.toString();
  } catch {}
  return home;
}

/** Reads RSS 2.0 <item> or Atom <entry> elements, newest first. */
export function parseFeed(xml: string, home: string, limit = 6): NewsItem[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) ?? [];
  return blocks
    .map((b) => {
      const raw = tag(b, "pubDate") || tag(b, "updated") || tag(b, "published");
      const time = raw ? Date.parse(raw) : NaN;
      return { title: tag(b, "title"), link: safeLink(link(b), home), date: Number.isFinite(time) ? new Date(time).toISOString() : null };
    })
    .filter((i) => i.title)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, limit);
}
