// Research tools so agents can study the outside world for their own upgrades:
//   web.search    a search bar: SearXNG (SEARXNG_URL, JSON) when configured, else DuckDuckGo's HTML endpoint
//   web.scrape    a page as structured data: title, description, headings, readable text, links, keyword hits
//   github.search repositories, code, or issues on GitHub (GITHUB_TOKEN optional; needed for code search)
//   github.read   a repo's overview, README, a file, a directory listing, or its latest releases
// All outbound traffic goes through netguard: public internet only, every redirect re-checked.
import { guardedFetch } from "./netguard.js";

const UA = "GrokBot/1.0 (+research)";
const MAX_BODY = 2_000_000;

async function readCapped(res, max = MAX_BODY) {
  const reader = res.body?.getReader?.();
  if (!reader) return "";
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { chunks.push(value.slice(0, value.length - (size - max))); try { await reader.cancel(); } catch {} break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8");
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/" };
export const decode = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (ENT[e] !== undefined) return ENT[e];
  if (/^#x/i.test(e)) { const n = parseInt(e.slice(2), 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  if (/^#/.test(e)) { const n = Number(e.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return m;
});
const strip = s => decode(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

export function parseHtml(html, baseUrl) {
  const body = String(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const title = strip((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const description = decode((body.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i) ||
    body.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i) || [])[1] || "").trim();
  const headings = [...body.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(m => `${"#".repeat(+m[1])} ${strip(m[2])}`).filter(h => h.length > 2).slice(0, 40);
  const links = [];
  const seen = new Set();
  for (const m of body.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href; try { href = new URL(decode(m[1]), baseUrl).toString(); } catch { continue; }
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href); links.push({ text: strip(m[2]).slice(0, 120), url: href });
    if (links.length >= 60) break;
  }
  const text = strip(body.replace(/<\/(p|div|li|h\d|tr|br|section|article)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n"));
  return { title, description, headings, text, links };
}

export function parseDuckDuckGo(html) {
  const out = [];
  const blocks = String(html).split(/<div[^>]+class="[^"]*\bresult\b/).slice(1);
  for (const b of blocks) {
    const a = b.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decode(a[1]);
    const ud = url.match(/[?&]uddg=([^&]+)/);
    if (ud) { try { url = decodeURIComponent(ud[1]); } catch {} }
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;     // skip ads
    const sn = b.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/);
    out.push({ title: strip(a[2]), url, snippet: sn ? strip(sn[1]) : "" });
  }
  return out;
}

export function parseBing(html) {
  const out = [];
  for (const b of String(html).split(/<li class="b_algo"/).slice(1)) {
    const a = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decode(a[1]);
    const enc = url.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
    if (enc) { try { url = Buffer.from(enc[1], "base64url").toString("utf8"); } catch {} }
    if (!/^https?:\/\//.test(url) || /^https?:\/\/(www\.)?bing\.com\//.test(url)) continue;
    const sn = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: strip(a[2]), url, snippet: sn ? strip(sn[1]) : "" });
  }
  return out;
}

const clampInt = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };

export const webSearchTool = {
  name: "web.search",
  description: "Search the web like a search bar. Returns titles, URLs and snippets; follow up with web.scrape on the best results.",
  parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  async run({ query, limit = 8 } = {}) {
    const q = typeof query === "string" ? query.trim().slice(0, 400) : "";
    if (!q) return { error: "query required" };
    const n = clampInt(limit, 1, 20, 8);
    try {
      if (process.env.SEARXNG_URL) {
        const u = new URL("/search", process.env.SEARXNG_URL); u.searchParams.set("q", q); u.searchParams.set("format", "json");
        const { res } = await guardedFetch(u, { headers: { "user-agent": UA, accept: "application/json" } });
        if (!res.ok) return { error: `search engine answered ${res.status}` };
        const j = JSON.parse(await readCapped(res));
        return { engine: "searxng", query: q, results: (j.results || []).slice(0, n).map(r => ({ title: String(r.title || ""), url: String(r.url || ""), snippet: String(r.content || "") })) };
      }
      // Keyless engines in order; a datacenter IP is often refused by one and served by the next.
      const engines = [
        { name: "duckduckgo", url: process.env.SEARCH_URL || "https://html.duckduckgo.com/html/", param: "q", parse: parseDuckDuckGo },
        { name: "bing", url: process.env.SEARCH_URL_BING || "https://www.bing.com/search", param: "q", parse: parseBing }
      ];
      const refused = [];
      for (const e of engines) {
        try {
          const u = new URL(e.url); u.searchParams.set(e.param, q);
          const { res } = await guardedFetch(u, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) " + UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" } });
          const html = await readCapped(res);
          const results = e.parse(html).slice(0, n);
          if (results.length) return { engine: e.name, query: q, results };
          if (res.status === 200 && !/anomaly|captcha|challenge|unusual traffic/i.test(html)) return { engine: e.name, query: q, results: [] };
          refused.push(`${e.name} ${res.status}`);
        } catch (err) { refused.push(`${e.name}: ${err.message}`); }
      }
      return { error: `every search engine refused this request (${refused.join("; ")}); set SEARXNG_URL to a SearXNG instance or use the browser tool` };
    } catch (e) { return { error: e.message }; }
  }
};

