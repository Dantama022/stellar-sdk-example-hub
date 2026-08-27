import {
  Keypair,
  TransactionBuilder,
  Account,
  Networks,
  Horizon,
  rpc,
} from '@stellar/stellar-sdk';

/**
 * Example 155: Network Configuration Validation
 *
 * Stellar transactions are signed against a specific network passphrase. Applications that
 * support multiple environments such as Public Network, Test Network, and local development
 * networks need to ensure that their network configuration matches the intended Horizon or
 * Soroban RPC endpoint.
 *
 * This example demonstrates how to inspect and validate Stellar network configuration using
 * the Stellar JavaScript/TypeScript SDK. It helps developers detect mismatches between an
 * endpoint, network passphrase, and transaction configuration before signing or submitting
 * transactions.
 */

interface EndpointInfo {
  url: string;
  type: 'horizon' | 'soroban-rpc' | 'unknown';
  isReachable: boolean;
  networkPassphrase?: string;
  networkId?: string;
  ledgerVersion?: string;
  protocolVersion?: string;
}

interface NetworkConfiguration {
  name: string;
  passphrase: string;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
}

interface ValidationResult {
  endpoint: EndpointInfo;
  configuration: NetworkConfiguration;
  isValid: boolean;
  warnings: string[];
  recommendations: string[];
}

// Known Stellar network configurations
const KNOWN_NETWORKS: Record<string, NetworkConfiguration> = {
  PUBLIC: {
    name: 'Public Network',
    passphrase: Networks.PUBLIC_NETWORK,
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-mainnet.stellar.org',
  },
  TESTNET: {
    name: 'Test Network',
    passphrase: Networks.TESTNET,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  },
  FUTURENET: {
    name: 'Future Network',
    passphrase: Networks.FUTURENET,
    horizonUrl: 'https://horizon-futurenet.stellar.org',
    sorobanRpcUrl: 'https://soroban-futurenet.stellar.org',
  },
};

async function probeEndpoint(url: string): Promise<EndpointInfo> {
  const endpointInfo: EndpointInfo = {
    url,
    type: 'unknown',
    isReachable: false,
  };

  try {
    // Try Horizon first
    if (url.includes('horizon')) {
      try {
        const horizonServer = new Horizon.Server(url);
        const ledger = await horizonServer.ledgers().limit(1).call();

        endpointInfo.type = 'horizon';
        endpointInfo.isReachable = true;
        endpointInfo.ledgerVersion = ledger.records[0]?.sequence.toString();
        endpointInfo.protocolVersion = ledger.records[0]?.protocol_version?.toString();

        return endpointInfo;
      } catch {
        // Not a valid Horizon endpoint
      }
    }

    // Try Soroban RPC
    if (url.includes('soroban')) {
      try {
        const rpcServer = new rpc.Server(url);
        const latestLedger = await rpcServer.getLatestLedger();

        endpointInfo.type = 'soroban-rpc';
        endpointInfo.isReachable = true;
        endpointInfo.ledgerVersion = latestLedger.sequence.toString();
        endpointInfo.protocolVersion = latestLedger.protocolVersion.toString();

        return endpointInfo;
      } catch {
        // Not a valid Soroban RPC endpoint
      }
    }

    // Fallback: Try generic fetch to determine reachability
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    endpointInfo.isReachable = response.ok || response.status < 500;

    return endpointInfo;
  } catch (error) {
    endpointInfo.isReachable = false;
    return endpointInfo;
  }
}

function matchNetworkPassphrase(passphrase: string): NetworkConfiguration | null {
  for (const [, config] of Object.entries(KNOWN_NETWORKS)) {
    if (config.passphrase === passphrase) {
      return config;
    }
  }
  return null;
}

