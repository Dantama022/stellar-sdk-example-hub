/**
 * 262-issuer-identity-audit: Stellar Issuer Home-Domain and Identity Auditor
 *
 * OVERVIEW
 * --------
 * A Stellar asset is identified by both its code and its issuer account. An
 * issuer can publish identity and service information through its account's
 * `home_domain` and the `stellar.toml` document hosted at:
 *
 *   https://<home-domain>/.well-known/stellar.toml
 *
 * This example retrieves the issuer account, discovers and fetches the
 * corresponding SEP-1 document, validates its public keys and service URLs, and
 * compares its `[[CURRENCIES]]` declarations with the requested asset.
 *
 * IMPORTANT LIMITATION
 * --------------------
 * A valid HTTPS response and a parseable `stellar.toml` are published claims,
 * not independently verified proof of an issuer's legal identity. This example
 * is read-only and never treats published metadata as a guarantee that an asset
 * is legitimate or safe.
 */

import { Horizon, StrKey } from '@stellar/stellar-sdk';
import { parse as parseTomlText } from 'toml';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ASSET_CODE = 'USDC';
const DEFAULT_ASSET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const TOML_PATH = '/.well-known/stellar.toml';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

const ORG_FIELDS: Array<{ field: string; https?: boolean }> = [
  { field: 'ORG_NAME' },
  { field: 'ORG_DBA' },
  { field: 'ORG_URL', https: true },
  { field: 'ORG_LOGO', https: true },
  { field: 'ORG_DESCRIPTION' },
  { field: 'ORG_PHYSICAL_ADDRESS' },
  { field: 'ORG_PHYSICAL_ADDRESS_ATTESTATION', https: true },
  { field: 'ORG_PHONE_NUMBER' },
  { field: 'ORG_PHONE_NUMBER_ATTESTATION', https: true },
  { field: 'ORG_KEYBASE' },
  { field: 'ORG_TWITTER' },
  { field: 'ORG_GITHUB' },
  { field: 'ORG_OFFICIAL_EMAIL' },
  { field: 'ORG_SUPPORT_EMAIL' },
  { field: 'ORG_LICENSING_AUTHORITY' },
  { field: 'ORG_LICENSE_TYPE' },
  { field: 'ORG_LICENSE_NUMBER' },
];

const SIGNING_KEY_FIELDS = ['SIGNING_KEY', 'URI_REQUEST_SIGNING_KEY'];

const SERVICE_URL_FIELDS = [
  'WEB_AUTH_ENDPOINT',
  'TRANSFER_SERVER',
  'TRANSFER_SERVER_SEP0024',
  'KYC_SERVER',
  'DIRECT_PAYMENT_SERVER',
  'ANCHOR_QUOTE_SERVER',
];

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type StellarTomlDocument = Record<string, unknown>;

export interface IssuerIdentityAuditParams {
  assetCode?: string;
  assetIssuer?: string;
  horizonUrl?: string;
  tomlUrl?: string;
  json?: boolean | string;
  timeoutMs?: number | string;
  maxBytes?: number | string;
}

export interface AssetIdentity {
  assetCode: string;
  assetIssuer: string;
}

export interface MalformedField {
  field: string;
  value: unknown;
  reason: string;
}

export interface OrganizationMetadata {
  metadata: Record<string, string>;
  presentFields: string[];
  missingFields: string[];
  malformedFields: MalformedField[];
}

export interface PublicKeyInspection {
  field: string;
  value: string;
  valid: boolean;
  error?: string;
}

export interface ServiceEndpointInspection {
  field: string;
  value: string;
  validHttps: boolean;
  host: string | null;
  sameDomainAsHomeDomain: boolean | null;
  error?: string;
}

export interface CurrencyDeclaration {
  index: number;
  code?: string;
  codeTemplate?: string;
  issuer?: string;
  name?: string;
  description?: string;
  image?: string;
  status?: string;
  displayDecimals?: number;
  malformed?: string;
}

