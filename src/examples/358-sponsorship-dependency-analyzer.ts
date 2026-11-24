import { Horizon, StrKey } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const PAGE_LIMIT = 100;

export interface SponsorshipFields {
  accountId: string;
  /** Sponsor of the account entry itself, when the account entry is sponsored. */
  accountSponsor: string | null;
  /** Reserve units paid by this account for other accounts (num_sponsoring). */
  numSponsoring: number | null;
  /** Reserve units paid by others for this account (num_sponsored). */
  numSponsored: number | null;
  missingFields: string[];
}

export interface SponsorshipEdge {
  key: string;
  from: string;
  to: string;
  entryType: string;
  direction: 'outgoing' | 'incoming';
  source: 'horizon-account' | 'horizon-effect';
}

export interface SponsorshipGraph {
  inspectedAccount: string;
  network: string;
  nodes: string[];
  edges: SponsorshipEdge[];
  /** True only when every relevant data source was retrieved successfully. */
  complete: boolean;
  warnings: string[];
}

export interface SponsorshipReport extends SponsorshipGraph {
  fields: SponsorshipFields;
  summary: {
    outgoingEdges: number;
    incomingEdges: number;
    entriesByType: Record<string, number>;
    reserveUnitsSponsoring: number | null;
    reserveUnitsSponsored: number | null;
    /** Deliberately absent: a graph is not a monetary reserve calculation. */
    definitiveReserveXlm: null;
  };
  risks: string[];
}

export interface SponsorshipEffectLike {
  type?: string;
  account?: string;
  sponsor?: string;
}

export function validateAccountId(value: string | undefined): string {
  const accountId = (value ?? '').trim();
  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    throw new Error('Expected a valid Stellar G... account public key.');
  }
  return accountId;
}

/**
 * Reads the documented Horizon sponsorship fields. Missing counters are kept as
 * null so callers can never mistake unavailable data for a zero balance.
 */
export function readSponsorshipFields(account: Horizon.AccountResponse): SponsorshipFields {
  const raw = account as Horizon.AccountResponse & {
    sponsor?: unknown;
    num_sponsoring?: unknown;
    num_sponsored?: unknown;
  };
  const missingFields: string[] = [];

  const toCount = (name: 'num_sponsoring' | 'num_sponsored'): number | null => {
    const value = raw[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      missingFields.push(name);
      return null;
    }
    return value;
  };

  const sponsor = raw.sponsor;
  if (sponsor !== undefined && sponsor !== null && typeof sponsor !== 'string') {
    missingFields.push('sponsor');
  }

  return {
    accountId: account.account_id,
    accountSponsor: typeof sponsor === 'string' ? sponsor : null,
    numSponsoring: toCount('num_sponsoring'),
    numSponsored: toCount('num_sponsored'),
    missingFields,
  };
}

/**
 * Builds a directed graph. An edge runs from the sponsor to the sponsored
 * account, which makes outgoing edges from the inspected account its
 * dependencies and incoming edges its reserve relief. Duplicate relationships
 * (including repeated effect pages) collapse to a single edge.
 */
export function buildSponsorshipGraph(
  inspectedAccount: string,
  fields: SponsorshipFields,
  effects: SponsorshipEffectLike[],
  options: { effectsComplete: boolean; network?: string } = { effectsComplete: false },
): SponsorshipGraph {
  const edges = new Map<string, SponsorshipEdge>();
  const warnings: string[] = [];

  const addEdge = (
    from: string,
    to: string,
    entryType: string,
    source: SponsorshipEdge['source'],
  ): void => {
    if (!from || !to || from === 'unknown' || to === 'unknown') return;
    const key = `${from}|${to}|${entryType}`;
    if (edges.has(key)) return;
    edges.set(key, {
      key,
      from,
      to,
      entryType,
      direction: from === inspectedAccount ? 'outgoing' : 'incoming',
      source,
    });
  };

  if (fields.accountSponsor) {
    addEdge(
      fields.accountSponsor,
      inspectedAccount,
      'account',
      'horizon-account',
    );
  }

  for (const effect of effects) {
    if (!effect.type?.endsWith('_sponsorship_created')) continue;
    const entryType = effect.type.replace(/_sponsorship_created$/, '').replace(/_/g, ' ');
    addEdge(effect.sponsor ?? '', effect.account ?? '', entryType, 'horizon-effect');
  }

  for (const field of fields.missingFields) {
    warnings.push(`Horizon account field "${field}" was unavailable; counters may be incomplete.`);
  }

  if (!options.effectsComplete) {
    warnings.push('Ledger-entry effects were not fully retrieved; the graph is not exhaustive.');
  }

  if (fields.numSponsoring === null || fields.numSponsored === null) {
    warnings.push('Reserve counters are incomplete; no reserve conclusion can be drawn.');
  } else if (
    edges.size > 0 &&
    edges.filter((edge) => edge.direction === 'outgoing').length !== fields.numSponsoring
  ) {
    warnings.push(
      'The discovered outgoing edges do not match num_sponsoring; additional ledger-entry inspection is required.',
    );
  }

  const nodes = new Set<string>([inspectedAccount]);
  for (const edge of edges.values()) {
    nodes.add(edge.from);
    nodes.add(edge.to);
  }

  return {
    inspectedAccount,
    network: options.network ?? process.env.STELLAR_NETWORK ?? 'testnet',
    nodes: [...nodes],
    edges: [...edges.values()],
    complete: options.effectsComplete && fields.missingFields.length === 0,
    warnings,
  };
}

