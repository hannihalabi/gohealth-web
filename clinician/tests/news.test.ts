import assert from "node:assert/strict";
import test from "node:test";
import { parseFeed, safeLink } from "../src/lib/news";

const home = "https://www.folkhalsomyndigheten.se/nyheter-och-press/nyhetsarkiv/";
test("RSS items are read newest first with decoded titles", () => {
  const xml = `<rss><channel><title>Feed</title>
    <item><title>Äldre &amp; nyare</title><link>https://www.folkhalsomyndigheten.se/a/</link><pubDate>Mon, 02 Nov 2026 10:00:00 +0100</pubDate></item>
    <item><title><![CDATA[Tidig influensasäsong i år]]></title><link>https://www.folkhalsomyndigheten.se/b/</link><pubDate>Thu, 19 Nov 2026 15:58:06 +0100</pubDate></item>
  </channel></rss>`;
  const items = parseFeed(xml, home);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Tidig influensasäsong i år");
  assert.equal(items[1].title, "Äldre & nyare");
  assert.equal(items[0].date, "2026-11-19T14:58:06.000Z");
});
test("Atom entries use the alternate link and the updated date", () => {
  const lv = "https://www.lakemedelsverket.se/sv/nyheter";
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Alla nyheter</title>
    <link rel="alternate" href="https://www.lakemedelsverket.se/feed" />
    <entry><title type="text">Permanent försäljningsuppehåll för Emend (aprepitant)</title>
      <link rel="alternate" href="https://www.lakemedelsverket.se/link/c884.aspx" /><updated>2026-11-23T15:11:23Z</updated></entry></feed>`;
  const items = parseFeed(xml, lv);
  assert.equal(items.length, 1);
  assert.equal(items[0].link, "https://www.lakemedelsverket.se/link/c884.aspx");
  assert.equal(items[0].date, "2026-11-23T15:11:23.000Z");
});
test("links outside the agency's site or not https fall back to the news page", () => {
  assert.equal(safeLink("javascript:alert(1)", home), home);
  assert.equal(safeLink("https://evil.example/x", home), home);
  assert.equal(safeLink("http://www.folkhalsomyndigheten.se/x", home), home);
  assert.equal(safeLink("https://www.folkhalsomyndigheten.se/x", home), "https://www.folkhalsomyndigheten.se/x");
});
test("markup inside titles is shown as text", () => {
  const items = parseFeed(`<rss><channel><item><title>&lt;b&gt;Hej&lt;/b&gt; <i>där</i></title><link>${home}</link></item></channel></rss>`, home);
  assert.equal(items[0].title, "<b>Hej</b> där");
});
