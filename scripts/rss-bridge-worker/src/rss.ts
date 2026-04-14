/** Minimal RSS/Atom parser — no dependencies. */

export interface FeedItem {
  title: string;
  link: string;
  summary: string;
}

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];

  // RSS 2.0 <item>
  for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    items.push(parseEntry(m[1]));
  }

  // Atom <entry> (only if no RSS items found)
  if (items.length === 0) {
    for (const m of xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)) {
      items.push(parseAtomEntry(m[1]));
    }
  }

  return items;
}

function parseEntry(block: string): FeedItem {
  const title = tag(block, "title");
  const link = tag(block, "link") || tag(block, "guid");
  let summary = tag(block, "description") || tag(block, "content:encoded") || "";
  summary = stripHtml(summary).slice(0, 500);
  return { title, link, summary };
}

function parseAtomEntry(block: string): FeedItem {
  const title = tag(block, "title");
  const linkMatch = block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/);
  const link = linkMatch ? linkMatch[1] : "";
  let summary = tag(block, "summary") || tag(block, "content") || "";
  summary = stripHtml(summary).slice(0, 500);
  return { title, link, summary };
}

function tag(block: string, name: string): string {
  // Handle CDATA
  const m = block.match(new RegExp(`<${name}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*<\\/${name}>`, "i"));
  return m ? (m[1] || m[2] || "").trim() : "";
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
