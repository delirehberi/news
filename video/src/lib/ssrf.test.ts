import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeHttpUrl,
  isPrivateOrReservedIp,
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  SsrfError,
} from './ssrf.ts';

describe('src/lib/ssrf.ts', () => {
  describe('isPrivateOrReservedIpv4', () => {
    it('identifies loopback, private RFC1918, link-local, CGNAT, multicast, and reserved IPv4 addresses', () => {
      const blocked = [
        '0.0.0.0',
        '0.10.20.30',
        '10.0.0.1',
        '10.255.255.254',
        '100.64.0.1',
        '100.127.255.254',
        '127.0.0.1',
        '127.0.53.53',
        '169.254.0.1',
        '169.254.169.254', // AWS/Cloud metadata endpoint
        '172.16.0.1',
        '172.31.255.255',
        '192.0.0.1',
        '192.0.2.1',
        '192.88.99.1',
        '192.168.0.1',
        '192.168.100.200',
        '198.18.0.1',
        '198.19.255.255',
        '198.51.100.1',
        '203.0.113.1',
        '224.0.0.1',
        '240.0.0.1',
        '255.255.255.255',
      ];

      for (const ip of blocked) {
        expect(isPrivateOrReservedIpv4(ip), `Expected ${ip} to be blocked`).toBe(true);
        expect(isPrivateOrReservedIp(ip), `Expected ${ip} to be blocked`).toBe(true);
      }
    });

    it('allows public routable IPv4 addresses', () => {
      const allowed = [
        '1.1.1.1',
        '8.8.8.8',
        '93.184.216.34',
        '100.63.255.255',
        '100.128.0.1',
        '172.15.255.255',
        '172.32.0.1',
        '192.167.255.255',
        '192.169.0.1',
      ];

      for (const ip of allowed) {
        expect(isPrivateOrReservedIpv4(ip), `Expected ${ip} to be allowed`).toBe(false);
        expect(isPrivateOrReservedIp(ip), `Expected ${ip} to be allowed`).toBe(false);
      }
    });
  });

  describe('isPrivateOrReservedIpv6', () => {
    it('identifies loopback, unspecified, link-local, unique-local, multicast, and IPv4-mapped private IPv6 addresses', () => {
      const blocked = [
        '::',
        '::1',
        '0:0:0:0:0:0:0:1',
        'fe80::1',
        'fe80::1%eth0',
        'febf::ffff',
        'fc00::1',
        'fd12:3456:789a::1',
        'ff02::1',
        '2001:db8::1',
        '::ffff:127.0.0.1',
        '::ffff:10.0.0.1',
        '::ffff:169.254.169.254',
        '::ffff:192.168.1.1',
        '64:ff9b::127.0.0.1',
        '2002:7f00:0001::', // 6to4 embedding 127.0.0.1
      ];

      for (const ip of blocked) {
        expect(isPrivateOrReservedIpv6(ip), `Expected ${ip} to be blocked`).toBe(true);
        expect(isPrivateOrReservedIp(ip), `Expected ${ip} to be blocked`).toBe(true);
      }
    });

    it('allows public global unicast IPv6 addresses and IPv4-mapped public addresses', () => {
      const allowed = [
        '2606:4700:4700::1111',
        '2001:4860:4860::8888',
        '::ffff:93.184.216.34',
      ];

      for (const ip of allowed) {
        expect(isPrivateOrReservedIpv6(ip), `Expected ${ip} to be allowed`).toBe(false);
        expect(isPrivateOrReservedIp(ip), `Expected ${ip} to be allowed`).toBe(false);
      }
    });
  });

  describe('assertSafeHttpUrl', () => {
    it('rejects non-http(s) protocols, credentials, localhost, and internal domains', async () => {
      const dnsLookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

      await expect(assertSafeHttpUrl('file:///etc/passwd', { dnsLookup })).rejects.toThrow(
        SsrfError
      );
      await expect(assertSafeHttpUrl('ftp://example.com/file', { dnsLookup })).rejects.toThrow(
        /Unsupported protocol/
      );
      await expect(assertSafeHttpUrl('javascript:alert(1)', { dnsLookup })).rejects.toThrow(
        /Unsupported protocol/
      );
      await expect(
        assertSafeHttpUrl('https://user:pass@example.com/article', { dnsLookup })
      ).rejects.toThrow(/credentials/);
      await expect(assertSafeHttpUrl('http://localhost:8080/admin', { dnsLookup })).rejects.toThrow(
        /Blocked local\/internal hostname/
      );
      await expect(
        assertSafeHttpUrl('http://sub.localhost/admin', { dnsLookup })
      ).rejects.toThrow(/Blocked local\/internal hostname/);
      await expect(
        assertSafeHttpUrl('http://metadata.google.internal/computeMetadata/v1/', { dnsLookup })
      ).rejects.toThrow(/Blocked local\/internal hostname/);
      await expect(
        assertSafeHttpUrl('http://printer.local/status', { dnsLookup })
      ).rejects.toThrow(/Blocked local\/internal hostname/);

      expect(dnsLookup).not.toHaveBeenCalled();
    });

    it('rejects direct private/loopback IPv4 and IPv6 literals without DNS lookup', async () => {
      const dnsLookup = vi.fn();

      await expect(assertSafeHttpUrl('http://127.0.0.1:3000/', { dnsLookup })).rejects.toThrow(
        /Rejected private, loopback, or reserved IP literal/
      );
      await expect(assertSafeHttpUrl('http://169.254.169.254/latest/meta-data', { dnsLookup })).rejects.toThrow(
        /Rejected private, loopback, or reserved IP literal/
      );
      await expect(assertSafeHttpUrl('http://[::1]:8080/', { dnsLookup })).rejects.toThrow(
        /Rejected private, loopback, or reserved IP literal/
      );
      // Integer / hex IPv4 forms are normalized by URL parser to 127.0.0.1 and caught
      await expect(assertSafeHttpUrl('http://2130706433/', { dnsLookup })).rejects.toThrow(
        /Rejected private, loopback, or reserved IP literal/
      );
      await expect(assertSafeHttpUrl('http://0x7f000001/', { dnsLookup })).rejects.toThrow(
        /Rejected private, loopback, or reserved IP literal/
      );

      expect(dnsLookup).not.toHaveBeenCalled();
    });

    it('rejects hostnames that resolve via DNS to any private, loopback, or link-local IP (DNS rebinding guard)', async () => {
      // Single private IPv4 record
      await expect(
        assertSafeHttpUrl('https://evil.example.com/story', {
          dnsLookup: async () => [{ address: '10.0.1.25', family: 4 }],
        })
      ).rejects.toThrow(/resolved to disallowed private\/loopback\/reserved IP "10\.0\.1\.25"/);

      // Mixed public + loopback records (must reject if ANY record is private)
      await expect(
        assertSafeHttpUrl('https://dual.example.com/story', {
          dnsLookup: async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '::1', family: 6 },
          ],
        })
      ).rejects.toThrow(/resolved to disallowed private\/loopback\/reserved IP "::1"/);

      // Link-local IPv6
      await expect(
        assertSafeHttpUrl('https://linklocal.example.com/story', {
          dnsLookup: async () => [{ address: 'fe80::1ff:fe23:4567:890a', family: 6 }],
        })
      ).rejects.toThrow(/resolved to disallowed private/);
    });

    it('resolves and returns parsed URL when all DNS records are public routable IPs', async () => {
      const dnsLookup = vi.fn().mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ]);

      const parsed = await assertSafeHttpUrl('https://example.com/articles/rust-kernel', {
        dnsLookup,
      });

      expect(parsed.href).toBe('https://example.com/articles/rust-kernel');
      expect(dnsLookup).toHaveBeenCalledWith('example.com');
    });
  });
});