export interface AssetDeclarationAudit {
  totalDeclarations: number;
  declarationsForCode: CurrencyDeclaration[];
  matchingAssetDeclarations: CurrencyDeclaration[];
  mismatchedIssuerDeclarations: CurrencyDeclaration[];
  declarationsMissingIssuer: CurrencyDeclaration[];
  duplicateDeclarations: CurrencyDeclaration[];
  invalidIssuerDeclarations: MalformedField[];
  displayMetadata: Array<{
    code: string | null;
    name: string | null;
    description: string | null;
    image: string | null;
    imageIsHttps: boolean | null;
  }>;
  missing: boolean;
}

export interface StellarTomlFetchResult {
  requestedUrl: string;
  finalUrl: string;
  retrievedAt: string;
  status: number;
  content: string;
  contentBytes: number;
  redirects: string[];
  warnings: string[];
}

export interface IssuerAccountLike {
  account_id?: string;
  home_domain?: string;
  flags?: Record<string, unknown>;
}

export interface IssuerIdentityAuditInput {
  assetCode: string;
  assetIssuer: string;
  issuerAccount?: IssuerAccountLike | null;
  issuerAccountError?: string | null;
  document?: StellarTomlDocument | null;
  fetchResult?: StellarTomlFetchResult | null;
  fetchError?: string | null;
  parseError?: string | null;
}

export interface IssuerIdentityAuditReport {
  assetCode: string;
  assetIssuer: string;
  issuerAccountExists: boolean;
  issuerAccountId: string | null;
  requestedIssuerMatchesAccount: boolean;
  homeDomain: string | null;
  documentUrl: string | null;
  resolvedDocumentUrl: string | null;
  retrievedAt: string | null;
  documentRetrievalStatus: 'not_checked' | 'retrieved' | 'failed';
  documentParseStatus: 'not_parsed' | 'parsed' | 'invalid';
  organization: OrganizationMetadata;
  signingKeys: PublicKeyInspection[];
  duplicateSigningKeys: string[];
  serviceEndpoints: ServiceEndpointInspection[];
  assetDeclarations: AssetDeclarationAudit;
  identityConsistency: {
    accountMatchesRequestedIssuer: boolean;
    assetDeclarationMatchesRequestedIssuer: boolean;
    homeDomainConfigured: boolean;
    signingKeyMatchesIssuer: boolean | null;
    warnings: string[];
    errors: string[];
  };
  transport: {
    httpsOnly: boolean;
    redirects: string[];
    warnings: string[];
    contentBytes: number | null;
  };
  missingOrMalformedFields: string[];
  warnings: string[];
  errors: string[];
  overallStatus: 'consistent' | 'warnings' | 'inconsistent' | 'incomplete' | 'failed';
  limitations: string[];
}

export interface HttpResponseLike {
  status: number;
  ok?: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<HttpResponseLike>;

export interface FetchStellarTomlOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  now?: () => Date;
}

// ──────────────────────────────────────────────────────────────────────────────
// Input validation
// ──────────────────────────────────────────────────────────────────────────────

export function isValidAssetCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z0-9]{1,12}$/.test(code);
}

export function isValidAccountId(accountId: unknown): accountId is string {
  return typeof accountId === 'string' && StrKey.isValidEd25519PublicKey(accountId);
}

export function validateAssetIdentity(assetCode: unknown, assetIssuer: unknown): AssetIdentity {
  if (!isValidAssetCode(assetCode)) {
    throw new Error(
      `Invalid asset code "${String(assetCode)}": expected 1-12 alphanumeric characters.`,
    );
  }
  if (assetCode.toUpperCase() === 'XLM') {
    throw new Error('XLM is the native asset and has no issuer identity document.');
  }
  if (!isValidAccountId(assetIssuer)) {
    throw new Error(
      `Invalid issuer account "${String(assetIssuer)}": expected a valid Stellar G... public key.`,
    );
  }
  return { assetCode, assetIssuer };
}

/**
 * Validates a home domain and returns a normalized bare hostname.
 * Home domains in account records do not include a scheme or path.
 */
