import { Horizon, StrKey } from '@stellar/stellar-sdk';
import chalk from 'chalk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * ISSUE-355: Stellar SEP-2 Federation Protocol Address Resolution and Validation
 *
 * This example demonstrates the SEP-2 Federation protocol for resolving
 * Stellar addresses (e.g., `user*domain.com`) to account IDs and optional memos.
 *
 * The federation protocol allows human-readable addresses to be resolved to
 * Stellar account IDs by querying a federation endpoint advertised in the
 * domain's stellar.toml file.
 *
 * This example:
 * 1. Resolves a stellar address using the federation protocol
 * 2. Validates the resolved account ID
 * 3. Checks if the account exists on the network
 * 4. Inspects the account's home domain for verification
 */

export interface Sep2FederationParams {
  stellarAddress?: string;
  domain?: string;
  accountId?: string;
  horizonUrl?: string;
  timeoutMs?: string | number;
  json?: boolean | string;
}

export interface FederationRecord {
  account_id: string;
  memo?: string;
  memo_type?: 'text' | 'id' | 'hash';
}

export interface StellarTomlRecord {
  FEDERATION_SERVER?: string;
  CURRENCIES?: Array<{
    code: string;
    issuer: string;
    status?: string;
    display_decimals?: number;
  }>;
  DOCUMENTATION?: {
    ORG_NAME?: string;
    ORG_URL?: string;
    ORG_LOGO?: string;
    ORG_DESCRIPTION?: string;
    ORG_OFFICIAL_EMAIL?: string;
    ORG_SUPPORT_EMAIL?: string;
    ORG_KEYBASE?: string;
    ORG_TWITTER?: string;
    ORG_GITHUB?: string;
  };
  PRINCIPALS?: Array<{
    name: string;
    email: string;
    keybase?: string;
    twitter?: string;
    github?: string;
  }>;
}

export interface FederationResolutionResult {
  stellarAddress: string;
  domain: string;
  federationServer: string | null;
  resolved: boolean;
  accountId: string | null;
  memo: string | null;
  memoType: string | null;
  accountExists: boolean;
  accountHomeDomain: string | null;
  stellarToml: StellarTomlRecord | null;
  errors: string[];
  warnings: string[];
}

export interface ValidationResult {
  valid: boolean;
  accountId: string | null;
  errors: string[];
}

function wantsJson(params: Sep2FederationParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

function readNonNegativeInt(
  value: string | number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return Math.floor(parsed);
}

function parseStellarAddress(address: string): { username: string; domain: string } | null {
  const trimmed = address.trim();
  const match = trimmed.match(/^([^@*]+)[*@](.+)$/);
  if (!match) {
    return null;
  }
  return { username: match[1], domain: match[2].toLowerCase() };
}

async function fetchStellarToml(domain: string, timeoutMs: number): Promise<StellarTomlRecord | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Try HTTPS first
    const httpsUrl = `https://${domain}/.well-known/stellar.toml`;
    const response = await fetch(httpsUrl, { signal: controller.signal });
    if (response.ok) {
      const text = await response.text();
      return parseToml(text);
    }

    // Fallback to HTTP
    const httpUrl = `http://${domain}/.well-known/stellar.toml`;
    const httpResponse = await fetch(httpUrl, { signal: controller.signal });
    if (httpResponse.ok) {
      const text = await httpResponse.text();
      return parseToml(text);
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseToml(text: string): StellarTomlRecord {
  const result: StellarTomlRecord = {};
  const lines = text.split('\n');
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toUpperCase();
      continue;
    }

    const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let value = kvMatch[2].trim();

      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (currentSection === 'FEDERATION_SERVER') {
        result.FEDERATION_SERVER = value;
      } else if (currentSection === 'DOCUMENTATION') {
        result.DOCUMENTATION = result.DOCUMENTATION || {};
        (result.DOCUMENTATION as Record<string, string>)[key] = value;
      }
    }
  }

  return result;
}