function validateNetworkConfiguration(
  endpointInfo: EndpointInfo,
  networkPassphrase: string,
): ValidationResult {
  const matchedConfig = matchNetworkPassphrase(networkPassphrase);

  if (!matchedConfig) {
    return {
      endpoint: endpointInfo,
      configuration: {
        name: 'Custom/Unknown',
        passphrase: networkPassphrase,
      },
      isValid: false,
      warnings: ['Network passphrase does not match known Stellar networks'],
      recommendations: [
        'Verify the network passphrase is correct',
        'If using a custom network, ensure the endpoint matches',
      ],
    };
  }

  const warnings: string[] = [];
  const recommendations: string[] = [];
  let isValid = true;

  // Check if endpoint is reachable
  if (!endpointInfo.isReachable) {
    warnings.push(`Endpoint ${endpointInfo.url} is not reachable`);
    isValid = false;
    recommendations.push('Check network connectivity to the endpoint');
    recommendations.push('Verify the endpoint URL is correct');
  }

  // Check if endpoint type matches expected type
  if (endpointInfo.type === 'unknown') {
    warnings.push('Could not determine endpoint type');
    isValid = false;
  }

  // Validate that endpoint matches network configuration
  if (endpointInfo.isReachable && matchedConfig.horizonUrl && matchedConfig.horizonUrl !== endpointInfo.url) {
    // Allow both testnet endpoints
    if (
      !(
        (endpointInfo.url.includes('testnet') && matchedConfig.horizonUrl.includes('testnet')) ||
        (endpointInfo.url.includes('futurenet') && matchedConfig.horizonUrl.includes('futurenet'))
      )
    ) {
      warnings.push(
        `Endpoint URL ${endpointInfo.url} may not match network ${matchedConfig.name}`,
      );
      recommendations.push(`Consider using ${matchedConfig.horizonUrl} instead`);
    }
  }

  return {
    endpoint: endpointInfo,
    configuration: matchedConfig,
    isValid: isValid && warnings.length === 0,
    warnings,
    recommendations,
  };
}

function printValidationResult(result: ValidationResult): void {
  console.log('\n=== Network Configuration Validation Result ===\n');

  console.log(`Network: ${result.configuration.name}`);
  console.log(`Passphrase: ${result.configuration.passphrase}`);
  console.log(`Endpoint: ${result.endpoint.url}`);
  console.log(`Endpoint Type: ${result.endpoint.type}`);
  console.log(`Reachable: ${result.endpoint.isReachable ? '✓ Yes' : '✗ No'}`);

  if (result.endpoint.ledgerVersion) {
    console.log(`Ledger Version: ${result.endpoint.ledgerVersion}`);
  }

  if (result.endpoint.protocolVersion) {
    console.log(`Protocol Version: ${result.endpoint.protocolVersion}`);
  }

  console.log(`\nValidation Status: ${result.isValid ? '✓ PASSED' : '✗ FAILED'}`);

  if (result.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    result.warnings.forEach(warning => {
      console.log(`  - ${warning}`);
    });
  }

  if (result.recommendations.length > 0) {
    console.log('\n💡 Recommendations:');
    result.recommendations.forEach(rec => {
      console.log(`  - ${rec}`);
    });
  }
}

function validateTransactionNetwork(
  transactionNetwork: string,
  endpointNetwork: string,
  endpointUrl: string,
): void {
  console.log('\n=== Transaction vs Endpoint Network Validation ===\n');

  console.log(`Transaction Network: ${transactionNetwork}`);
  console.log(`Endpoint Network: ${endpointNetwork}`);
  console.log(`Endpoint URL: ${endpointUrl}`);

  const txConfig = matchNetworkPassphrase(transactionNetwork);
  const endpointConfig = matchNetworkPassphrase(endpointNetwork);

  if (!txConfig || !endpointConfig) {
    console.log('\n✗ ERROR: Cannot validate - unknown network passphrases');
    return;
  }

  if (transactionNetwork === endpointNetwork) {
    console.log('\n✓ SUCCESS: Transaction and endpoint networks match!');
    console.log(`Both configured for: ${txConfig.name}`);
  } else {
    console.log('\n✗ ERROR: Transaction and endpoint networks DO NOT match!');
    console.log(`Transaction built for: ${txConfig.name}`);
    console.log(`Endpoint configured for: ${endpointConfig.name}`);
    console.log('\n⚠️  WARNING: This transaction will be REJECTED if submitted to this endpoint!');
    console.log('   Ensure transaction network passphrase matches the target endpoint.');
  }
}