export function normalizeHomeDomain(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Issuer account has no configured home domain.');
  }
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (/[:/\\@?#\s]/.test(domain) || domain.includes('..')) {
    throw new Error(`Invalid home domain "${value}": expected a bare hostname.`);
  }
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  if (!new RegExp(`^(?=.{1,253}$)(?:${label}\\.)*${label}$`).test(domain)) {
    throw new Error(`Invalid home domain "${value}": expected a bare hostname.`);
  }
  return domain;
}

export function discoverTomlUrl(homeDomain: string): string {
  const domain = normalizeHomeDomain(homeDomain);
  return `https://${domain}${TOML_PATH}`;
}

export function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

// ──────────────────────────────────────────────────────────────────────────────
// stellar.toml retrieval
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fetches a stellar.toml document with bounded response size, a request
 * timeout, no credentials, and a conservative redirect policy.
 *
 * Redirects are followed only when they remain on the requested host and use
 * HTTPS. Every followed redirect is recorded as a warning.
 */
export async function fetchStellarToml(
  tomlUrl: string,
  options: FetchStellarTomlOptions = {},
): Promise<StellarTomlFetchResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(tomlUrl);
  } catch {
    throw new Error(`Invalid stellar.toml URL: ${tomlUrl}`);
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('stellar.toml must be retrieved over HTTPS.');
  }

  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxBytes = Math.max(1, Number(options.maxBytes ?? DEFAULT_MAX_BYTES));
  const maxRedirects = Math.max(0, Number(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS));
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((url, init) => fetch(url, init) as Promise<HttpResponseLike>);
  const now = options.now ?? (() => new Date());

  const requestedUrl = parsedUrl.toString();
  let currentUrl = requestedUrl;
  const redirects: string[] = [];
  const warnings: string[] = [];

  for (let redirectCount = 0; ; redirectCount += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: HttpResponseLike;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          Accept: 'text/plain, application/toml;q=0.9, */*;q=0.1',
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`stellar.toml retrieval failed for ${currentUrl}: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`stellar.toml redirect response ${response.status} has no Location.`);
      }
      if (redirectCount >= maxRedirects) {
        throw new Error(`stellar.toml exceeded the maximum of ${maxRedirects} redirect(s).`);
      }
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.protocol !== 'https:') {
        throw new Error(`stellar.toml redirect attempted to downgrade to ${nextUrl.protocol}.`);
      }
      if (nextUrl.hostname !== parsedUrl.hostname) {
        throw new Error(
          `stellar.toml redirect left the expected host ${parsedUrl.hostname}: ${nextUrl.hostname}.`,
        );
      }
      redirects.push(nextUrl.toString());
      warnings.push(`Followed same-host redirect to ${nextUrl.toString()}.`);
      currentUrl = nextUrl.toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`stellar.toml retrieval returned HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(
        `stellar.toml response is ${contentLength} bytes, exceeding the ${maxBytes}-byte limit.`,
      );
    }

    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      throw new Error(`stellar.toml returned unsupported content type ${contentType}.`);
    }

    const content = await response.text();
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > maxBytes) {
      throw new Error(
        `stellar.toml response is ${contentBytes} bytes, exceeding the ${maxBytes}-byte limit.`,
      );
    }
    if (!content.trim()) {
      throw new Error('stellar.toml response was empty.');
    }

    return {
      requestedUrl,
      finalUrl: currentUrl,
      retrievedAt: now().toISOString(),
      status: response.status,
      content,
      contentBytes,
      redirects,
      warnings,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Parsing and document inspection
// ──────────────────────────────────────────────────────────────────────────────

export function parseStellarToml(content: string): StellarTomlDocument {
  if (!content.trim()) throw new Error('Cannot parse an empty stellar.toml document.');
  let parsed: unknown;
  try {
    parsed = parseTomlText(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid TOML syntax: ${message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('stellar.toml must contain a TOML table at the top level.');
  }
  return parsed as StellarTomlDocument;
}

export function inspectOrganizationMetadata(doc: StellarTomlDocument): OrganizationMetadata {
  const metadata: Record<string, string> = {};
  const presentFields: string[] = [];
  const missingFields: string[] = [];
  const malformedFields: MalformedField[] = [];

  for (const definition of ORG_FIELDS) {
    const raw = doc[definition.field];
    if (raw === undefined || raw === null || raw === '') {
      missingFields.push(definition.field);
      continue;
    }
    if (typeof raw !== 'string') {
      malformedFields.push({
        field: definition.field,
        value: raw,
        reason: 'expected a string',
      });
      continue;
    }
    if (definition.https && !isHttpsUrl(raw)) {
      malformedFields.push({
        field: definition.field,
        value: raw,
        reason: 'expected an absolute HTTPS URL',
      });
      continue;
    }
    metadata[definition.field] = raw;
    presentFields.push(definition.field);
  }

  return { metadata, presentFields, missingFields, malformedFields };
}

export function inspectSigningKeys(doc: StellarTomlDocument): PublicKeyInspection[] {
  return SIGNING_KEY_FIELDS.filter((field) => {
    const value = doc[field];
    return value !== undefined && value !== null && value !== '';
  }).map((field) => {
    const value = String(doc[field]);
    const valid = StrKey.isValidEd25519PublicKey(value);
    return valid
      ? { field, value, valid }
      : {
          field,
          value,
          valid,
          error: 'expected a valid Stellar G... public key',
        };
  });
}

export function findDuplicateSigningKeys(keys: PublicKeyInspection[]): string[] {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key.value, (counts.get(key.value) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

export function inspectServiceEndpoints(
  doc: StellarTomlDocument,
  homeDomain: string | null,
): ServiceEndpointInspection[] {
  return SERVICE_URL_FIELDS.filter((field) => {
    const value = doc[field];
    return value !== undefined && value !== null && value !== '';
  }).map((field) => {
    const value = String(doc[field]);
    let host: string | null = null;
    let error: string | undefined;
    try {
      const url = new URL(value);
      host = url.hostname;
      if (url.protocol !== 'https:') error = 'expected an absolute HTTPS URL';
    } catch {
      error = 'expected an absolute HTTPS URL';
    }
    return {
      field,
      value,
      validHttps: isHttpsUrl(value),
      host,
      sameDomainAsHomeDomain: host && homeDomain ? host === homeDomain : null,
      ...(error ? { error } : {}),
    };
  });
}

function currencyTemplateMatches(template: string, code: string): boolean {
  if (template.length !== code.length) return false;
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] !== '?' && template[index] !== code[index]) return false;
  }
  return true;
}

export function parseCurrencyDeclarations(doc: StellarTomlDocument): CurrencyDeclaration[] {
  const raw = doc.CURRENCIES;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('CURRENCIES must be an array of TOML tables.');
  }
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { index, malformed: 'CURRENCIES entry must be a table.' };
    }
    const table = entry as Record<string, unknown>;
    const declaration: CurrencyDeclaration = { index };
    if (typeof table.code === 'string') declaration.code = table.code;
    else if (table.code !== undefined) declaration.malformed = 'code must be a string.';
    if (typeof table.code_template === 'string') declaration.codeTemplate = table.code_template;
    else if (table.code_template !== undefined) {
      declaration.malformed = 'code_template must be a string.';
    }
    if (typeof table.issuer === 'string') declaration.issuer = table.issuer;
    else if (table.issuer !== undefined) declaration.malformed = 'issuer must be a string.';
    if (typeof table.name === 'string') declaration.name = table.name;
    if (typeof table.desc === 'string') declaration.description = table.desc;
    if (typeof table.image === 'string') declaration.image = table.image;
    if (typeof table.status === 'string') declaration.status = table.status;
    if (typeof table.display_decimals === 'number') {
      declaration.displayDecimals = table.display_decimals;
    }
    return declaration;
  });
}