export function buildSponsorshipReport(
  graph: SponsorshipGraph,
  fields: SponsorshipFields,
): SponsorshipReport {
  const entriesByType: Record<string, number> = {};
  for (const edge of graph.edges) {
    entriesByType[edge.entryType] = (entriesByType[edge.entryType] ?? 0) + 1;
  }

  const risks: string[] = [];
  if (graph.edges.some((edge) => edge.direction === 'incoming')) {
    risks.push('Other accounts cover reserves for this account; ending sponsorship may require their consent.');
  }
  if (graph.edges.some((edge) => edge.direction === 'outgoing')) {
    risks.push('This account covers reserves for other accounts; merging or deleting it needs those entries resolved first.');
  }
  if (!graph.complete) {
    risks.push('Incomplete data: inspect full ledger-entry sponsorship metadata before modifying the account.');
  }

  return {
    ...graph,
    fields,
    summary: {
      outgoingEdges: graph.edges.filter((edge) => edge.direction === 'outgoing').length,
      incomingEdges: graph.edges.filter((edge) => edge.direction === 'incoming').length,
      entriesByType,
      reserveUnitsSponsoring: fields.numSponsoring,
      reserveUnitsSponsored: fields.numSponsored,
      definitiveReserveXlm: null,
    },
    risks,
  };
}

export function formatTextReport(report: SponsorshipReport): string {
  const lines = [
    '=== Stellar Sponsorship Dependency Analyzer ===',
    `Inspected account: ${report.inspectedAccount}`,
    `Network: ${report.network}`,
    `Graph exhaustive: ${report.complete ? 'yes' : 'no'}`,
    '',
    `Accounts involved (${report.nodes.length}):`,
    ...report.nodes.map((node) => `  - ${node}`),
    '',
    `Sponsorship edges (${report.edges.length}):`,
  ];

  if (report.edges.length === 0) {
    lines.push('  No sponsorship relationships were discovered.');
  } else {
    for (const edge of report.edges) {
      lines.push(
        `  - [${edge.direction}] ${edge.from} -> ${edge.to} (${edge.entryType}; source: ${edge.source})`,
      );
    }
  }

  lines.push(
    '',
    `Reserve units sponsoring: ${report.summary.reserveUnitsSponsoring ?? 'unavailable'}`,
    `Reserve units sponsored: ${report.summary.reserveUnitsSponsored ?? 'unavailable'}`,
    'Definitive reserve: not calculated (depends on current network rules and full ledger state).',
    '',
    'Warnings:',
    ...(report.warnings.length ? report.warnings.map((warning) => `  - ${warning}`) : ['  none']),
    '',
    'Potential risks:',
    ...(report.risks.length ? report.risks.map((risk) => `  - ${risk}`) : ['  none']),
  );

  return lines.join('\n');
}

export function toJson(report: SponsorshipReport): string {
  return JSON.stringify(report, null, 2);
}

/** Loads sponsorship effects for an account, bounded and explicit about gaps. */
async function fetchEffects(
  server: Horizon.Server,
  accountId: string,
): Promise<{ effects: SponsorshipEffectLike[]; complete: boolean }> {
  const effects: SponsorshipEffectLike[] = [];
  const page = (await server
    .effects()
    .forAccount(accountId)
    .limit(PAGE_LIMIT)
    .order('asc')
    .call()) as unknown as {
    records: SponsorshipEffectLike[];
    next: () => Promise<{ records: SponsorshipEffectLike[] }>;
  };
  effects.push(...page.records);
  if (page.records.length < PAGE_LIMIT) return { effects, complete: true };

  // A full page means more data may exist. Follow Horizon's next page link; if
  // that fails, records are still reported but the graph is marked incomplete.
  try {
    const nextPage = await page.next();
    effects.push(...nextPage.records);
    return { effects, complete: nextPage.records.length < PAGE_LIMIT };
  } catch {
    return { effects, complete: false };
  }
}

export async function run(params: { accountId?: string; json?: boolean } = {}): Promise<void> {
  const accountId = validateAccountId(
    params.accountId ?? process.env.ACCOUNT_ID ?? process.argv[3],
  );
  const horizonUrl = process.env.HORIZON_URL ?? DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const asJson = params.json === true || process.env.JSON_OUTPUT === 'true';

  let account: Horizon.AccountResponse;
  try {
    account = await server.loadAccount(accountId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not retrieve account ${accountId} from Horizon: ${message}`);
  }

  const fields = readSponsorshipFields(account);
  let effects: SponsorshipEffectLike[] = [];
  let complete = fields.missingFields.length === 0;
  try {
    const result = await fetchEffects(server, accountId);
    effects = result.effects;
    complete = complete && result.complete;
  } catch (error) {
    complete = false;
    fields.missingFields.push('effects');
    console.error(
      `Warning: could not retrieve sponsorship effects: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const graph = buildSponsorshipGraph(accountId, fields, effects, {
    effectsComplete: complete,
    network: horizonUrl,
  });
  const report = buildSponsorshipReport(graph, fields);

  console.log(asJson ? toJson(report) : formatTextReport(report));
}
