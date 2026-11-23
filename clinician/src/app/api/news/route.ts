import { newsSources, parseFeed, type NewsSource } from "@/lib/news";

// Public agency news. Fixed sources only (no user input), each feed cached for 30 minutes.
export async function GET() {
  const sources: NewsSource[] = await Promise.all(
    newsSources.map(async (s) => {
      try {
        const response = await fetch(s.url, {
          next: { revalidate: 1800 },
          // Läkemedelsverket returns an empty feed unless a Swedish language is requested.
          headers: {
            "User-Agent": "GoHealth news reader",
            Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
            "Accept-Language": "sv-SE,sv;q=0.9",
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error(String(response.status));
        const items = parseFeed(await response.text(), s.home);
        return { source: s.id, name: s.name, home: s.home, ok: items.length > 0, items };
      } catch {
        return { source: s.id, name: s.name, home: s.home, ok: false, items: [] };
      }
    }),
  );
  return Response.json({ sources }, { headers: { "Cache-Control": "private, max-age=300" } });
}
