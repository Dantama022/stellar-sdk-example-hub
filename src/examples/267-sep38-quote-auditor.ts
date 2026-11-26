export interface Sep38FeeDetail {
  name: string;
  amount: string;
  description?: string;
}

export interface Sep38Fee {
  total: string;
  asset: string;
  details?: Sep38FeeDetail[];
}

export interface Sep38QuoteResponse {
  id: string;
  expires_at: string;
  price: string;
  total_price?: string;
  sell_asset: string;
  sell_amount: string;
  buy_asset: string;
  buy_amount: string;
  fee?: Sep38Fee;
  sell_delivery_method?: string;
  buy_delivery_method?: string;
}

export interface QuoteAuditOptions {
  anchorService?: string;
  nowMs?: number;
  expirationWarningThresholdMs?: number;
  priceDiscrepancyTolerancePercent?: string;
}

export interface QuoteAuditResult {
  anchorService: string;
  quoteId: string | null;
  sellAsset: string | null;
  buyAsset: string | null;
  sellAmount: string | null;
  buyAmount: string | null;
  declaredPrice: string | null;
  calculatedEffectivePrice: string | null;
  priceDifferencePercent: string | null;
  fee: Sep38Fee | null;
  expiration: {
    expiresAt: string | null;
    status: 'valid' | 'approaching_expiration' | 'expired' | 'invalid_or_missing';
    remainingMs: number | null;
  };
  valid: boolean;
  warnings: string[];
  errors: string[];
  originalQuote: unknown;
}

export interface QuoteComparisonResult {
  targetSellAsset: string;
  targetBuyAsset: string;
  mostFavorableQuoteId: string | null;
  rankedQuotes: Array<{
    quoteId: string;
    normalizedBuyPerSell: string;
    feeTotal: string | null;
    feeAsset: string | null;
    originalDirection: 'same' | 'inverted';
  }>;
  excludedQuotes: Array<{ quoteId: string | null; reason: string }>;
}

export interface HttpJsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type QuoteFetcher = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<HttpJsonResponse>;

const DECIMAL_SCALE = 12;
const SCALE_FACTOR = 10n ** BigInt(DECIMAL_SCALE);

export function parseDecimalScaled(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid positive decimal string: "${value}"`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const padded = (frac + '0'.repeat(DECIMAL_SCALE)).slice(0, DECIMAL_SCALE);
  return BigInt(whole) * SCALE_FACTOR + BigInt(padded);
}

export function formatDecimalScaled(scaled: bigint, decimals = 7): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(DECIMAL_SCALE, '0').slice(0, decimals);
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export function divideScaled(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error('Division by zero in decimal calculation.');
  }
  return (numerator * SCALE_FACTOR) / denominator;
}

export async function fetchSep38Quote(
  anchorBaseUrl: string,
  quoteId: string,
  fetcher: QuoteFetcher = (url, init) => fetch(url, init) as Promise<HttpJsonResponse>,
  authToken?: string,
): Promise<Sep38QuoteResponse> {
  const cleanBase = anchorBaseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/quote/${encodeURIComponent(quoteId)}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const res = await fetcher(url, { method: 'GET', headers });
  if (!res.ok) {
    throw new Error(`SEP-38 anchor returned HTTP ${res.status} for quote ${quoteId}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('SEP-38 anchor returned malformed JSON.');
  }

  if (!body || typeof body !== 'object') {
    throw new Error('SEP-38 quote response was not a JSON object.');
  }
  return body as Sep38QuoteResponse;
}

