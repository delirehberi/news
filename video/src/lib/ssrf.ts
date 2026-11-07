import dns from 'node:dns/promises';
import net from 'node:net';

export class SsrfError extends Error {
  public readonly url: string;
  public readonly reason: string;

  constructor(url: string, reason: string) {
    super(`SSRF guard rejected URL "${url}": ${reason}`);
    this.name = 'SsrfError';
    this.url = url;
    this.reason = reason;
  }
}

export interface LookupResult {
  address: string;
  family: number;
}

export type DnsLookupAllFn = (hostname: string) => Promise<readonly LookupResult[]>;

export const defaultDnsLookupAll: DnsLookupAllFn = async (hostname: string) => {
  return dns.lookup(hostname, { all: true, verbatim: true });
};

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
]);

/**
 * Parses a dotted-quad IPv4 address into a 4-tuple of octets `[a, b, c, d]`,
 * or returns `null` if not a valid IPv4 string.
 */
function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  if (net.isIP(ip) !== 4) {
    return null;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

/**
 * Expands an IPv6 address (including `::` shorthand and optional IPv4-mapped tail)
 * into 8 16-bit integer groups, or returns `null` if invalid.
 */
function parseIpv6Hextets(rawIp: string): number[] | null {
  // Strip IPv6 zone index if present (e.g. fe80::1%eth0)
  const zoneIdx = rawIp.indexOf('%');
  const ip = zoneIdx >= 0 ? rawIp.slice(0, zoneIdx) : rawIp;

  if (net.isIP(ip) !== 6) {
    return null;
  }

  let normalized = ip.toLowerCase();

  // Handle dotted-quad tail in IPv6 (e.g. ::ffff:127.0.0.1)
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon >= 0 && normalized.slice(lastColon + 1).includes('.')) {
    const ipv4Part = normalized.slice(lastColon + 1);
    const octets = parseIpv4Octets(ipv4Part);
    if (!octets) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = normalized.split('::');
  if (doubleColonParts.length > 2) {
    return null;
  }

  const head = doubleColonParts[0] ? doubleColonParts[0].split(':') : [];
  const tail =
    doubleColonParts.length === 2 && doubleColonParts[1]
      ? doubleColonParts[1].split(':')
      : [];

  const missing = 8 - (head.length + tail.length);
  if (
    (doubleColonParts.length === 1 && missing !== 0) ||
    (doubleColonParts.length === 2 && missing < 1)
  ) {
    return null;
  }

  const fullParts = [
    ...head,
    ...Array.from({ length: doubleColonParts.length === 2 ? missing : 0 }, () => '0'),
    ...tail,
  ];

  if (fullParts.length !== 8) {
    return null;
  }

  const hextets = fullParts.map((part) => Number.parseInt(part, 16));
  if (hextets.some((h) => !Number.isInteger(h) || h < 0 || h > 0xffff)) {
    return null;
  }

  return hextets;
}

/**
 * Checks whether an IPv4 address is loopback, private, link-local, CGNAT,
 * multicast, broadcast, unspecified, or reserved.
 */
export function isPrivateOrReservedIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) {
    return true;
  }
  const [a, b, c] = octets;

  // 0.0.0.0/8 (Current network / unspecified)
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC 1918 private)
  if (a === 10) return true;
  // 100.64.0.0/10 (RFC 6598 Shared Address Space / CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local / cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC 1918 private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.88.99.0/24 (6to4 Relay Anycast)
  if (a === 192 && b === 88 && c === 99) return true;
  // 192.168.0.0/16 (RFC 1918 private)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast) and 240.0.0.0/4 (Reserved / Broadcast)
  if (a >= 224) return true;

  return false;
}

/**
 * Checks whether an IPv6 address is loopback, unspecified, link-local, unique-local,
 * multicast, documentation, or wraps a private/reserved IPv4 address.
 */
