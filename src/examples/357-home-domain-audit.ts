import { Horizon, StrKey } from '@stellar/stellar-sdk';
import chalk from 'chalk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * ISSUE-357: Stellar Account Home-Domain Verification and Organization Identity Audit
 *
 * This example performs a comprehensive audit of a Stellar account's home domain
 * configuration and organization identity. It verifies:
 * 1. The account has a home domain set
 * 2. The home domain's stellar.toml exists and is valid
 * 3. The stellar.toml contains proper organization documentation
 * 4. The federation server (if advertised) is reachable
 * 5. The domain matches the account's home_domain field
 * 6. SEP-10 authentication endpoint (if advertised)
 * 6. SEP-24 deposit/withdrawal endpoints (if advertised)
 * 7. Currency information published by the organization
 *
 * This provides a complete identity audit for compliance and trust verification.
 */

export interface HomeDomainAuditParams {
  accountId?: string;
  domain?: string;
  horizonUrl?: string;
  timeoutMs?: string | number;
  json?: boolean | string;
  deepAudit?: boolean | string;
}

export interface StellarTomlRecord {
  FEDERATION_SERVER?: string;
  TRANSFER_SERVER?: string;
  WEB_AUTH_ENDPOINT?: string;
  SIGNING_KEY?: string;
  VALIDATORS?: string[];
  CURRENCIES?: Array<{
    code: string;
    issuer: string;
    status?: string;
    display_decimals?: number;
    name?: string;
    desc?: string;
    conditions?: string;
    image?: string;
    fixed_number?: number;
    max_number?: number;
    is_unlimited?: boolean;
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

export interface AuditCheck {
  name: string;
  passed: boolean;
  severity: 'error' | 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

export interface HomeDomainAuditReport {
  accountId: string | null;
  requestedDomain: string | null;
  accountHomeDomain: string | null;
  domainMatch: boolean;
  stellarToml: StellarTomlRecord | null;
  tomlValid: boolean;
  checks: AuditCheck[];
  passedChecks: number;
  totalChecks: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  overallStatus: 'pass' | 'warning' | 'fail';
  federationReachable: boolean | null;
  transferServerReachable: boolean | null;
  webAuthReachable: boolean | null;
}

function wantsJson(params: HomeDomainAuditParams): boolean {
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

function parseBoolean(value: string | number | boolean | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0;
  return false;
}

function validateAccountId(accountId: string): { valid: boolean; error?: string } {
  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    return { valid: false, error: 'Account ID must be a valid Ed25519 public key (starting with G)' };
  }
  return { valid: true };
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
  let inArray = false;
  let arrayItems: Record<string, string>[] = [];
  let currentArrayItem: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const sectionMatch = trimmed.match(/^\[\[(.+)\]\]$/);
    if (sectionMatch) {
      if (inArray && Object.keys(currentArrayItem).length > 0) {
        arrayItems.push(currentArrayItem);
        currentArrayItem = {};
      }
      currentSection = sectionMatch[1].toUpperCase();
      inArray = true;
      if (!result[currentSection as keyof StellarTomlRecord]) {
        (result as Record<string, unknown>)[currentSection] = [];
      }
      continue;
    }

    const sectionMatchSingle = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatchSingle) {
      if (inArray && Object.keys(currentArrayItem).length > 0) {
        arrayItems.push(currentArrayItem);
        currentArrayItem = {};
      }
      inArray = false;
      currentSection = sectionMatchSingle[1].toUpperCase();
      continue;
    }

    const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let value = kvMatch[2].trim();

      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (inArray) {
        currentArrayItem[key] = value;
      } else {
        if (currentSection === 'DOCUMENTATION') {
          result.DOCUMENTATION = result.DOCUMENTATION || {};
          (result.DOCUMENTATION as Record<string, string>)[key] = value;
        } else if (currentSection === 'PRINCIPALS') {
          // Handle principals array
        } else {
          (result as Record<string, unknown>)[currentSection] = value;
        }
      }
    }
  }

  if (inArray && Object.keys(currentArrayItem).length > 0) {
    arrayItems.push(currentArrayItem);
  }

  // Assign arrays
  if (arrayItems.length > 0) {
    if (currentSection === 'CURRENCIES') {
      result.CURRENCIES = arrayItems as StellarTomlRecord['CURRENCIES'];
    } else if (currentSection === 'PRINCIPALS') {
      result.PRINCIPALS = arrayItems as StellarTomlRecord['PRINCIPALS'];
    }
  }