async function resolveFederationAddress(
  username: string,
  domain: string,
  federationServer: string,
  timeoutMs: number,
): Promise<FederationRecord | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(federationServer);
    url.searchParams.set('q', `${username}*${domain}`);
    url.searchParams.set('type', 'name');

    const response = await fetch(url.toString(), { signal: controller.signal });
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (data.account_id) {
      return {
        account_id: data.account_id,
        memo: data.memo,
        memo_type: data.memo_type,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function validateAccountId(accountId: string): ValidationResult {
  const errors: string[] = [];

  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    errors.push('Account ID is not a valid Ed25519 public key (must start with G)');
  }

  return {
    valid: errors.length === 0,
    accountId: errors.length === 0 ? accountId : null,
    errors,
  };
}

async function checkAccountExists(
  server: Horizon.Server,
  accountId: string,
): Promise<{ exists: boolean; homeDomain: string | null }> {
  try {
    const account = await server.loadAccount(accountId);
    return { exists: true, homeDomain: account.home_domain ?? null };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'response' in error) {
      const response = (error as { response?: { status?: number } }).response;
      if (response?.status === 404) {
        return { exists: false, homeDomain: null };
      }
    }
    throw error;
  }
}

export async function resolveAndValidate(
  stellarAddress: string,
  horizonUrl: string,
  timeoutMs: number,
): Promise<FederationResolutionResult> {
  const parsed = parseStellarAddress(stellarAddress);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!parsed) {
    return {
      stellarAddress,
      domain: '',
      federationServer: null,
      resolved: false,
      accountId: null,
      memo: null,
      memoType: null,
      accountExists: false,
      accountHomeDomain: null,
      stellarToml: null,
      errors: ['Invalid stellar address format. Expected format: username*domain.com or username@domain.com'],
      warnings: [],
    };
  }

  const { username, domain } = parsed;

  // Fetch stellar.toml
  const stellarToml = await fetchStellarToml(domain, timeoutMs);

  if (!stellarToml) {
    errors.push(`Could not fetch stellar.toml from ${domain}`);
    return {
      stellarAddress,
      domain,
      federationServer: null,
      resolved: false,
      accountId: null,
      memo: null,
      memoType: null,
      accountExists: false,
      accountHomeDomain: null,
      stellarToml: null,
      errors,
      warnings,
    };
  }

  const federationServer = stellarToml.FEDERATION_SERVER ?? null;

  if (!federationServer) {
    errors.push(`No FEDERATION_SERVER defined in stellar.toml for ${domain}`);
    return {
      stellarAddress,
      domain,
      federationServer: null,
      resolved: false,
      accountId: null,
      memo: null,
      memoType: null,
      accountExists: false,
      accountHomeDomain: null,
      stellarToml,
      errors,
      warnings,
    };
  }

  // Resolve via federation
  const federationRecord = await resolveFederationAddress(username, domain, federationServer, timeoutMs);

  if (!federationRecord) {
    errors.push(`Federation resolution failed for ${username}*${domain}`);
    return {
      stellarAddress,
      domain,
      federationServer,
      resolved: false,
      accountId: null,
      memo: null,
      memoType: null,
      accountExists: false,
      accountHomeDomain: null,
      stellarToml,
      errors,
      warnings,
    };
  }

  // Validate resolved account ID
  const validation = validateAccountId(federationRecord.account_id);

  if (!validation.valid) {
    errors.push(...validation.errors);
    return {
      stellarAddress,
      domain,
      federationServer,
      resolved: true,
      accountId: federationRecord.account_id,
      memo: federationRecord.memo ?? null,
      memoType: federationRecord.memo_type ?? null,
      accountExists: false,
      accountHomeDomain: null,
      stellarToml,
      errors,
      warnings,
    };
  }

  // Check if account exists on network
  const server = new Horizon.Server(horizonUrl);
  const { exists, homeDomain } = await checkAccountExists(server, validation.accountId!);

  if (!exists) {
    warnings.push(`Account ${validation.accountId} does not exist on the network (may not be funded yet)`);
  }

  if (homeDomain && homeDomain !== domain) {
    warnings.push(`Account home domain (${homeDomain}) differs from federation domain (${domain})`);
  }

  return {
    stellarAddress,
    domain,
    federationServer,
    resolved: true,
    accountId: validation.accountId,
    memo: federationRecord.memo ?? null,
    memoType: federationRecord.memo_type ?? null,
    accountExists: exists,
    accountHomeDomain: homeDomain,
    stellarToml,
    errors,
    warnings,
  };
}

