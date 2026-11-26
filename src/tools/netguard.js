// Outbound guard for every agent web tool: public internet only.
// Agents browsing the web must not be able to reach this stack's own services (ollama, the
// browser's CDP port, the Docker socket proxy), the host's LAN, or cloud metadata
// (169.254.169.254). Every hop is checked, redirects included, after DNS resolution.
// WEB_ALLOW_PRIVATE=true turns the guard off (local development, offline tests).
import dns from "node:dns/promises";
import net from "node:net";

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v)) {             // ::ffff:7f00:1 form
      const [h, l] = v.slice(7).split(":").map(x => parseInt(x, 16));
      return isPrivateIp(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`);
    }
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || /^64:ff9b:/.test(v);
  }
  return true;
}

export async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error("invalid url"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error(`unsupported protocol ${u.protocol}`);
  if (u.username || u.password) throw new Error("credentials in URLs are not allowed");
  if (process.env.WEB_ALLOW_PRIVATE === "true") return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error(`${host} is a private address`);
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    if (!host.includes(".")) throw new Error(`${host} is a private address`);   // compose service names: ollama, browser...
    try { addrs = (await dns.lookup(host, { all: true })).map(a => a.address); } catch { throw new Error(`cannot resolve ${host}`); }
  }
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error(`${host} resolves to a private address`);
  return u;
}

// fetch with the guard on every hop (max 5 redirects)
export async function guardedFetch(raw, init = {}) {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= 5; hop++) {
    const res = await fetch(url, { ...init, redirect: "manual", signal: init.signal || AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location"), url));
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && init.method === "POST")) init = { ...init, method: "GET", body: undefined };
      continue;
    }
    return { res, url: url.toString() };
  }
  throw new Error("too many redirects");
}
