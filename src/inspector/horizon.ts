export interface HorizonMetadata {
  networkPassphrase: string;
  protocolVersion: string;
  coreVersion: string;
  horizonVersion: string;
}

export interface HorizonInspectionResult {
  endpoint: string;
  latencyMs: number;
  metadata: HorizonMetadata;
}

export class InvalidHorizonUrlError extends Error {
  constructor(url: string) {
    super(`Invalid Horizon URL: ${url}`);
    this.name = 'InvalidHorizonUrlError';
  }
}

export class HorizonOfflineError extends Error {
  constructor(url: string, message: string) {
    super(`Unable to reach Horizon endpoint (${url}): ${message}`);
    this.name = 'HorizonOfflineError';
  }
}

export function validateHorizonUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidHorizonUrlError(rawUrl);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidHorizonUrlError(rawUrl);
  }

  return parsed.toString().replace(/\/$/, '');
}

export function extractHorizonMetadata(response: Record<string, unknown>): HorizonMetadata {
  const networkPassphrase = String(response.network_passphrase ?? 'unknown');
  const protocolVersion = String(
    response.current_protocol_version ?? response.protocol_version ?? 'unknown',
  );
  const coreVersion = String(response.core_version ?? 'unknown');
  const horizonVersion = String(response.horizon_version ?? 'unknown');

  return {
    networkPassphrase,
    protocolVersion,
    coreVersion,
    horizonVersion,
  };
}

export async function inspectHorizonEndpoint(
  rawUrl: string,
  deps?: {
    fetchImpl?: typeof fetch;
    now?: () => number;
  },
): Promise<HorizonInspectionResult> {
  const endpoint = validateHorizonUrl(rawUrl);
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const now = deps?.now ?? Date.now;

  const startedAt = now();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HorizonOfflineError(endpoint, message);
  }

  const endedAt = now();
  const latencyMs = Math.max(0, Math.round(endedAt - startedAt));

  if (!response.ok) {
    throw new HorizonOfflineError(endpoint, `HTTP ${response.status}`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new HorizonOfflineError(endpoint, 'Response was not valid JSON');
  }

  return {
    endpoint,
    latencyMs,
    metadata: extractHorizonMetadata(payload),
  };
}