export async function run(params: Sep2FederationParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const timeoutMs = readNonNegativeInt(
    params.timeoutMs ?? process.env.FEDERATION_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    'timeoutMs',
  );
  const json = wantsJson(params);

  const stellarAddress =
    params.stellarAddress?.trim() || process.env.STELLAR_ADDRESS?.trim() || params.domain?.trim() || params.accountId?.trim();

  if (!stellarAddress) {
    throw new Error(
      'Provide a Stellar address (username*domain.com) via --stellarAddress, STELLAR_ADDRESS env, or as a parameter.',
    );
  }

  if (!json) {
    console.log(chalk.bold('\nSEP-2 Federation Protocol Address Resolution and Validation'));
    console.log(chalk.gray(`Resolving: ${stellarAddress}`));
    console.log(chalk.gray(`Horizon: ${horizonUrl}`));
    console.log(chalk.gray(`Timeout: ${timeoutMs}ms\n`));
  }

  const result = await resolveAndValidate(stellarAddress, horizonUrl, timeoutMs);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.bold('\n=== Federation Resolution Result ==='));
  console.log(`Stellar Address:    ${result.stellarAddress}`);
  console.log(`Domain:             ${result.domain}`);
  console.log(`Federation Server:  ${result.federationServer ?? chalk.red('Not found')}`);

  if (!result.resolved) {
    console.log(chalk.red('\nResolution: FAILED'));
    result.errors.forEach((e) => console.log(chalk.red(`  ✗ ${e}`)));
    return;
  }

  console.log(chalk.green('\nResolution: SUCCESS'));
  console.log(`Resolved Account ID: ${result.accountId}`);
  console.log(`Memo:                ${result.memo ?? chalk.gray('(none)')}`);
  console.log(`Memo Type:           ${result.memoType ?? chalk.gray('(none)')}`);

  console.log(chalk.bold('\n--- Account Validation ---'));
  console.log(`Account Valid:       ${result.accountId ? chalk.green('Yes') : chalk.red('No')}`);
  console.log(`Account Exists:      ${result.accountExists ? chalk.green('Yes') : chalk.yellow('No (not funded)')}`);
  console.log(`Account Home Domain: ${result.accountHomeDomain ?? chalk.gray('Not set')}`);

  if (result.warnings.length > 0) {
    console.log(chalk.bold('\n--- Warnings ---'));
    result.warnings.forEach((w) => console.log(chalk.yellow(`  ⚠ ${w}`)));
  }

  if (result.errors.length > 0) {
    console.log(chalk.bold('\n--- Errors ---'));
    result.errors.forEach((e) => console.log(chalk.red(`  ✗ ${e}`)));
  }

  if (result.stellarToml?.DOCUMENTATION) {
    const doc = result.stellarToml.DOCUMENTATION;
    console.log(chalk.bold('\n--- Organization Information (from stellar.toml) ---'));
    if (doc.ORG_NAME) console.log(`Organization:        ${doc.ORG_NAME}`);
    if (doc.ORG_URL) console.log(`Website:             ${doc.ORG_URL}`);
    if (doc.ORG_DESCRIPTION) console.log(`Description:         ${doc.ORG_DESCRIPTION}`);
    if (doc.ORG_OFFICIAL_EMAIL) console.log(`Official Email:      ${doc.ORG_OFFICIAL_EMAIL}`);
    if (doc.ORG_SUPPORT_EMAIL) console.log(`Support Email:       ${doc.ORG_SUPPORT_EMAIL}`);
    if (doc.ORG_KEYBASE) console.log(`Keybase:             ${doc.ORG_KEYBASE}`);
    if (doc.ORG_TWITTER) console.log(`Twitter:             ${doc.ORG_TWITTER}`);
    if (doc.ORG_GITHUB) console.log(`GitHub:              ${doc.ORG_GITHUB}`);
  }

  console.log(chalk.bold.green('\nSEP-2 Federation resolution complete.'));
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}