export function isPrivateOrReservedIpv6(ip: string): boolean {
  const hextets = parseIpv6Hextets(ip);
  if (!hextets) {
    return true;
  }

  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;

  // ::/128 (Unspecified)
  if (hextets.every((h) => h === 0)) {
    return true;
  }

  // ::1/128 (Loopback)
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) {
    return true;
  }

  // IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96)
  if (
    h0 === 0 &&
    h1 === 0 &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0 &&
    (h5 === 0xffff || h5 === 0)
  ) {
    const a = (h6 >> 8) & 0xff;
    const b = h6 & 0xff;
    const c = (h7 >> 8) & 0xff;
    const d = h7 & 0xff;
    return isPrivateOrReservedIpv4(`${a}.${b}.${c}.${d}`);
  }

  // IPv4-translated (::ffff:0:a.b.c.d / 96)
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0) {
    const a = (h6 >> 8) & 0xff;
    const b = h6 & 0xff;
    const c = (h7 >> 8) & 0xff;
    const d = h7 & 0xff;
    return isPrivateOrReservedIpv4(`${a}.${b}.${c}.${d}`);
  }

  // 64:ff9b::/96 or 64:ff9b:1::/48 (NAT64)
  if (h0 === 0x0064 && h1 === 0xff9b) {
    const a = (h6 >> 8) & 0xff;
    const b = h6 & 0xff;
    const c = (h7 >> 8) & 0xff;
    const d = h7 & 0xff;
    return isPrivateOrReservedIpv4(`${a}.${b}.${c}.${d}`);
  }

  // 2002::/16 (6to4) - embeds IPv4 in h1, h2
  if (h0 === 0x2002) {
    const a = (h1 >> 8) & 0xff;
    const b = h1 & 0xff;
    const c = (h2 >> 8) & 0xff;
    const d = h2 & 0xff;
    return isPrivateOrReservedIpv4(`${a}.${b}.${c}.${d}`);
  }

  // fc00::/7 (Unique Local Address: fc00:: - fdff::)
  if ((h0 & 0xfe00) === 0xfc00) {
    return true;
  }

  // fe80::/10 (Link-Local: fe80:: - febf::)
  if ((h0 & 0xffc0) === 0xfe80) {
    return true;
  }

  // fec0::/10 (Deprecated Site-Local)
  if ((h0 & 0xffc0) === 0xfec0) {
    return true;
  }

  // ff00::/8 (Multicast)
  if ((h0 & 0xff00) === 0xff00) {
    return true;
  }

  // 2001:db8::/32 (Documentation)
  if (h0 === 0x2001 && h1 === 0x0db8) {
    return true;
  }

  // 100::/64 (Discard-Only Address Block)
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) {
    return true;
  }

  return false;
}

/**
 * Returns `true` if `ip` is a private, loopback, link-local, multicast, or reserved
 * IPv4 or IPv6 address (or not a valid IP string).
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const trimmed = ip.trim();
  const zoneIdx = trimmed.indexOf('%');
  const cleanIp = zoneIdx >= 0 ? trimmed.slice(0, zoneIdx) : trimmed;
  const family = net.isIP(cleanIp);
  if (family === 4) {
    return isPrivateOrReservedIpv4(cleanIp);
  }
  if (family === 6) {
    return isPrivateOrReservedIpv6(cleanIp);
  }
  return true;
}

export interface AssertSafeUrlOptions {
  dnsLookup?: DnsLookupAllFn;
}

/**
 * Validates that a URL is safe to navigate/fetch against SSRF:
 * 1. Must be valid `http:` or `https:` URL with no embedded credentials.
 * 2. Hostname must not be `localhost`, `.local`, `.internal`, or an IP literal in private/loopback/link-local ranges.
 * 3. Every DNS record resolved for the hostname must be a public routable IP.
 */
export async function assertSafeHttpUrl(
  rawUrl: string,
  options: AssertSafeUrlOptions = {}
): Promise<URL> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new SsrfError(rawUrl, 'URL must not be empty');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SsrfError(rawUrl, 'Malformed URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(
      rawUrl,
      `Unsupported protocol "${parsed.protocol}" (only http: and https: are allowed)`
    );
  }

  if (parsed.username || parsed.password) {
    throw new SsrfError(rawUrl, 'Embedded URL credentials are not allowed');
  }

  const rawHostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!rawHostname) {
    throw new SsrfError(rawUrl, 'Missing hostname');
  }

  // Strip brackets around IPv6 literals in URL.hostname (e.g. "[::1]" -> "::1")
  const hostname =
    rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new SsrfError(rawUrl, `Blocked local/internal hostname "${hostname}"`);
  }

  // If the hostname is already an IP literal (or non-standard integer/octal/hex IPv4 form that URL normalized)
  const ipFamily = net.isIP(hostname);
  if (ipFamily !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new SsrfError(
        rawUrl,
        `Rejected private, loopback, or reserved IP literal "${hostname}"`
      );
    }
    return parsed;
  }

  const lookupFn = options.dnsLookup ?? defaultDnsLookupAll;
  let records: readonly LookupResult[];
  try {
    records = await lookupFn(hostname);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SsrfError(rawUrl, `DNS resolution failed for "${hostname}": ${message}`);
  }

  if (!records || records.length === 0) {
    throw new SsrfError(rawUrl, `DNS resolution returned no addresses for "${hostname}"`);
  }

  for (const record of records) {
    if (isPrivateOrReservedIp(record.address)) {
      throw new SsrfError(
        rawUrl,
        `Hostname "${hostname}" resolved to disallowed private/loopback/reserved IP "${record.address}"`
      );
    }
  }

  return parsed;
}
