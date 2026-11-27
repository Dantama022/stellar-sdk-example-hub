import { readFileSync } from 'fs';
import { join } from 'path';

import {
  auditStellarToml,
  buildStellarTomlUrl,
  fetchStellarToml,
  normalizeDomain,
  parseStellarToml,
  validateStellarToml,
  type FetchLike,
  type Finding,
} from '../examples/sep-1/stellar-toml-validator';

const FIXTURES = join(__dirname, '../examples/sep-1/fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const validToml = fixture('valid-stellar.toml');
const invalidFieldsToml = fixture('invalid-fields-stellar.toml');
const malformedToml = fixture('malformed-stellar.toml');
const TESTNET = 'Testnet Global Stellar Network ; September 2015';

interface FakeResponse {
  ok: boolean;
  status: number;
  contentType?: string;
  body?: string;
}

function fakeFetcher(response: FakeResponse): FetchLike {
  return async () => ({
    ok: response.ok,
    status: response.status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? (response.contentType ?? null) : null,
    },
    text: async () => response.body ?? '',
  });
}

function codes(findings: Finding[]): string[] {
  return findings.map((finding) => finding.code);
}

describe('SEP-1 stellar.toml validator (ISSUE-402)', () => {
  describe('domain handling', () => {
    it('normalizes a user supplied URL to a hostname', () => {
      expect(normalizeDomain('  https://Example.ORG/some/path  ')).toBe('example.org');
    });

    it('rejects an empty or malformed domain', () => {
      expect(() => normalizeDomain('')).toThrow(/domain is required/i);
      expect(() => normalizeDomain('bad host')).toThrow(/invalid domain/i);
    });

    it('builds the well-known URL', () => {
      expect(buildStellarTomlUrl('example.org')).toBe(
        'https://example.org/.well-known/stellar.toml',
      );
    });
  });

  describe('retrieval', () => {
    it('reports a failed HTTP request without parsing it', async () => {
      const result = await fetchStellarToml('example.org', {
        fetcher: fakeFetcher({ ok: false, status: 503, body: 'unavailable' }),
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(503);
      expect(result.error).toMatch(/HTTP 503/);
    });

    it('does not accept an HTML error page as TOML', async () => {
      const result = await fetchStellarToml('example.org', {
        fetcher: fakeFetcher({
          ok: true,
          status: 200,
          contentType: 'text/html',
          body: '<html>nope</html>',
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/content type|HTML/i);
    });

    it('reports a network failure as a retrieval error', async () => {
      const failing: FetchLike = async () => {
        throw new Error('ECONNRESET');
      };
      const result = await fetchStellarToml('example.org', { fetcher: failing });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/ECONNRESET/);
    });
  });

  describe('parsing', () => {
    it('parses a valid document', () => {
      const result = parseStellarToml(validToml);
      expect(result.ok).toBe(true);
      expect(result.document?.SIGNING_KEY).toBeDefined();
    });

    it('reports malformed TOML syntax', () => {
      const result = parseStellarToml(malformedToml);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Malformed TOML/);
    });
  });

  describe('SEP-1 validation', () => {
    it('accepts a valid document with optional fields', async () => {
      const parsed = parseStellarToml(validToml);
      const { findings } = await validateStellarToml(parsed.document!);
      expect(codes(findings)).not.toContain('signing-key-invalid');
      expect(codes(findings)).not.toContain('asset-duplicate');
      expect(codes(findings)).not.toContain('network-mismatch');
      expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    });

    it('reports missing network metadata', async () => {
      const document = parseStellarToml(validToml).document!;
      delete document.NETWORK_PASSPHRASE;
      const { findings, network } = await validateStellarToml(document);
      expect(codes(findings)).toContain('network-missing');
      expect(network.consistent).toBeNull();
    });

    it('reports an invalid signing key', async () => {
      const document = parseStellarToml(validToml).document!;
      document.SIGNING_KEY = 'GNOT_A_KEY';
      const { findings } = await validateStellarToml(document);
      expect(codes(findings)).toContain('signing-key-invalid');
    });

    it('reports malformed and duplicate asset declarations', async () => {
      const document = parseStellarToml(invalidFieldsToml).document!;
      const { findings } = await validateStellarToml(document);
      expect(codes(findings)).toContain('asset-duplicate');
      expect(codes(findings)).toContain('asset-code-invalid');
      expect(codes(findings)).toContain('asset-issuer-invalid');
    });

    it('reports invalid and insecure service endpoint URLs', async () => {
      const document = parseStellarToml(invalidFieldsToml).document!;
      const { findings } = await validateStellarToml(document);
      expect(codes(findings)).toContain('endpoint-invalid-url');
      expect(codes(findings)).toContain('endpoint-scheme');
      expect(codes(findings)).toContain('endpoint-insecure');
    });

    it('reports a passphrase mismatch against the expected network', async () => {
      const document = parseStellarToml(validToml).document!;
      const { findings, network } = await validateStellarToml(document, {
        expectedNetworkPassphrase: 'Public Global Stellar Network ; September 2015',
      });
      expect(codes(findings)).toContain('network-mismatch');
      expect(network.consistent).toBe(false);
    });

    it('matches an expected network passphrase', async () => {
      const document = parseStellarToml(validToml).document!;
      const { findings, network } = await validateStellarToml(document, {
        expectedNetworkPassphrase: TESTNET,
      });
      expect(codes(findings)).not.toContain('network-mismatch');
      expect(network.consistent).toBe(true);
    });
  });

  describe('end-to-end report', () => {
    it('returns a failed report for an unavailable domain', async () => {
      const report = await auditStellarToml('example.org', {
        fetcher: fakeFetcher({ ok: false, status: 404, body: 'missing' }),
      });
      expect(report.overall).toBe('fail');
      expect(report.counts.errors).toBeGreaterThan(0);
      expect(report.findings[0].code).toBe('retrieval-failed');
    });

    it('returns a passing report for a valid document', async () => {
      const report = await auditStellarToml('example.org', {
        fetcher: fakeFetcher({ ok: true, status: 200, contentType: 'text/plain', body: validToml }),
      });
      expect(report.overall).toBe('pass');
      expect(report.parse.ok).toBe(true);
      expect(report.network.declared).toBe(TESTNET);
    });
  });
});