export async function run(): Promise<void> {
  console.log('\n=== Network Configuration Validation Example ===\n');

  // Example 1: Validate known Test Network endpoint
  console.log('--- Example 1: Test Network Configuration ---');
  const testnetEndpointInfo = await probeEndpoint('https://horizon-testnet.stellar.org');
  const testnetValidation = validateNetworkConfiguration(
    testnetEndpointInfo,
    Networks.TESTNET,
  );
  printValidationResult(testnetValidation);

  // Example 2: Validate Public Network endpoint
  console.log('\n--- Example 2: Public Network Configuration ---');
  const publicEndpointInfo = await probeEndpoint('https://horizon.stellar.org');
  const publicValidation = validateNetworkConfiguration(
    publicEndpointInfo,
    Networks.PUBLIC_NETWORK,
  );
  printValidationResult(publicValidation);

  // Example 3: Validate mismatched configuration
  console.log('\n--- Example 3: Mismatched Configuration (Testing) ---');
  const mismatchedEndpointInfo: EndpointInfo = {
    url: 'https://horizon.stellar.org',
    type: 'horizon',
    isReachable: true,
  };
  const mismatchedValidation = validateNetworkConfiguration(
    mismatchedEndpointInfo,
    Networks.TESTNET, // Using TestNet passphrase with Public endpoint
  );
  printValidationResult(mismatchedValidation);

  // Example 4: Transaction Network Validation
  console.log('\n--- Example 4: Transaction Network Validation ---');

  const keypair = Keypair.random();
  const sourceAccount = new Account(keypair.publicKey(), '100');

  // Build a transaction for Test Network
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation({
      destination: Keypair.random().publicKey(),
      amount: '10',
      asset: { code: 'native', issuer: '' },
      type: 'payment',
    })
    .setTimeout(300)
    .build();

  // Validate transaction network against endpoints
  console.log('\n✓ Correct Configuration:');
  validateTransactionNetwork(
    Networks.TESTNET,
    Networks.TESTNET,
    'https://horizon-testnet.stellar.org',
  );

  console.log('\n✗ Incorrect Configuration:');
  validateTransactionNetwork(
    Networks.TESTNET,
    Networks.PUBLIC_NETWORK,
    'https://horizon.stellar.org',
  );

  // Example 5: Configuration recommendations
  console.log('\n--- Example 5: Configuration Recommendations ---\n');
  console.log('Network Configuration Best Practices:\n');

  console.log('1. ENVIRONMENT-SPECIFIC CONFIGURATION');
  console.log('   Development: Use TESTNET or local network');
  console.log('   Staging: Use TESTNET');
  console.log('   Production: Use PUBLIC_NETWORK\n');

  console.log('2. TRANSACTION NETWORK MATCHING');
  console.log('   Always ensure transaction network matches endpoint network');
  console.log('   Mismatch will result in transaction rejection\n');

  console.log('3. VALIDATION AT BUILD TIME');
  console.log('   Validate network configuration when building transactions');
  console.log('   Fail fast rather than discovering issues at submission\n');

  console.log('4. RECOMMENDED NETWORK ENDPOINTS');
  Object.entries(KNOWN_NETWORKS).forEach(([key, config]) => {
    console.log(`   ${config.name}:`);
    if (config.horizonUrl) console.log(`     Horizon: ${config.horizonUrl}`);
    if (config.sorobanRpcUrl) console.log(`     Soroban RPC: ${config.sorobanRpcUrl}`);
  });

  console.log('\n=== Example Complete ===\n');
}
