import {
  Account,
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

/**
 * Example 60: Stellar Network Configuration and Passphrase
 *
 * Stellar transactions are signed against a specific network passphrase. The
 * passphrase is mixed into the transaction hash before signing, so a signature
 * produced for Testnet is cryptographically invalid on Mainnet (and vice versa)
 * even when every other field of the transaction is identical.
 *
 * This example shows how Horizon URLs, Soroban RPC endpoints, and network
 * passphrases fit together, how to configure `TransactionBuilder` with the
 * selected passphrase, and how mismatched endpoint/passphrase settings are
 * detected before a transaction is built or submitted.
 *
 * Configuration sources (highest precedence first):
 *   1. Runner / function params (`network`)
 *   2. CLI argument: `npm run run-example -- 60-network-configuration mainnet`
 *   3. Environment variables: `STELLAR_NETWORK`, `NETWORK`, `HORIZON_URL`,
 *      `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`
 *
 * The example never submits a live Mainnet transaction. It builds and signs
 * locally so developers can inspect passphrase effects safely.
 */

export type StellarNetworkName = 'testnet' | 'mainnet';

export interface NetworkEndpoints {
  name: StellarNetworkName;
  displayName: string;
  horizonUrl: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  friendbotUrl?: string;
}

export interface NetworkConfigurationParams {
  network?: string;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  networkPassphrase?: string;
  /** When true, also demonstrate an intentional mismatch (for teaching). */
  demonstrateMismatch?: boolean;
}

export interface ResolvedNetworkConfig {
  network: StellarNetworkName;
  horizonUrl: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  source: string;
}

export const NETWORK_PRESETS: Record<StellarNetworkName, NetworkEndpoints> = {
  testnet: {
    name: 'testnet',
    displayName: 'Stellar Testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
    friendbotUrl: 'https://friendbot.stellar.org',
  },
  mainnet: {
    name: 'mainnet',
    displayName: 'Stellar Mainnet (Public)',
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-rpc.mainnet.stellar.org',
    networkPassphrase: Networks.PUBLIC,
  },
};

const MAINNET_HORIZON_HINTS = ['horizon.stellar.org', 'horizon.public'];
const TESTNET_HORIZON_HINTS = ['horizon-testnet', 'testnet', 'futurenet'];

/**
 * Normalize a free-form network label into `testnet` or `mainnet`.
 */
export function normalizeNetworkName(input?: string | null): StellarNetworkName | null {
  if (!input) {
    return null;
  }

  const value = input.trim().toLowerCase();

  if (['testnet', 'test', 'testing', 'sdf'].includes(value)) {
    return 'testnet';
  }

  if (['mainnet', 'main', 'public', 'prod', 'production'].includes(value)) {
    return 'mainnet';
  }

  return null;
}

/**
 * Infer the intended network from a Horizon URL when no explicit network is set.
 */
export function inferNetworkFromHorizonUrl(horizonUrl: string): StellarNetworkName | null {
  const url = horizonUrl.toLowerCase();

  if (TESTNET_HORIZON_HINTS.some((hint) => url.includes(hint))) {
    return 'testnet';
  }

  if (MAINNET_HORIZON_HINTS.some((hint) => url.includes(hint)) && !url.includes('testnet')) {
    return 'mainnet';
  }

  return null;
}

/**
 * Infer the network from a passphrase string.
 */
export function inferNetworkFromPassphrase(passphrase: string): StellarNetworkName | null {
  if (passphrase === Networks.TESTNET) {
    return 'testnet';
  }

  if (passphrase === Networks.PUBLIC) {
    return 'mainnet';
  }

  return null;
}

/**
 * Detect mismatched Horizon URL / Soroban RPC / passphrase combinations.
 * Returns a human-readable error message, or `null` when the config is coherent.
 */
export function validateNetworkConfiguration(config: {
  network: StellarNetworkName;
  horizonUrl: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
}): string | null {
  const preset = NETWORK_PRESETS[config.network];
  const horizonNetwork = inferNetworkFromHorizonUrl(config.horizonUrl);
  const passphraseNetwork = inferNetworkFromPassphrase(config.networkPassphrase);
  const rpcUrl = config.sorobanRpcUrl.toLowerCase();

  if (passphraseNetwork && passphraseNetwork !== config.network) {
    return (
      `Network passphrase does not match selected network "${config.network}". ` +
      `Expected "${preset.networkPassphrase}" but got "${config.networkPassphrase}".`
    );
  }

  if (horizonNetwork && horizonNetwork !== config.network) {
    return (
      `Horizon URL looks like ${horizonNetwork} but the selected network is ${config.network}. ` +
      `Use ${preset.horizonUrl} (or an endpoint that matches ${config.network}) with passphrase ` +
      `"${preset.networkPassphrase}".`
    );
  }

  const rpcLooksTestnet = rpcUrl.includes('testnet') || rpcUrl.includes('futurenet');
  const rpcLooksMainnet =
    (rpcUrl.includes('mainnet') || rpcUrl.includes('public')) && !rpcLooksTestnet;

  if (config.network === 'testnet' && rpcLooksMainnet) {
    return (
      `Soroban RPC URL looks like Mainnet ("${config.sorobanRpcUrl}") while the selected ` +
      `network is Testnet. Pair ${preset.sorobanRpcUrl} with the Testnet passphrase.`
    );
  }

  if (config.network === 'mainnet' && rpcLooksTestnet) {
    return (
      `Soroban RPC URL looks like Testnet ("${config.sorobanRpcUrl}") while the selected ` +
      `network is Mainnet. Pair ${preset.sorobanRpcUrl} with the Mainnet passphrase.`
    );
  }

  if (config.networkPassphrase !== preset.networkPassphrase && !passphraseNetwork) {
    return (
      `Unrecognized network passphrase "${config.networkPassphrase}" for ${config.network}. ` +
      `Custom passphrases are only valid for private networks; for public Stellar networks use ` +
      `"${preset.networkPassphrase}".`
    );
  }

  return null;
}

/**
 * Resolve the active network configuration from params, CLI args, and env vars.
 */
export function resolveNetworkConfiguration(
  params: NetworkConfigurationParams = {},
): ResolvedNetworkConfig {
  const cliNetwork = normalizeNetworkName(process.argv[3]);
  const envNetwork = normalizeNetworkName(
    process.env.STELLAR_NETWORK || process.env.NETWORK || null,
  );

  const horizonOverride =
    params.horizonUrl?.trim() || process.env.HORIZON_URL?.trim() || undefined;
  const rpcOverride =
    params.sorobanRpcUrl?.trim() || process.env.SOROBAN_RPC_URL?.trim() || undefined;
  const passphraseOverride =
    params.networkPassphrase?.trim() || process.env.NETWORK_PASSPHRASE?.trim() || undefined;

  let network =
    normalizeNetworkName(params.network) ||
    cliNetwork ||
    envNetwork ||
    (horizonOverride ? inferNetworkFromHorizonUrl(horizonOverride) : null) ||
    (passphraseOverride ? inferNetworkFromPassphrase(passphraseOverride) : null) ||
    'testnet';

  const preset = NETWORK_PRESETS[network];
  const sourceParts: string[] = [];

  if (normalizeNetworkName(params.network)) {
    sourceParts.push('params.network');
  } else if (cliNetwork) {
    sourceParts.push('CLI argument');
  } else if (envNetwork) {
    sourceParts.push('STELLAR_NETWORK/NETWORK env');
  } else if (horizonOverride && inferNetworkFromHorizonUrl(horizonOverride)) {
    sourceParts.push('inferred from HORIZON_URL');
  } else if (passphraseOverride && inferNetworkFromPassphrase(passphraseOverride)) {
    sourceParts.push('inferred from NETWORK_PASSPHRASE');
  } else {
    sourceParts.push('default (testnet)');
  }

  if (horizonOverride) {
    sourceParts.push('HORIZON_URL override');
  }
  if (rpcOverride) {
    sourceParts.push('SOROBAN_RPC_URL override');
  }
  if (passphraseOverride) {
    sourceParts.push('NETWORK_PASSPHRASE override');
  }

  return {
    network,
    horizonUrl: horizonOverride || preset.horizonUrl,
    sorobanRpcUrl: rpcOverride || preset.sorobanRpcUrl,
    networkPassphrase: passphraseOverride || preset.networkPassphrase,
    source: sourceParts.join(', '),
  };
}

/**
 * Build a local (non-submitted) payment transaction for the given passphrase.
 * Uses a fixed account sequence so Testnet vs Mainnet hashes are comparable.
 */
export function buildDemoPaymentTransaction(
  networkPassphrase: string,
  sourcePublicKey: string,
  destinationPublicKey: string,
  amount = '1',
): Transaction {
  // Account(..., sequence) uses the *current* sequence; TransactionBuilder
  // increments it when building, so sequence "0" yields transaction sequence 1.
  const sourceAccount = new Account(sourcePublicKey, '0');

  return new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: Asset.native(),
        amount,
      }),
    )
    .setTimeout(30)
    .build();
}