export function auditSep38Quote(
  rawQuote: unknown,
  options: QuoteAuditOptions = {},
): QuoteAuditResult {
  const anchorService = options.anchorService ?? 'unspecified-anchor';
  const nowMs = options.nowMs ?? Date.now();
  const warningThresholdMs = options.expirationWarningThresholdMs ?? 60_000;
  const tolerancePercent = parseDecimalScaled(options.priceDiscrepancyTolerancePercent ?? '1.0');

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!rawQuote || typeof rawQuote !== 'object') {
    return {
      anchorService,
      quoteId: null,
      sellAsset: null,
      buyAsset: null,
      sellAmount: null,
      buyAmount: null,
      declaredPrice: null,
      calculatedEffectivePrice: null,
      priceDifferencePercent: null,
      fee: null,
      expiration: { expiresAt: null, status: 'invalid_or_missing', remainingMs: null },
      valid: false,
      warnings: [],
      errors: ['Quote payload is missing or not a JSON object.'],
      originalQuote: rawQuote,
    };
  }

  const q = rawQuote as Partial<Sep38QuoteResponse>;
  const requiredFields: Array<keyof Sep38QuoteResponse> = [
    'id',
    'expires_at',
    'price',
    'sell_asset',
    'sell_amount',
    'buy_asset',
    'buy_amount',
  ];

  for (const field of requiredFields) {
    const val = q[field];
    if (typeof val !== 'string' || val.trim() === '') {
      errors.push(`Missing or invalid required SEP-38 field: "${field}".`);
    }
  }

  // Expiration check
  let expStatus: QuoteAuditResult['expiration']['status'] = 'invalid_or_missing';
  let remainingMs: number | null = null;
  if (typeof q.expires_at === 'string' && q.expires_at.trim() !== '') {
    const parsedTime = Date.parse(q.expires_at);
    if (Number.isNaN(parsedTime)) {
      errors.push(`Invalid expires_at timestamp: "${q.expires_at}".`);
    } else {
      remainingMs = parsedTime - nowMs;
      if (remainingMs <= 0) {
        expStatus = 'expired';
        errors.push(`Quote expired ${Math.abs(remainingMs)} ms ago (${q.expires_at}).`);
      } else if (remainingMs <= warningThresholdMs) {
        expStatus = 'approaching_expiration';
        warnings.push(`Quote expires in ${remainingMs} ms (within ${warningThresholdMs} ms threshold).`);
      } else {
        expStatus = 'valid';
      }
    }
  }

  // Decimal-safe exchange rate calculation: SEP-38 price = sell_amount / buy_amount
  let calculatedEffectivePrice: string | null = null;
  let priceDifferencePercent: string | null = null;

  if (
    typeof q.sell_amount === 'string' &&
    typeof q.buy_amount === 'string' &&
    typeof q.price === 'string'
  ) {
    try {
      const sellScaled = parseDecimalScaled(q.sell_amount);
      const buyScaled = parseDecimalScaled(q.buy_amount);
      const declaredScaled = parseDecimalScaled(q.price);

      if (sellScaled <= 0n || buyScaled <= 0n || declaredScaled <= 0n) {
        errors.push('sell_amount, buy_amount, and price must all be strictly positive.');
      } else {
        const effectiveScaled = divideScaled(sellScaled, buyScaled);
        calculatedEffectivePrice = formatDecimalScaled(effectiveScaled, 7);

        const diff = effectiveScaled > declaredScaled
          ? effectiveScaled - declaredScaled
          : declaredScaled - effectiveScaled;
        const diffPercentScaled = divideScaled(diff * 100n, declaredScaled);
        priceDifferencePercent = formatDecimalScaled(diffPercentScaled, 4);

        if (diffPercentScaled > tolerancePercent) {
          warnings.push(
            `Effective price (${calculatedEffectivePrice}) differs from declared price (${q.price}) by ${priceDifferencePercent}%, exceeding ${options.priceDiscrepancyTolerancePercent ?? '1.0'}% tolerance.`,
          );
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    anchorService,
    quoteId: typeof q.id === 'string' ? q.id : null,
    sellAsset: typeof q.sell_asset === 'string' ? q.sell_asset : null,
    buyAsset: typeof q.buy_asset === 'string' ? q.buy_asset : null,
    sellAmount: typeof q.sell_amount === 'string' ? q.sell_amount : null,
    buyAmount: typeof q.buy_amount === 'string' ? q.buy_amount : null,
    declaredPrice: typeof q.price === 'string' ? q.price : null,
    calculatedEffectivePrice,
    priceDifferencePercent,
    fee: q.fee ?? null,
    expiration: {
      expiresAt: typeof q.expires_at === 'string' ? q.expires_at : null,
      status: expStatus,
      remainingMs,
    },
    valid: errors.length === 0,
    warnings,
    errors,
    originalQuote: rawQuote,
  };
}

export function compareSep38Quotes(
  quotes: QuoteAuditResult[],
  targetSellAsset: string,
  targetBuyAsset: string,
): QuoteComparisonResult {
  const ranked: Array<{
    quoteId: string;
    normalizedBuyPerSellScaled: bigint;
    normalizedBuyPerSell: string;
    feeTotal: string | null;
    feeAsset: string | null;
    originalDirection: 'same' | 'inverted';
  }> = [];
  const excludedQuotes: QuoteComparisonResult['excludedQuotes'] = [];

  for (const audit of quotes) {
    if (!audit.valid || !audit.quoteId || !audit.sellAmount || !audit.buyAmount) {
      excludedQuotes.push({
        quoteId: audit.quoteId,
        reason: audit.errors.join('; ') || 'Quote failed structural or expiration validation.',
      });
      continue;
    }

    const sellScaled = parseDecimalScaled(audit.sellAmount);
    const buyScaled = parseDecimalScaled(audit.buyAmount);

    if (audit.sellAsset === targetSellAsset && audit.buyAsset === targetBuyAsset) {
      const rateScaled = divideScaled(buyScaled, sellScaled);
      ranked.push({
        quoteId: audit.quoteId,
        normalizedBuyPerSellScaled: rateScaled,
        normalizedBuyPerSell: formatDecimalScaled(rateScaled, 7),
        feeTotal: audit.fee?.total ?? null,
        feeAsset: audit.fee?.asset ?? null,
        originalDirection: 'same',
      });
    } else if (audit.sellAsset === targetBuyAsset && audit.buyAsset === targetSellAsset) {
      // Opposite direction: sell_amount is in targetBuyAsset, buy_amount is in targetSellAsset
      const rateScaled = divideScaled(sellScaled, buyScaled);
      ranked.push({
        quoteId: audit.quoteId,
        normalizedBuyPerSellScaled: rateScaled,
        normalizedBuyPerSell: formatDecimalScaled(rateScaled, 7),
        feeTotal: audit.fee?.total ?? null,
        feeAsset: audit.fee?.asset ?? null,
        originalDirection: 'inverted',
      });
    } else {
      excludedQuotes.push({
        quoteId: audit.quoteId,
        reason: `Quote assets (${audit.sellAsset} -> ${audit.buyAsset}) do not match target pair (${targetSellAsset} <-> ${targetBuyAsset}).`,
      });
    }
  }

  ranked.sort((a, b) =>
    b.normalizedBuyPerSellScaled > a.normalizedBuyPerSellScaled
      ? 1
      : b.normalizedBuyPerSellScaled < a.normalizedBuyPerSellScaled
        ? -1
        : 0,
  );

  return {
    targetSellAsset,
    targetBuyAsset,
    mostFavorableQuoteId: ranked.length > 0 ? ranked[0].quoteId : null,
    rankedQuotes: ranked.map(({ normalizedBuyPerSellScaled: _unused, ...rest }) => rest),
    excludedQuotes,
  };
}

export function formatSep38AuditReport(audit: QuoteAuditResult): string {
  const lines = [
    '=== Stellar SEP-38 Quote Audit Report ===',
    `Anchor: ${audit.anchorService}`,
    `Quote ID: ${audit.quoteId ?? 'missing'}`,
    `Pair: ${audit.sellAsset ?? '?'} -> ${audit.buyAsset ?? '?'}`,
    `Amounts: sell=${audit.sellAmount ?? '?'}, buy=${audit.buyAmount ?? '?'}`,
    `Declared Price: ${audit.declaredPrice ?? '?'} | Effective Price: ${audit.calculatedEffectivePrice ?? '?'}`,
    `Fee: ${audit.fee ? `${audit.fee.total} ${audit.fee.asset}` : 'not provided'}`,
    `Expiration: ${audit.expiration.status} (remainingMs=${audit.expiration.remainingMs ?? 'n/a'})`,
    `Valid: ${audit.valid}`,
  ];
  if (audit.warnings.length > 0) {
    lines.push('Warnings:', ...audit.warnings.map((w) => `  - ${w}`));
  }
  if (audit.errors.length > 0) {
    lines.push('Errors:', ...audit.errors.map((e) => `  - ${e}`));
  }
  return lines.join('\n');
}

export async function run(params: { json?: boolean | string } = {}): Promise<void> {
  const nowMs = Date.now();
  const sampleQuote: Sep38QuoteResponse = {
    id: 'quote-sample-001',
    expires_at: new Date(nowMs + 180_000).toISOString(),
    price: '1.0050000',
    sell_asset: 'iso4217:USD',
    sell_amount: '100.5000000',
    buy_asset: 'stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    buy_amount: '100.0000000',
    fee: { total: '0.50', asset: 'iso4217:USD' },
  };
  const audit = auditSep38Quote(sampleQuote, { anchorService: 'https://anchor.example.com', nowMs });
  const json = params.json === true || params.json === 'true';
  console.log(json ? JSON.stringify(audit, null, 2) : formatSep38AuditReport(audit));
}