export const webScrapeTool = {
  name: "web.scrape",
  description: "Scrape a web page into structured data: title, description, headings, readable text, links, and sentences matching 'find'.",
  parameters: { type: "object", properties: { url: { type: "string" }, find: { type: "string" }, maxChars: { type: "number" } }, required: ["url"] },
  async run({ url, find, maxChars = 12_000 } = {}) {
    try {
      const { res, url: final } = await guardedFetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" } });
      const type = res.headers.get("content-type") || "";
      if (type && !/text\/|html|xml|json/i.test(type)) return { status: res.status, url: final, error: `not a text page (${type})` };
      const raw = await readCapped(res);
      const page = /html|xml/i.test(type) || /<html|<body|<title/i.test(raw.slice(0, 2000)) ? parseHtml(raw, final) : { title: "", description: "", headings: [], text: raw, links: [] };
      const cap = clampInt(maxChars, 500, 50_000, 12_000);
      let matches;
      if (typeof find === "string" && find.trim()) {
        const k = find.trim().toLowerCase().slice(0, 200);
        matches = page.text.split(/(?<=[.!?])\s+|\n+/).filter(s => s.toLowerCase().includes(k)).slice(0, 20).map(s => s.slice(0, 400));
      }
      return { status: res.status, url: final, title: page.title, description: page.description, headings: page.headings,
        text: page.text.slice(0, cap), truncated: page.text.length > cap, links: page.links.slice(0, 40), ...(matches ? { matches } : {}) };
    } catch (e) { return { error: e.message }; }
  }
};

async function gh(path, params = {}) {
  const base = process.env.GITHUB_API || "https://api.github.com";
  const u = new URL(path, base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  const headers = { "user-agent": UA, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const { res } = await guardedFetch(u, { headers });
  const text = await readCapped(res);
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = body?.message || String(body).slice(0, 200);
    const limited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
    throw new Error(limited ? "GitHub rate limit reached; set GITHUB_TOKEN for a higher limit" : `GitHub ${res.status}: ${msg}`);
  }
  return body;
}
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const cleanPath = p => String(p || "").replace(/^\/+/, "").split("/").filter(s => s && s !== "." && s !== "..").map(encodeURIComponent).join("/");

export const githubSearchTool = {
  name: "github.search",
  description: "Search GitHub for repositories, code, or issues to study how others built something. type: repositories | code | issues.",
  parameters: { type: "object", properties: { query: { type: "string" }, type: { type: "string", enum: ["repositories", "code", "issues"] }, limit: { type: "number" } }, required: ["query"] },
  async run({ query, type = "repositories", limit = 8 } = {}) {
    const q = typeof query === "string" ? query.trim().slice(0, 256) : "";
    if (!q) return { error: "query required" };
    if (!["repositories", "code", "issues"].includes(type)) return { error: "type must be repositories, code, or issues" };
    if (type === "code" && !process.env.GITHUB_TOKEN) return { error: "GitHub code search needs GITHUB_TOKEN; search repositories instead" };
    try {
      const j = await gh(`/search/${type}`, { q, per_page: clampInt(limit, 1, 20, 8) });
      const items = (j.items || []).map(i => type === "repositories"
        ? { repo: i.full_name, description: i.description, stars: i.stargazers_count, language: i.language, updated: i.pushed_at, url: i.html_url }
        : type === "code" ? { repo: i.repository?.full_name, path: i.path, url: i.html_url }
        : { title: i.title, state: i.state, repo: (i.repository_url || "").split("/repos/")[1], comments: i.comments, url: i.html_url });
      return { type, query: q, total: j.total_count, items };
    } catch (e) { return { error: e.message }; }
  }
};

export const githubReadTool = {
  name: "github.read",
  description: "Read a GitHub repo: what=overview | readme | file (path) | dir (path) | releases.",
  parameters: { type: "object", properties: { repo: { type: "string" }, what: { type: "string", enum: ["overview", "readme", "file", "dir", "releases"] }, path: { type: "string" }, ref: { type: "string" } }, required: ["repo"] },
  async run({ repo, what = "overview", path = "", ref } = {}) {
    if (typeof repo !== "string" || !REPO.test(repo.trim())) return { error: "repo must look like owner/name" };
    repo = repo.trim();
    if (ref !== undefined && !/^[\w./-]{1,200}$/.test(String(ref))) return { error: "bad ref" };
    try {
      if (what === "overview") {
        const r = await gh(`/repos/${repo}`);
        return { repo: r.full_name, description: r.description, stars: r.stargazers_count, forks: r.forks_count, language: r.language,
          topics: r.topics, license: r.license?.spdx_id, defaultBranch: r.default_branch, updated: r.pushed_at, url: r.html_url };
      }
      if (what === "releases") return { releases: (await gh(`/repos/${repo}/releases`, { per_page: 5 })).map(r => ({ tag: r.tag_name, name: r.name, date: r.published_at, notes: String(r.body || "").slice(0, 1500) })) };
      if (what === "readme" || what === "file") {
        const p = what === "readme" ? "readme" : `contents/${cleanPath(path)}`;
        if (what === "file" && !cleanPath(path)) return { error: "path required" };
        const f = await gh(`/repos/${repo}/${p}`, { ref });
        if (Array.isArray(f)) return { error: "that path is a directory; use what=dir" };
        if (f.encoding !== "base64") return { error: `cannot read ${f.type || "this"} content` };
        const content = Buffer.from(f.content || "", "base64").toString("utf8");
        return { path: f.path, size: f.size, content: content.slice(0, 40_000), truncated: content.length > 40_000 };
      }
      if (what === "dir") {
        const d = await gh(`/repos/${repo}/contents/${cleanPath(path)}`, { ref });
        if (!Array.isArray(d)) return { error: "that path is a file; use what=file" };
        return { entries: d.slice(0, 300).map(e => ({ name: e.name, type: e.type, size: e.size })) };
      }
      return { error: "what must be overview, readme, file, dir, or releases" };
    } catch (e) { return { error: e.message }; }
  }
};

export const researchTools = [webSearchTool, webScrapeTool, githubSearchTool, githubReadTool];