/**
 * Explain why a transaction signed for one network cannot be submitted to another.
 */
export function explainNetworkSignatureBinding(
  testnetHash: string,
  mainnetHash: string,
): string {
  const lines = [
    '=== Why network passphrases matter for signatures ===',
    '',
    'Stellar does not sign the raw XDR bytes alone. Before signing, the SDK hashes:',
    '  SHA-256( network_id || transaction_envelope_hash_input )',
    'where network_id = SHA-256(network_passphrase).',
    '',
    `Testnet passphrase:  "${Networks.TESTNET}"`,
    `Mainnet passphrase:  "${Networks.PUBLIC}"`,
    '',
    `Same operations + same source + same sequence, but:`,
    `  Testnet tx hash: ${testnetHash}`,
    `  Mainnet tx hash: ${mainnetHash}`,
    '',
    'Because the hashes differ, a signature produced for Testnet does not verify',
    'against the Mainnet hash. Horizon / Soroban RPC on the other network will',
    'reject the transaction (typically as a bad signature / tx_bad_auth), even',
    'though the operations look identical when decoded as XDR.',
    '',
    'Security implication: always bind Horizon URL, Soroban RPC URL, and',
    'networkPassphrase to the same environment. Signing Mainnet transactions',
    'with Testnet tooling (or the reverse) wastes fees at best and can leak',
    'signed payloads intended for a different network at worst.',
  ];

  return lines.join('\n');
}

