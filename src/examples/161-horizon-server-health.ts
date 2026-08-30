import { inspectHorizonEndpoint } from '../inspector/horizon';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const report = await inspectHorizonEndpoint(horizonUrl);

  console.log('=== Horizon Server Health Inspector ===');
  console.log(`Endpoint: ${report.endpoint}`);
  console.log(`Latency: ${report.latencyMs}ms`);
  console.log(`Network: ${report.metadata.networkPassphrase}`);
  console.log(`Protocol Version: ${report.metadata.protocolVersion}`);
  console.log(`Core Version: ${report.metadata.coreVersion}`);
  console.log(`Horizon Version: ${report.metadata.horizonVersion}`);
  console.log(`Health Status: ${report.latencyMs < 2000 ? 'healthy' : 'degraded'}`);
}