function declarationMatchesCode(declaration: CurrencyDeclaration, code: string): boolean {
  if (declaration.code) return declaration.code === code;
  if (declaration.codeTemplate) return currencyTemplateMatches(declaration.codeTemplate, code);
  return false;
}

export function auditAssetDeclarations(
  declarations: CurrencyDeclaration[],
  assetCode: string,
  assetIssuer: string,
): AssetDeclarationAudit {
  const declarationsForCode = declarations.filter((declaration) =>
    declarationMatchesCode(declaration, assetCode),
  );
  const matchingAssetDeclarations = declarationsForCode.filter(
    (declaration) => declaration.issuer === assetIssuer,
  );
  const mismatchedIssuerDeclarations = declarationsForCode.filter(
    (declaration) => declaration.issuer !== undefined && declaration.issuer !== assetIssuer,
  );
  const declarationsMissingIssuer = declarationsForCode.filter(
    (declaration) => declaration.issuer === undefined,
  );
  const invalidIssuerDeclarations: MalformedField[] = declarationsForCode
    .filter(
      (declaration) =>
        declaration.issuer !== undefined && !StrKey.isValidEd25519PublicKey(declaration.issuer),
    )
    .map((declaration) => ({
      field: `CURRENCIES[${declaration.index}].issuer`,
      value: declaration.issuer,
      reason: 'expected a valid Stellar G... public key',
    }));

  const duplicateKeys = new Map<string, number>();
  for (const declaration of declarationsForCode) {
    const key = declaration.issuer
      ? `${declaration.code ?? declaration.codeTemplate}:${declaration.issuer}`
      : `unissued:${declaration.code ?? declaration.codeTemplate}`;
    duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1);
  }
  const duplicateKeysSet = new Set(
    [...duplicateKeys.entries()].filter(([, count]) => count > 1).map(([key]) => key),
  );
  const duplicateDeclarations = declarationsForCode.filter((declaration) => {
    const key = declaration.issuer
      ? `${declaration.code ?? declaration.codeTemplate}:${declaration.issuer}`
      : `unissued:${declaration.code ?? declaration.codeTemplate}`;
    return duplicateKeysSet.has(key);
  });

  return {
    totalDeclarations: declarations.length,
    declarationsForCode,
    matchingAssetDeclarations,
    mismatchedIssuerDeclarations,
    declarationsMissingIssuer,
    duplicateDeclarations,
    invalidIssuerDeclarations,
    displayMetadata: matchingAssetDeclarations.map((declaration) => ({
      code: declaration.code ?? null,
      name: declaration.name ?? null,
      description: declaration.description ?? null,
      image: declaration.image ?? null,
      imageIsHttps: declaration.image === undefined ? null : isHttpsUrl(declaration.image),
    })),
    missing: matchingAssetDeclarations.length === 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Report assembly
// ──────────────────────────────────────────────────────────────────────────────

export function buildIssuerIdentityAudit(
  input: IssuerIdentityAuditInput,
): IssuerIdentityAuditReport {
  const warnings: string[] = [];
  const errors: string[] = [];
  const missingOrMalformedFields: string[] = [];

  const issuerAccount = input.issuerAccount ?? null;
  const issuerAccountExists = Boolean(issuerAccount);
  const issuerAccountId = issuerAccount?.account_id ?? null;
  const requestedIssuerMatchesAccount = issuerAccountId === input.assetIssuer;

  let homeDomain: string | null = null;
  try {
    if (issuerAccount?.home_domain) homeDomain = normalizeHomeDomain(issuerAccount.home_domain);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  const documentUrl = homeDomain ? discoverTomlUrl(homeDomain) : null;
  const fetchResult = input.fetchResult ?? null;
  const document = input.document ?? null;
  const organization = document
    ? inspectOrganizationMetadata(document)
    : { metadata: {}, presentFields: [], missingFields: [], malformedFields: [] };
  const signingKeys = document ? inspectSigningKeys(document) : [];
  const duplicateSigningKeys = findDuplicateSigningKeys(signingKeys);
  const serviceEndpoints = document ? inspectServiceEndpoints(document, homeDomain) : [];
  let assetDeclarations: AssetDeclarationAudit = {
    totalDeclarations: 0,
    declarationsForCode: [],
    matchingAssetDeclarations: [],
    mismatchedIssuerDeclarations: [],
    declarationsMissingIssuer: [],
    duplicateDeclarations: [],
    invalidIssuerDeclarations: [],
    displayMetadata: [],
    missing: true,
  };

  if (document) {
    try {
      assetDeclarations = auditAssetDeclarations(
        parseCurrencyDeclarations(document),
        input.assetCode,
        input.assetIssuer,
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (input.issuerAccountError) {
    errors.push(`Issuer account retrieval failed: ${input.issuerAccountError}`);
  }
  if (!issuerAccountExists && !input.issuerAccountError) {
    errors.push('Issuer account was not found.');
  }
  if (issuerAccountExists && !requestedIssuerMatchesAccount) {
    errors.push(
      `Horizon returned account ${issuerAccountId ?? 'unknown'} for requested issuer ${input.assetIssuer}.`,
    );
  }
  if (!homeDomain) {
    warnings.push('Issuer account does not expose a usable home domain.');
  }
  if (input.fetchError) {
    errors.push(`stellar.toml retrieval failed: ${input.fetchError}`);
  }
  if (input.parseError) {
    errors.push(`stellar.toml parsing failed: ${input.parseError}`);
  }
  if (fetchResult) warnings.push(...fetchResult.warnings);
  if (fetchResult && fetchResult.finalUrl !== fetchResult.requestedUrl) {
    warnings.push(`Document was retrieved from ${fetchResult.finalUrl}.`);
  }

  for (const malformed of organization.malformedFields) {
    missingOrMalformedFields.push(`${malformed.field}: ${malformed.reason}`);
  }
  for (const key of signingKeys.filter((entry) => !entry.valid)) {
    missingOrMalformedFields.push(`${key.field}: ${key.error ?? 'invalid public key'}`);
  }
  for (const endpoint of serviceEndpoints.filter((entry) => !entry.validHttps)) {
    missingOrMalformedFields.push(`${endpoint.field}: ${endpoint.error ?? 'invalid URL'}`);
  }
  for (const declaration of assetDeclarations.invalidIssuerDeclarations) {
    missingOrMalformedFields.push(`${declaration.field}: ${declaration.reason}`);
  }

  for (const key of signingKeys.filter((entry) => !entry.valid)) {
    errors.push(`${key.field} is not a valid Stellar public key.`);
  }
  if (duplicateSigningKeys.length > 0) {
    warnings.push(`Duplicate signing key value(s): ${duplicateSigningKeys.join(', ')}.`);
  }
  for (const endpoint of serviceEndpoints) {
    if (!endpoint.validHttps) {
      warnings.push(`${endpoint.field} must be an absolute HTTPS URL.`);
    } else if (endpoint.sameDomainAsHomeDomain === false) {
      warnings.push(
        `${endpoint.field} is hosted on ${endpoint.host ?? 'another host'}, not the issuer home domain ${homeDomain}.`,
      );
    }
  }
  if (document && assetDeclarations.missing) {
    warnings.push(
      `stellar.toml has no CURRENCIES declaration for ${input.assetCode}:${input.assetIssuer}.`,
    );
  }
  for (const declaration of assetDeclarations.mismatchedIssuerDeclarations) {
    warnings.push(
      `CURRENCIES[${declaration.index}] declares ${input.assetCode} for issuer ${declaration.issuer}, not ${input.assetIssuer}.`,
    );
  }
  for (const declaration of assetDeclarations.declarationsMissingIssuer) {
    warnings.push(
      `CURRENCIES[${declaration.index}] declares ${input.assetCode} without an issuer.`,
    );
  }
  if (assetDeclarations.duplicateDeclarations.length > 0) {
    warnings.push(
      `stellar.toml contains duplicate declarations for ${input.assetCode}: duplicate entries at indexes ${assetDeclarations.duplicateDeclarations
        .map((declaration) => declaration.index)
        .join(', ')}.`,
    );
  }
  if (organization.presentFields.length === 0 && document) {
    warnings.push('stellar.toml contains no supported organization metadata fields.');
  }

  const signingKeyMatchesIssuer =
    signingKeys.length === 0
      ? null
      : signingKeys.some(
          (key) => key.valid && key.field === 'SIGNING_KEY' && key.value === input.assetIssuer,
        );

  const documentRetrievalStatus = fetchResult
    ? 'retrieved'
    : input.fetchError || (!homeDomain && issuerAccountExists) || !issuerAccountExists
      ? 'failed'
      : 'not_checked';
  const documentParseStatus = input.parseError ? 'invalid' : document ? 'parsed' : 'not_parsed';

  let overallStatus: IssuerIdentityAuditReport['overallStatus'];
  if (errors.length > 0) {
    overallStatus = documentRetrievalStatus === 'failed' ? 'failed' : 'inconsistent';
  } else if (!issuerAccountExists || !homeDomain || documentParseStatus !== 'parsed') {
    overallStatus = 'incomplete';
  } else if (warnings.length > 0 || missingOrMalformedFields.length > 0) {
    overallStatus = 'warnings';
  } else {
    overallStatus = 'consistent';
  }

  return {
    assetCode: input.assetCode,
    assetIssuer: input.assetIssuer,
    issuerAccountExists,
    issuerAccountId,
    requestedIssuerMatchesAccount,
    homeDomain,
    documentUrl,
    resolvedDocumentUrl: fetchResult?.finalUrl ?? null,
    retrievedAt: fetchResult?.retrievedAt ?? null,
    documentRetrievalStatus,
    documentParseStatus,
    organization,
    signingKeys,
    duplicateSigningKeys,
    serviceEndpoints,
    assetDeclarations,
    identityConsistency: {
      accountMatchesRequestedIssuer: requestedIssuerMatchesAccount,
      assetDeclarationMatchesRequestedIssuer:
        assetDeclarations.matchingAssetDeclarations.length > 0,
      homeDomainConfigured: Boolean(homeDomain),
      signingKeyMatchesIssuer,
      warnings,
      errors,
    },
    transport: {
      httpsOnly: fetchResult ? fetchResult.requestedUrl.startsWith('https://') : true,
      redirects: fetchResult?.redirects ?? [],
      warnings: fetchResult?.warnings ?? [],
      contentBytes: fetchResult?.contentBytes ?? null,
    },
    missingOrMalformedFields,
    warnings,
    errors,
    overallStatus,
    limitations: [
      'Published stellar.toml metadata is a claim by the issuer, not independently verified proof of legal identity.',
      'A successful HTTPS retrieval does not prove organizational ownership of the domain.',
      'Asset declarations describe the issuer’s own metadata and do not guarantee that an asset is safe or legitimate.',
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Display
// ──────────────────────────────────────────────────────────────────────────────

export function formatIssuerIdentityAudit(report: IssuerIdentityAuditReport): string {
  const lines = [
    '=== Stellar Issuer Home-Domain and Identity Audit ===',
    `Asset: ${report.assetCode}:${report.assetIssuer}`,
    `Issuer account exists: ${report.issuerAccountExists}`,
    `Requested issuer matches account: ${report.requestedIssuerMatchesAccount}`,
    `Home domain: ${report.homeDomain ?? '(not configured)'}`,
    `Document URL: ${report.documentUrl ?? '(not discovered)'}`,
    `Resolved document URL: ${report.resolvedDocumentUrl ?? '(not retrieved)'}`,
    `Retrieved at: ${report.retrievedAt ?? '(not retrieved)'}`,
    `Retrieval status: ${report.documentRetrievalStatus}`,
    `Parsing status: ${report.documentParseStatus}`,
    '',
    'Organization metadata:',
  ];

  if (report.organization.presentFields.length === 0) lines.push('  (none published)');
  for (const field of report.organization.presentFields) {
    lines.push(`  ${field}: ${report.organization.metadata[field]}`);
  }

  lines.push('', 'Signing keys:');
  if (report.signingKeys.length === 0) lines.push('  (none published)');
  for (const key of report.signingKeys) {
    lines.push(`  ${key.field}: ${key.value} (${key.valid ? 'valid format' : 'INVALID'})`);
  }

  lines.push('', 'Service endpoints:');
  if (report.serviceEndpoints.length === 0) lines.push('  (none published)');
  for (const endpoint of report.serviceEndpoints) {
    lines.push(
      `  ${endpoint.field}: ${endpoint.value} ` +
        `(${endpoint.validHttps ? 'HTTPS' : 'INVALID'}${endpoint.sameDomainAsHomeDomain === false ? ', different host' : ''})`,
    );
  }

  lines.push('', 'Asset declarations:');
  lines.push(
    `  ${report.assetDeclarations.matchingAssetDeclarations.length} matching declaration(s) out of ${report.assetDeclarations.totalDeclarations}.`,
  );
  if (report.assetDeclarations.missing) {
    lines.push('  No declaration matches the requested asset code and issuer.');
  }
  for (const metadata of report.assetDeclarations.displayMetadata) {
    lines.push(
      `  ${metadata.code ?? 'unknown'}: name=${metadata.name ?? '(none)'} ` +
        `image=${metadata.image ?? '(none)'}${metadata.imageIsHttps === false ? ' [image is not HTTPS]' : ''}`,
    );
  }

  lines.push('', `Overall status: ${report.overallStatus}`);
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  if (report.errors.length > 0) {
    lines.push('', 'Errors:');
    for (const error of report.errors) lines.push(`  - ${error}`);
  }
  if (report.missingOrMalformedFields.length > 0) {
    lines.push('', 'Missing or malformed fields:');
    for (const field of report.missingOrMalformedFields) lines.push(`  - ${field}`);
  }
  lines.push('', 'Limitations:');
  for (const limitation of report.limitations) lines.push(`  - ${limitation}`);
  return lines.join('\n');
}

function wantsJson(value: boolean | string | undefined): boolean {
  return value === true || value === 'true' || process.env.JSON_OUTPUT === 'true';
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function run(params: IssuerIdentityAuditParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const assetCode = params.assetCode || process.env.ASSET_CODE || DEFAULT_ASSET_CODE;
  const assetIssuer = params.assetIssuer || process.env.ASSET_ISSUER || DEFAULT_ASSET_ISSUER;
  const json = wantsJson(params.json);
  const timeoutMs = Number(params.timeoutMs ?? process.env.TOML_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const maxBytes = Number(params.maxBytes ?? process.env.TOML_MAX_BYTES ?? DEFAULT_MAX_BYTES);

  try {
    const identity = validateAssetIdentity(assetCode.trim(), assetIssuer.trim());
    const server = new Horizon.Server(horizonUrl);

    let issuerAccount: IssuerAccountLike | null = null;
    let issuerAccountError: string | null = null;
    try {
      issuerAccount = (await server.loadAccount(
        identity.assetIssuer,
      )) as unknown as IssuerAccountLike;
    } catch (error) {
      issuerAccountError = error instanceof Error ? error.message : String(error);
    }

    let fetchResult: StellarTomlFetchResult | null = null;
    let document: StellarTomlDocument | null = null;
    let fetchError: string | null = null;
    let parseError: string | null = null;

    if (issuerAccount?.home_domain) {
      try {
        const tomlUrl =
          params.tomlUrl || discoverTomlUrl(normalizeHomeDomain(issuerAccount.home_domain));
        fetchResult = await fetchStellarToml(tomlUrl, {
          timeoutMs,
          maxBytes,
        });
        document = parseStellarToml(fetchResult.content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('Invalid TOML') || message.startsWith('Cannot parse')) {
          parseError = message;
        } else {
          fetchError = message;
        }
      }
    }

    const report = buildIssuerIdentityAudit({
      ...identity,
      issuerAccount,
      issuerAccountError,
      document,
      fetchResult,
      fetchError,
      parseError,
    });

    console.log(json ? JSON.stringify(report, null, 2) : formatIssuerIdentityAudit(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ assetCode, assetIssuer, error: message }, null, 2));
    else console.error(`Could not audit issuer ${assetIssuer}: ${message}`);
  }
}
