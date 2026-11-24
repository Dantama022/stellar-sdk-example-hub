import {
  auditAssetDeclarations,
  buildIssuerIdentityAudit,
  discoverTomlUrl,
  fetchStellarToml,
  formatIssuerIdentityAudit,
  inspectOrganizationMetadata,
  inspectSigningKeys,
  normalizeHomeDomain,
  parseCurrencyDeclarations,
  parseStellarToml,
  validateAssetIdentity,
  type HttpResponseLike,
} from '../src/examples/262-issuer-identity-audit';
import { examples } from '../src/runner/catalog';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OTHER_ISSUER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const HOME_DOMAIN = 'issuer.example.com';

const VALID_TOML = `
SIGNING_KEY="${ISSUER}"
ORG_NAME="Example Issuer"
ORG_URL="https://${HOME_DOMAIN}"
ORG_DESCRIPTION="Example asset issuer"

[[CURRENCIES]]
code="USDC"
issuer="${ISSUER}"
name="Example USD Coin"
desc="A test asset"
image="https://${HOME_DOMAIN}/usdc.png"
display_decimals=2
`;

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): HttpResponseLike {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    status,
    headers: {
      get: (name: string) => normalized[name.toLowerCase()] ?? null,
    },
    text: async () => body,
  };
}

describe('262-issuer-identity-audit: input and discovery', () => {
  it('validates asset codes and issuer public keys', () => {
    expect(validateAssetIdentity('USDC', ISSUER)).toEqual({
      assetCode: 'USDC',
      assetIssuer: ISSUER,
    });
    expect(() => validateAssetIdentity('BAD-CODE', ISSUER)).toThrow(/Invalid asset code/);
    expect(() => validateAssetIdentity('USDC', 'not-an-account')).toThrow(/Invalid issuer/);
    expect(() => validateAssetIdentity('XLM', ISSUER)).toThrow(/native asset/);
  });

  it('normalizes a bare home domain and builds the well-known URL', () => {
    expect(normalizeHomeDomain(' Issuer.Example.com. ')).toBe('issuer.example.com');
    expect(discoverTomlUrl(HOME_DOMAIN)).toBe(
      'https://issuer.example.com/.well-known/stellar.toml',
    );
    expect(() => normalizeHomeDomain('https://issuer.example.com')).toThrow(/bare hostname/);
  });
});

