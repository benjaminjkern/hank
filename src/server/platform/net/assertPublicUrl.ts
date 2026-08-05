// SSRF pre-flight guard for outbound fetches of caller-supplied URLs.
//
// The fetch_url tool (via scrape/fetchCleanedUrl) fetches a URL that originates
// from an LLM or an end user and returns the response body into the chat.
// Without a guard, "http://169.254.169.254/…" (cloud-metadata), a raw RFC-1918
// host, or "http://localhost:6379/…" would be reachable and its body
// exfiltrated. assertPublicUrl rejects those before the request is made.
//
// It is a PRE-FLIGHT guard only: it validates the scheme and resolves the host,
// blocking loopback / private / link-local / unique-local / multicast / metadata
// targets. It does NOT re-validate redirect hops (the fetch still follows
// redirects) — a public host that 302s to an internal one, and DNS rebinding,
// are out of scope here and documented in SECURITY.md. It raises the bar against
// the direct attacks without pretending to be airtight; a hardened self-host
// should also egress-filter the network the app runs on.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(`Refusing to fetch a non-public URL: ${reason}`);
    this.name = "BlockedUrlError";
  }
}

// Names that never point anywhere public — blocked before DNS resolution, since
// resolution can succeed (or fail open) in ways that vary by host.
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → refuse
  const inRange = (base: string, bits: number) => {
    const b = ipv4ToInt(base) ?? 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // "this" network
    inRange("10.0.0.0", 8) || // private
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local (incl. 169.254.169.254 metadata)
    inRange("172.16.0.0", 12) || // private
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.168.0.0", 16) || // private
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved / broadcast
  );
}

// Pull the embedded IPv4 out of an IPv4-mapped (`::ffff:a.b.c.d`, or its
// URL-normalized hex form `::ffff:7f00:1`) or NAT64 (`64:ff9b::a.b.c.d`)
// address. The WHATWG URL parser rewrites `[::ffff:127.0.0.1]` to hex, so
// matching only the dotted form was a real loopback/metadata bypass — check
// both. Returns dotted-decimal, or null when there's no embedded v4.
function extractEmbeddedV4(addr: string): string | null {
  const rest =
    addr.match(/^::ffff:(.+)$/)?.[1] ?? addr.match(/^64:ff9b::(.+)$/)?.[1];
  if (!rest) return null;
  if (rest.includes(".")) return rest; // already dotted a.b.c.d
  const [hi, lo = "0"] = rest.split(":"); // two hex hextets → 32 bits
  const v4 = (((parseInt(hi, 16) || 0) << 16) | (parseInt(lo, 16) || 0)) >>> 0;
  return [24, 16, 8, 0].map((s) => (v4 >>> s) & 0xff).join(".");
}

function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  const embedded = extractEmbeddedV4(addr);
  if (embedded) return isBlockedIpv4(embedded); // mapped / NAT64 → its v4
  const h = parseInt(addr.split(":")[0] || "0", 16);
  if (Number.isNaN(h)) return true; // leading "::" of an unusual form → refuse
  if ((h & 0xfe00) === 0xfc00) return true; // fc00::/7  unique-local
  if ((h & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h & 0xff00) === 0xff00) return true; // ff00::/8  multicast
  return false;
}

function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIpv4(ip);
  if (v === 6) return isBlockedIpv6(ip);
  return true; // not an IP → refuse
}

// Throws BlockedUrlError if `rawUrl` is not a public http(s) endpoint. Resolves
// the host and checks EVERY answer, so a name resolving to a mix of public and
// private addresses is refused rather than raced.
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError("unparseable URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new BlockedUrlError(`scheme ${url.protocol} not allowed`);

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))
  )
    throw new BlockedUrlError(`host ${host} is internal`);

  if (isIP(host)) {
    if (isBlockedIp(host))
      throw new BlockedUrlError(`address ${host} is not public`);
    return;
  }

  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`could not resolve ${host}`);
  }
  if (addrs.length === 0)
    throw new BlockedUrlError(`${host} resolved to nothing`);
  for (const { address } of addrs)
    if (isBlockedIp(address))
      throw new BlockedUrlError(`${host} resolves to non-public ${address}`);
}