function formatConfigurationSummary(config: ResolvedNetworkConfig): string {
  const preset = NETWORK_PRESETS[config.network];
  const lines = [
    '=== Selected Stellar Network Configuration ===',
    `Network:              ${preset.displayName} (${config.network})`,
    `Horizon endpoint:     ${config.horizonUrl}`,
    `Soroban RPC endpoint: ${config.sorobanRpcUrl}`,
    `Network passphrase:   ${config.networkPassphrase}`,
    `Config source:        ${config.source}`,
  ];

  if (preset.friendbotUrl) {
    lines.push(`Friendbot (funding):  ${preset.friendbotUrl}`);
  } else {
    lines.push('Friendbot (funding):  n/a on Mainnet — never use Friendbot against public funds');
  }

  return lines.join('\n');
}

function formatNetworkComparison(): string {
  const testnet = NETWORK_PRESETS.testnet;
  const mainnet = NETWORK_PRESETS.mainnet;

  return [
    '=== Testnet vs Mainnet at a glance ===',
    '',
    '                          Testnet                              Mainnet',
    `Horizon                   ${testnet.horizonUrl.padEnd(36)} ${mainnet.horizonUrl}`,
    `Soroban RPC               ${testnet.sorobanRpcUrl.padEnd(36)} ${mainnet.sorobanRpcUrl}`,
    `Passphrase                ${testnet.networkPassphrase}`,
    `                          ${mainnet.networkPassphrase}`,
    'Friendbot                 available                            not available',
    'Asset value               test XLM only                        real XLM',
  ].join('\n');
}

/**
 * Optionally probe Horizon root so developers can confirm the live network_passphrase.
 */