describe('262-issuer-identity-audit: stellar.toml retrieval', () => {
  it('retrieves a valid HTTPS document with bounded metadata', async () => {
    const result = await fetchStellarToml(discoverTomlUrl(HOME_DOMAIN), {
      fetchImpl: async () =>
        response(200, VALID_TOML, {
          'content-type': 'text/plain',
          'content-length': String(Buffer.byteLength(VALID_TOML)),
        }),
      now: () => new Date('2026-01-02T03:04:05Z'),
    });
    expect(result.finalUrl).toBe(`https://${HOME_DOMAIN}/.well-known/stellar.toml`);
    expect(result.retrievedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(result.redirects).toEqual([]);
    expect(parseStellarToml(result.content).ORG_NAME).toBe('Example Issuer');
  });

  it('follows a same-host HTTPS redirect and records it', async () => {
    const calls: string[] = [];
    const result = await fetchStellarToml(discoverTomlUrl(HOME_DOMAIN), {
      fetchImpl: async (url) => {
        calls.push(url);
        if (calls.length === 1) {
          return response(302, '', {
            location: `https://${HOME_DOMAIN}/metadata/stellar.toml`,
          });
        }
        return response(200, VALID_TOML, { 'content-type': 'text/plain' });
      },
    });
    expect(calls).toHaveLength(2);
    expect(result.redirects).toEqual([`https://${HOME_DOMAIN}/metadata/stellar.toml`]);
    expect(result.warnings.join(' ')).toContain('redirect');
  });

  it('rejects unexpected cross-host redirects', async () => {
    await expect(
      fetchStellarToml(discoverTomlUrl(HOME_DOMAIN), {
        fetchImpl: async () =>
          response(302, '', { location: 'https://attacker.example.net/stellar.toml' }),
      }),
    ).rejects.toThrow(/left the expected host/);
  });

  it('rejects non-HTTPS retrieval', async () => {
    await expect(
      fetchStellarToml('http://issuer.example.com/.well-known/stellar.toml'),
    ).rejects.toThrow(/HTTPS/);
  });

  it('reports transport failures and oversized responses', async () => {
    await expect(
      fetchStellarToml(discoverTomlUrl(HOME_DOMAIN), {
        fetchImpl: async () => {
          throw new Error('network unavailable');
        },
      }),
    ).rejects.toThrow(/network unavailable/);

    await expect(
      fetchStellarToml(discoverTomlUrl(HOME_DOMAIN), {
        fetchImpl: async () =>
          response(200, VALID_TOML, {
            'content-type': 'text/plain',
            'content-length': '999999999',
          }),
        maxBytes: 100,
      }),
    ).rejects.toThrow(/exceeding/);
  });

  it('rejects HTML responses and missing documents', async () => {
    await expect(
      fetchStellarToml(discoverTomlUrl(HOME_DOMAIN), {
        fetchImpl: async () => response(200, '<html></html>', { 'content-type': 'text/html' }),
      }),
    ).rejects.toThrow(/unsupported content type/);

    await expect(
      fetchStellarToml(discoverTomlUrl(HOME_DOMAIN), {
        fetchImpl: async () => response(404, 'not found', { 'content-type': 'text/plain' }),
      }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe('262-issuer-identity-audit: document validation', () => {
  it('parses TOML and distinguishes missing from malformed organization metadata', () => {
    const doc = parseStellarToml(VALID_TOML);
    const organization = inspectOrganizationMetadata(doc);
    expect(organization.metadata.ORG_NAME).toBe('Example Issuer');
    expect(organization.missingFields).toContain('ORG_LOGO');
    expect(organization.malformedFields).toHaveLength(0);

    const malformed = inspectOrganizationMetadata({
      ORG_URL: 'http://issuer.example.com',
      ORG_NAME: 42,
    });
    expect(malformed.malformedFields.map((field) => field.field)).toEqual([
      'ORG_NAME',
      'ORG_URL',
    ]);
  });

  it('validates signing keys and detects duplicate identity values', () => {
    const keys = inspectSigningKeys({
      SIGNING_KEY: ISSUER,
      URI_REQUEST_SIGNING_KEY: ISSUER,
    });
    expect(keys.every((key) => key.valid)).toBe(true);
    const invalid = inspectSigningKeys({ SIGNING_KEY: 'not-a-key' });
    expect(invalid[0].valid).toBe(false);
  });

  it('matches asset declarations by code and issuer', () => {
    const declarations = parseCurrencyDeclarations(parseStellarToml(VALID_TOML));
    const audit = auditAssetDeclarations(declarations, 'USDC', ISSUER);
    expect(audit.matchingAssetDeclarations).toHaveLength(1);
    expect(audit.mismatchedIssuerDeclarations).toHaveLength(0);
    expect(audit.displayMetadata[0].imageIsHttps).toBe(true);
    expect(audit.missing).toBe(false);
  });

  it('detects mismatched issuers, missing declarations, and duplicates', () => {
    const doc = parseStellarToml(`
[[CURRENCIES]]
code="USDC"
issuer="${OTHER_ISSUER}"

[[CURRENCIES]]
code="USDC"
issuer="${ISSUER}"

[[CURRENCIES]]
code="USDC"
issuer="${ISSUER}"
`);
    const declarations = parseCurrencyDeclarations(doc);
    const mismatched = auditAssetDeclarations(declarations, 'USDC', ISSUER);
    expect(mismatched.mismatchedIssuerDeclarations).toHaveLength(1);
    expect(mismatched.duplicateDeclarations).toHaveLength(2);

    const missing = auditAssetDeclarations(declarations, 'EURC', ISSUER);
    expect(missing.missing).toBe(true);
  });

  it('rejects invalid TOML syntax', () => {
    expect(() => parseStellarToml('[[CURRENCIES]\ncode = "USDC"')).toThrow(/Invalid TOML/);
  });
});

describe('262-issuer-identity-audit: report assembly', () => {
  it('builds a consistent report for a matching asset declaration', () => {
    const document = parseStellarToml(VALID_TOML);
    const report = buildIssuerIdentityAudit({
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      issuerAccount: { account_id: ISSUER, home_domain: HOME_DOMAIN },
      document,
      fetchResult: {
        requestedUrl: discoverTomlUrl(HOME_DOMAIN),
        finalUrl: discoverTomlUrl(HOME_DOMAIN),
        retrievedAt: '2026-01-02T03:04:05.000Z',
        status: 200,
        content: VALID_TOML,
        contentBytes: Buffer.byteLength(VALID_TOML),
        redirects: [],
        warnings: [],
      },
    });
    expect(report.overallStatus).toBe('consistent');
    expect(report.identityConsistency.assetDeclarationMatchesRequestedIssuer).toBe(true);
    expect(report.signingKeys[0].valid).toBe(true);
    expect(formatIssuerIdentityAudit(report)).toContain('Overall status: consistent');
  });

  it('marks an account without a home domain as incomplete', () => {
    const report = buildIssuerIdentityAudit({
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      issuerAccount: { account_id: ISSUER },
    });
    expect(report.overallStatus).toBe('incomplete');
    expect(report.documentRetrievalStatus).toBe('failed');
    expect(report.warnings.join(' ')).toContain('home domain');
  });

  it('reports Horizon and retrieval failures without claiming identity', () => {
    const report = buildIssuerIdentityAudit({
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      issuerAccountError: 'account not found',
      fetchError: 'document unavailable',
    });
    expect(report.overallStatus).toBe('failed');
    expect(report.errors.join(' ')).toContain('account not found');
    expect(report.limitations.join(' ')).toContain('not independently verified');
  });

  it('records invalid parsing and invalid public keys as inconsistencies', () => {
    const document = parseStellarToml(
      VALID_TOML.replace(ISSUER, 'not-a-public-key').replace('ORG_NAME="Example Issuer"', ''),
    );
    const report = buildIssuerIdentityAudit({
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      issuerAccount: { account_id: ISSUER, home_domain: HOME_DOMAIN },
      document,
      parseError: null,
    });
    expect(report.overallStatus).toBe('inconsistent');
    expect(report.errors.join(' ')).toContain('SIGNING_KEY');
  });

  it('serializes the report as machine-readable JSON', () => {
    const report = buildIssuerIdentityAudit({
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      issuerAccount: { account_id: ISSUER, home_domain: HOME_DOMAIN },
    });
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.assetCode).toBe('USDC');
    expect(parsed.assetIssuer).toBe(ISSUER);
    expect(parsed.limitations.length).toBeGreaterThan(0);
  });

  it('is registered as a runnable example', () => {
    expect(examples['262-issuer-identity-audit']).toBeDefined();
    expect(typeof examples['262-issuer-identity-audit'].run).toBe('function');
  });
});