  return result;
}

async function checkEndpoint(url: string | undefined, timeoutMs: number): Promise<boolean> {
  if (!url) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    return response.ok || response.status === 405 || response.status === 404; // 404 means endpoint exists but path not found
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAccountHomeDomain(
  server: Horizon.Server,
  accountId: string,
): Promise<string | null> {
  try {
    const account = await server.loadAccount(accountId);
    return account.home_domain ?? null;
  } catch {
    return null;
  }
}

function runAuditChecks(
  accountId: string | null,
  requestedDomain: string | null,
  accountHomeDomain: string | null,
  stellarToml: StellarTomlRecord | null,
  tomlValid: boolean,
  deepAudit: boolean,
  timeoutMs: number,
): Promise<{
  checks: AuditCheck[];
  federationReachable: boolean | null;
  transferServerReachable: boolean | null;
  webAuthReachable: boolean | null;
}> {
  const checks: AuditCheck[] = [];

  // Check 1: Account has home domain set
  checks.push({
    name: 'Home Domain Set',
    passed: !!accountHomeDomain,
    severity: 'error',
    message: accountHomeDomain
      ? `Account has home domain: ${accountHomeDomain}`
      : 'Account does not have a home domain configured',
    details: { homeDomain: accountHomeDomain },
  });

  // Check 2: Domain match (if both provided)
  const domainMatch = accountHomeDomain && requestedDomain && accountHomeDomain === requestedDomain;
  checks.push({
    name: 'Domain Consistency',
    passed: domainMatch || (!accountHomeDomain && !requestedDomain),
    severity: 'error',
    message: domainMatch
      ? `Requested domain matches account home domain: ${accountHomeDomain}`
      : accountHomeDomain && requestedDomain
      ? `Domain mismatch: account has ${accountHomeDomain}, requested ${requestedDomain}`
      : 'Cannot verify domain consistency (missing account home domain or requested domain)',
    details: { accountHomeDomain, requestedDomain },
  });

  // Check 3: stellar.toml exists
  checks.push({
    name: 'stellar.toml Exists',
    passed: tomlValid,
    severity: 'error',
    message: tomlValid ? 'stellar.toml fetched and parsed successfully' : 'stellar.toml not found or invalid',
    details: { domain: accountHomeDomain ?? requestedDomain },
  });

  if (!tomlValid || !stellarToml) {
    return Promise.resolve({
      checks,
      federationReachable: null,
      transferServerReachable: null,
      webAuthReachable: null,
    });
  }

  // Check 4: Organization documentation
  const doc = stellarToml.DOCUMENTATION;
  const hasOrgName = !!doc?.ORG_NAME;
  const hasOrgUrl = !!doc?.ORG_URL;
  const hasOrgDesc = !!doc?.ORG_DESCRIPTION;
  const hasContactEmail = !!doc?.ORG_OFFICIAL_EMAIL || !!doc?.ORG_SUPPORT_EMAIL;

  checks.push({
    name: 'Organization Name',
    passed: hasOrgName,
    severity: 'warning',
    message: hasOrgName ? `Organization name: ${doc!.ORG_NAME}` : 'ORG_NAME not specified in stellar.toml',
    details: { orgName: doc?.ORG_NAME },
  });

  checks.push({
    name: 'Organization URL',
    passed: hasOrgUrl,
    severity: 'warning',
    message: hasOrgUrl ? `Organization URL: ${doc!.ORG_URL}` : 'ORG_URL not specified in stellar.toml',
    details: { orgUrl: doc?.ORG_URL },
  });

  checks.push({
    name: 'Organization Description',
    passed: hasOrgDesc,
    severity: 'info',
    message: hasOrgDesc ? 'ORG_DESCRIPTION present' : 'ORG_DESCRIPTION not specified',
    details: { orgDescription: doc?.ORG_DESCRIPTION },
  });

  checks.push({
    name: 'Contact Email',
    passed: hasContactEmail,
    severity: 'warning',
    message: hasContactEmail
      ? `Contact email(s): ${[doc?.ORG_OFFICIAL_EMAIL, doc?.ORG_SUPPORT_EMAIL].filter(Boolean).join(', ')}`
      : 'No contact email specified (ORG_OFFICIAL_EMAIL or ORG_SUPPORT_EMAIL)',
    details: { officialEmail: doc?.ORG_OFFICIAL_EMAIL, supportEmail: doc?.ORG_SUPPORT_EMAIL },
  });

  // Check 5: Federation server
  const hasFederation = !!stellarToml.FEDERATION_SERVER;
  checks.push({
    name: 'Federation Server Advertised',
    passed: hasFederation,
    severity: 'info',
    message: hasFederation
      ? `Federation server: ${stellarToml.FEDERATION_SERVER}`
      : 'FEDERATION_SERVER not advertised (SEP-2 not supported)',
    details: { federationServer: stellarToml.FEDERATION_SERVER },
  });

  // Check 6: Transfer server (SEP-24)
  const hasTransfer = !!stellarToml.TRANSFER_SERVER;
  checks.push({
    name: 'Transfer Server (SEP-24)',
    passed: hasTransfer,
    severity: 'info',
    message: hasTransfer
      ? `Transfer server: ${stellarToml.TRANSFER_SERVER}`
      : 'TRANSFER_SERVER not advertised (SEP-24 not supported)',
    details: { transferServer: stellarToml.TRANSFER_SERVER },
  });

  // Check 7: Web auth endpoint (SEP-10)
  const hasWebAuth = !!stellarToml.WEB_AUTH_ENDPOINT;
  checks.push({
    name: 'Web Auth Endpoint (SEP-10)',
    passed: hasWebAuth,
    severity: 'info',
    message: hasWebAuth
      ? `Web auth endpoint: ${stellarToml.WEB_AUTH_ENDPOINT}`
      : 'WEB_AUTH_ENDPOINT not advertised (SEP-10 not supported)',
    details: { webAuthEndpoint: stellarToml.WEB_AUTH_ENDPOINT },
  });

  // Check 8: Signing key
  const hasSigningKey = !!stellarToml.SIGNING_KEY;
  checks.push({
    name: 'Signing Key',
    passed: hasSigningKey,
    severity: 'info',
    message: hasSigningKey
      ? `Signing key: ${stellarToml.SIGNING_KEY}`
      : 'SIGNING_KEY not specified',
    details: { signingKey: stellarToml.SIGNING_KEY },
  });

  // Check 9: Validators
  const hasValidators = !!stellarToml.VALIDATORS && stellarToml.VALIDATORS!.length > 0;
  checks.push({
    name: 'Validators List',
    passed: hasValidators,
    severity: 'info',
    message: hasValidators
      ? `Validators: ${stellarToml.VALIDATORS!.join(', ')}`
      : 'VALIDATORS not specified',
    details: { validators: stellarToml.VALIDATORS },
  });

  // Check 10: Currencies
  const currencies = stellarToml.CURRENCIES ?? [];
  checks.push({
    name: 'Published Currencies',
    passed: currencies.length > 0,
    severity: 'info',
    message: currencies.length > 0
      ? `${currencies.length} currency(ies) published`
      : 'No currencies published in stellar.toml',
    details: { currencies: currencies.map((c) => `${c.code}:${c.issuer}`) },
  });

  // Deep audit: check endpoint reachability
  let federationReachable: boolean | null = null;
  let transferServerReachable: boolean | null = null;
  let webAuthReachable: boolean | null = null;

  if (deepAudit) {
    // These are async but we'll run them synchronously in the caller
    // For now, we'll add placeholders and run them in the main function
  }

  return Promise.resolve({
    checks,
    federationReachable: null,
    transferServerReachable: null,
    webAuthReachable: null,
  });
}

async function runDeepAudit(
  stellarToml: StellarTomlRecord,
  timeoutMs: number,
): Promise<{ federationReachable: boolean; transferServerReachable: boolean; webAuthReachable: boolean }> {
  const [federationReachable, transferServerReachable, webAuthReachable] = await Promise.all([
    checkEndpoint(stellarToml.FEDERATION_SERVER, timeoutMs),
    checkEndpoint(stellarToml.TRANSFER_SERVER, timeoutMs),
    checkEndpoint(stellarToml.WEB_AUTH_ENDPOINT, timeoutMs),
  ]);

  return { federationReachable, transferServerReachable, webAuthReachable };
}

export async function run(params: HomeDomainAuditParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const timeoutMs = readNonNegativeInt(
    params.timeoutMs ?? process.env.AUDIT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    'timeoutMs',
  );
  const deepAudit = parseBoolean(params.deepAudit ?? process.env.DEEP_AUDIT);
  const json = wantsJson(params);

  const accountIdInput = params.accountId?.trim() || process.env.ACCOUNT_ID?.trim();
  const domainInput = params.domain?.trim() || process.env.HOME_DOMAIN?.trim();

  if (!json) {
    console.log(chalk.bold('\nStellar Account Home-Domain Verification and Organization Identity Audit'));
    console.log(chalk.gray(`Horizon: ${horizonUrl}`));
    console.log(chalk.gray(`Timeout: ${timeoutMs}ms`));
    console.log(chalk.gray(`Deep audit: ${deepAudit ? 'enabled' : 'disabled'}\n`));
  }

  let accountId: string | null = null;
  let accountHomeDomain: string | null = null;

  // If account ID provided, fetch its home domain
  if (accountIdInput) {
    const validation = validateAccountId(accountIdInput);
    if (!validation.valid) {
      const error = `Invalid account ID: ${validation.error}`;
      if (json) console.log(JSON.stringify({ error }));
      else console.error(chalk.red(error));
      return;
    }
    accountId = accountIdInput;

    const server = new Horizon.Server(horizonUrl);
    accountHomeDomain = await fetchAccountHomeDomain(server, accountId);
  }

  // Determine the domain to audit
  const domainToAudit = accountHomeDomain || domainInput;

  if (!domainToAudit) {
    const error = 'No domain to audit. Provide an account ID (with home domain set) or a domain directly.';
    if (json) console.log(JSON.stringify({ error }));
    else console.error(chalk.red(error));
    return;
  }

  // Fetch stellar.toml
  const stellarToml = await fetchStellarToml(domainToAudit, timeoutMs);
  const tomlValid = stellarToml !== null;

  // Run basic checks
  const { checks } = await runAuditChecks(
    accountId,
    domainInput ?? null,
    accountHomeDomain,
    stellarToml,
    tomlValid,
    deepAudit,
    timeoutMs,
  );

  // Run deep audit if enabled
  let federationReachable: boolean | null = null;
  let transferServerReachable: boolean | null = null;
  let webAuthReachable: boolean | null = null;

  if (deepAudit && tomlValid && stellarToml) {
    if (!json) console.log(chalk.gray('\nPerforming deep audit (endpoint reachability)...'));
    const deepResults = await runDeepAudit(stellarToml, timeoutMs);
    federationReachable = deepResults.federationReachable;
    transferServerReachable = deepResults.transferServerReachable;
    webAuthReachable = deepResults.webAuthReachable;

    // Add reachability checks
    if (stellarToml.FEDERATION_SERVER) {
      checks.push({
        name: 'Federation Server Reachable',
        passed: federationReachable,
        severity: federationReachable ? 'info' : 'warning',
        message: federationReachable
          ? `Federation server reachable: ${stellarToml.FEDERATION_SERVER}`
          : `Federation server unreachable: ${stellarToml.FEDERATION_SERVER}`,
        details: { url: stellarToml.FEDERATION_SERVER },
      });
    }

    if (stellarToml.TRANSFER_SERVER) {
      checks.push({
        name: 'Transfer Server Reachable',
        passed: transferServerReachable,
        severity: transferServerReachable ? 'info' : 'warning',
        message: transferServerReachable
          ? `Transfer server reachable: ${stellarToml.TRANSFER_SERVER}`
          : `Transfer server unreachable: ${stellarToml.TRANSFER_SERVER}`,
        details: { url: stellarToml.TRANSFER_SERVER },
      });
    }

    if (stellarToml.WEB_AUTH_ENDPOINT) {
      checks.push({
        name: 'Web Auth Endpoint Reachable',
        passed: webAuthReachable,
        severity: webAuthReachable ? 'info' : 'warning',
        message: webAuthReachable
          ? `Web auth endpoint reachable: ${stellarToml.WEB_AUTH_ENDPOINT}`
          : `Web auth endpoint unreachable: ${stellarToml.WEB_AUTH_ENDPOINT}`,
        details: { url: stellarToml.WEB_AUTH_ENDPOINT },
      });
    }
  }

  // Calculate summary
  const passedChecks = checks.filter((c) => c.passed).length;
  const totalChecks = checks.length;
  const errorCount = checks.filter((c) => c.severity === 'error' && !c.passed).length;
  const warningCount = checks.filter((c) => c.severity === 'warning' && !c.passed).length;
  const infoCount = checks.filter((c) => c.severity === 'info' && !c.passed).length;

  let overallStatus: 'pass' | 'warning' | 'fail' = 'pass';
  if (errorCount > 0) overallStatus = 'fail';
  else if (warningCount > 0) overallStatus = 'warning';

  const report: HomeDomainAuditReport = {
    accountId,
    requestedDomain: domainInput ?? null,
    accountHomeDomain,
    domainMatch: !!(accountHomeDomain && domainInput && accountHomeDomain === domainInput),
    stellarToml,
    tomlValid,
    checks,
    passedChecks,
    totalChecks,
    errorCount,
    warningCount,
    infoCount,
    overallStatus,
    federationReachable,
    transferServerReachable,
    webAuthReachable,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Print report
  console.log(chalk.bold('\n=== Home Domain Audit Report ==='));
  console.log(`Account ID:          ${accountId ?? chalk.gray('Not provided')}`);
  console.log(`Account Home Domain: ${accountHomeDomain ?? chalk.red('Not set')}`);
  console.log(`Audited Domain:      ${domainToAudit}`);
  console.log(`Domain Match:        ${report.domainMatch ? chalk.green('Yes') : accountHomeDomain && domainInput ? chalk.red('No') : chalk.gray('N/A')}`);
  console.log(`stellar.toml:        ${tomlValid ? chalk.green('Valid') : chalk.red('Missing/Invalid')}`);

  console.log(chalk.bold('\n--- Audit Checks ---'));
  for (const check of checks) {
    const icon = check.passed ? chalk.green('✓') : check.severity === 'error' ? chalk.red('✗') : check.severity === 'warning' ? chalk.yellow('⚠') : chalk.blue('ℹ');
    const severityLabel = check.severity.toUpperCase().padEnd(7);
    console.log(`  ${icon} [${severityLabel}] ${check.name}: ${check.message}`);
  }

  console.log(chalk.bold('\n--- Summary ---'));
  console.log(`Checks passed: ${passedChecks} / ${totalChecks}`);
  console.log(`Errors:        ${errorCount}`);
  console.log(`Warnings:      ${warningCount}`);
  console.log(`Info:          ${infoCount}`);
  console.log(`Overall:       ${overallStatus === 'pass' ? chalk.green('PASS') : overallStatus === 'warning' ? chalk.yellow('WARNING') : chalk.red('FAIL')}`);

  if (stellarToml?.DOCUMENTATION) {
    const doc = stellarToml.DOCUMENTATION;
    console.log(chalk.bold('\n--- Organization Identity ---'));
    if (doc.ORG_NAME) console.log(`Name:        ${doc.ORG_NAME}`);
    if (doc.ORG_URL) console.log(`Website:     ${doc.ORG_URL}`);
    if (doc.ORG_LOGO) console.log(`Logo:        ${doc.ORG_LOGO}`);
    if (doc.ORG_DESCRIPTION) console.log(`Description: ${doc.ORG_DESCRIPTION}`);
    if (doc.ORG_OFFICIAL_EMAIL) console.log(`Official:    ${doc.ORG_OFFICIAL_EMAIL}`);
    if (doc.ORG_SUPPORT_EMAIL) console.log(`Support:     ${doc.ORG_SUPPORT_EMAIL}`);
    if (doc.ORG_KEYBASE) console.log(`Keybase:     ${doc.ORG_KEYBASE}`);
    if (doc.ORG_TWITTER) console.log(`Twitter:     ${doc.ORG_TWITTER}`);
    if (doc.ORG_GITHUB) console.log(`GitHub:      ${doc.ORG_GITHUB}`);
  }

  if (stellarToml?.PRINCIPALS && stellarToml.PRINCIPALS.length > 0) {
    console.log(chalk.bold('\n--- Principals ---'));
    stellarToml.PRINCIPALS.forEach((p) => {
      console.log(`  ${p.name} (${p.email})${p.keybase ? ` [Keybase: ${p.keybase}]` : ''}${p.twitter ? ` [Twitter: ${p.twitter}]` : ''}${p.github ? ` [GitHub: ${p.github}]` : ''}`);
    });
  }

  if (stellarToml?.CURRENCIES && stellarToml.CURRENCIES.length > 0) {
    console.log(chalk.bold('\n--- Published Currencies ---'));
    stellarToml.CURRENCIES.forEach((c) => {
      console.log(`  ${c.code} (${c.issuer})${c.name ? ` - ${c.name}` : ''}${c.status ? ` [${c.status}]` : ''}`);
    });
  }

  console.log(chalk.bold.green('\nHome-domain audit complete.'));
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}