async function probeHorizonRoot(
  horizonUrl: string,
): Promise<{ networkPassphrase?: string; error?: string }> {
  try {
    const server = new Horizon.Server(horizonUrl);
    const root = (await server.root()) as { network_passphrase?: string };
    return { networkPassphrase: root.network_passphrase };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

/**
 * Runs the network configuration example.
 */
export async function run(params: NetworkConfigurationParams = {}): Promise<void> {
  console.log('Starting Stellar Network Configuration Example...');
  console.log(
    'This example configures Horizon + Soroban RPC + network passphrase together,\n' +
      'builds TransactionBuilder with the selected passphrase, and shows why a\n' +
      'signature from one network cannot be submitted to another.\n',
  );

  const config = resolveNetworkConfiguration(params);
  console.log(formatConfigurationSummary(config));
  console.log('');
  console.log(formatNetworkComparison());

  const mismatch = validateNetworkConfiguration(config);
  if (mismatch) {
    console.log('\n❌ Invalid or mismatched network configuration:');
    console.log(`   ${mismatch}`);
    console.log('\nFix the Horizon URL, Soroban RPC URL, and passphrase so they all refer');
    console.log('to the same environment, then re-run this example.');
    throw new Error(mismatch);
  }

  console.log('\n✅ Endpoint and passphrase settings are consistent for this network.');

  console.log('\n--- Horizon root probe (live network_passphrase check) ---');
  const probe = await probeHorizonRoot(config.horizonUrl);
  if (probe.networkPassphrase) {
    console.log(`Horizon reports network_passphrase: "${probe.networkPassphrase}"`);
    if (probe.networkPassphrase !== config.networkPassphrase) {
      const message =
        `Horizon root passphrase ("${probe.networkPassphrase}") does not match the ` +
        `configured passphrase ("${config.networkPassphrase}"). Refusing to continue.`;
      console.log(`\n❌ ${message}`);
      throw new Error(message);
    }
    console.log('Horizon passphrase matches the configured network passphrase.');
  } else {
    console.log(
      `Could not probe Horizon (${probe.error || 'unknown error'}). Continuing with local demo only.`,
    );
  }

  // Intentional mismatch demo (teaching aid) — does not change the selected config.
  const shouldDemoMismatch =
    params.demonstrateMismatch === true ||
    process.env.DEMONSTRATE_NETWORK_MISMATCH === '1' ||
    process.argv.includes('--demonstrate-mismatch');

  if (shouldDemoMismatch) {
    console.log('\n--- Demonstrating mismatched configuration detection ---');
    const badConfig = {
      network: 'testnet' as StellarNetworkName,
      horizonUrl: NETWORK_PRESETS.mainnet.horizonUrl,
      sorobanRpcUrl: NETWORK_PRESETS.testnet.sorobanRpcUrl,
      networkPassphrase: Networks.TESTNET,
    };
    const badMessage = validateNetworkConfiguration(badConfig);
    console.log('Example bad config: Testnet passphrase + Mainnet Horizon URL');
    console.log(`Validator response: ${badMessage}`);
  }

  console.log('\n--- Configure TransactionBuilder with the selected passphrase ---');
  const sourceKeypair = Keypair.random();
  const destinationKeypair = Keypair.random();

  const selectedTx = buildDemoPaymentTransaction(
    config.networkPassphrase,
    sourceKeypair.publicKey(),
    destinationKeypair.publicKey(),
  );
  selectedTx.sign(sourceKeypair);

  console.log(`Source (local keypair):      ${sourceKeypair.publicKey()}`);
  console.log(`Destination (local keypair): ${destinationKeypair.publicKey()}`);
  console.log(`TransactionBuilder networkPassphrase: ${config.networkPassphrase}`);
  console.log(`Built tx hash (selected network):     ${selectedTx.hash().toString('hex')}`);
  console.log(`Signature count:                      ${selectedTx.signatures.length}`);
  console.log(
    'Note: this transaction is built/signed locally for demonstration and is not submitted.',
  );

  console.log('\n--- Same operations, different passphrases (hash divergence) ---');
  const testnetTx = buildDemoPaymentTransaction(
    Networks.TESTNET,
    sourceKeypair.publicKey(),
    destinationKeypair.publicKey(),
  );
  const mainnetTx = buildDemoPaymentTransaction(
    Networks.PUBLIC,
    sourceKeypair.publicKey(),
    destinationKeypair.publicKey(),
  );

  const testnetHash = testnetTx.hash().toString('hex');
  const mainnetHash = mainnetTx.hash().toString('hex');

  console.log(explainNetworkSignatureBinding(testnetHash, mainnetHash));

  if (testnetHash === mainnetHash) {
    throw new Error('Expected Testnet and Mainnet transaction hashes to differ');
  }

  console.log('\n--- How to select a network ---');
  console.log('Interactive runner: choose network when prompted');
  console.log('CLI:  npm run run-example -- 60-network-configuration testnet');
  console.log('CLI:  npm run run-example -- 60-network-configuration mainnet');
  console.log('Env:  STELLAR_NETWORK=mainnet  (or NETWORK=testnet)');
  console.log('Env:  HORIZON_URL / SOROBAN_RPC_URL / NETWORK_PASSPHRASE overrides');

  if (config.network === 'mainnet') {
    console.log('\n⚠️  Mainnet selected: this example does not submit transactions or move funds.');
    console.log('    Double-check passphrase + endpoints before signing anything with real keys.');
  }

  console.log('\nNetwork configuration example completed successfully.');
}
