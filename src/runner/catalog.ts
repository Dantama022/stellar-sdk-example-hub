import { createRequire } from 'module';

export type ExampleRunner = (params?: any) => Promise<void>;

interface ExampleModule {
  run: ExampleRunner;
}

export interface Example {
  name: string;
  description: string;
  run: ExampleRunner;
  params?: Array<{
    type: string;
    name: string;
    message: string;
    default?: any;
    choices?: Array<string | { name: string; value: string }>;
  }>;
}

/**
 * Loads an example only when the user selects it.
 *
 * The repository contains independent examples, so an unrelated TypeScript
 * error in one example should not prevent another registered example from
 * running through the central runner.
 */
const requireExample = createRequire(__filename);

function loadExample(modulePath: string): ExampleRunner {
  return async (params?: any): Promise<void> => {
    const exampleModule = requireExample(modulePath) as ExampleModule;

    await exampleModule.run(params);
  };
}

export const examples: Record<string, Example> = {
  '01-create-account': {
    name: '01-create-account',
    description: 'Generate keypairs and fund a test account using Friendbot',
    run: loadExample('../examples/01-create-account'),
  },
  '02-payment': {
    name: '02-payment',
    description: 'Send native XLM payment to a destination address',
    run: loadExample('../examples/02-payment'),
  },
  '03-create-trustline': {
    name: '03-create-trustline',
    description: 'Establish a trustline for a custom asset (USD)',
    run: loadExample('../examples/03-create-trustline'),
  },
  '04-multisig': {
    name: '04-multisig',
    description: 'Configure multi-signature and modify account thresholds',
    run: loadExample('../examples/04-multisig'),
  },
  '05-soroban-invoke': {
    name: '05-soroban-invoke',
    description: 'Simulate and invoke a Soroban smart contract method',
    run: loadExample('../examples/05-soroban-invoke'),
  },
  '07-claimable-balances': {
    name: '07-claimable-balances',
    description: 'Create and claim a claimable balance with claimant predicates',
    run: loadExample('../examples/07-claimable-balances'),
  },
  '08-liquidity-pools': {
    name: '08-liquidity-pools',
    description: 'Create trustline, deposit, and withdraw from an AMM liquidity pool',
    run: loadExample('../examples/08-liquidity-pools'),
  },
  '09-fee-bump': {
    name: '09-fee-bump',
    description: 'Wrap a source transaction in a sponsor-paid fee-bump transaction',
    run: loadExample('../examples/09-fee-bump'),
  },
  '10-soroban-events': {
    name: '10-soroban-events',
    description: 'Subscribe to and decode Soroban contract event streams',
    run: loadExample('../examples/10-soroban-events'),
  },
  '11-sponsored-reserves': {
    name: '11-sponsored-reserves',
    description: 'Create sponsored resources and inspect sponsorship state',
    run: loadExample('../examples/11-sponsored-reserves'),
  },
  '12-asset-issuance': {
    name: '12-asset-issuance',
    description: 'Issue a custom asset and lock the issuer account',
    run: loadExample('../examples/12-asset-issuance'),
    params: [
      {
        type: 'input',
        name: 'assetCode',
        message: 'Enter custom asset code:',
        default: 'MYASSET',
      },
      {
        type: 'input',
        name: 'amount',
        message: 'Enter issuance amount:',
        default: '10000',
      },
    ],
  },
  '13-soroban-deploy': {
    name: '13-soroban-deploy',
    description: 'Upload and deploy a Soroban WASM smart contract',
    run: loadExample('../examples/13-soroban-deploy'),
  },
  '14-time-locked-escrow': {
    name: '14-time-locked-escrow',
    description: 'Demonstrate a time-bounded transaction before and after validity',
    run: loadExample('../examples/14-time-locked-escrow'),
  },
  '15-account-merge': {
    name: '15-account-merge',
    description: 'Merge an account into a destination account to recover the minimum reserve',
    run: loadExample('../examples/15-account-merge'),
  },
  '16-batched-operations': {
    name: '16-batched-operations',
    description: 'Submit multiple payment operations atomically in one transaction',
    run: loadExample('../examples/16-batched-operations'),
  },
  '17-offline-signing': {
    name: '17-offline-signing',
    description: 'Construct, export XDR, sign offline, and verify a transaction',
    run: loadExample('../examples/17-offline-signing'),
    params: [
      {
        type: 'input',
        name: 'amount',
        message: 'Enter payment amount (XLM):',
        default: '10',
      },
    ],
  },
  '18-soroban-errors': {
    name: '18-soroban-errors',
    description: 'Intentionally trigger and parse Soroban RPC and transaction errors',
    run: loadExample('../examples/18-soroban-errors'),
  },
  '19-horizon-streaming': {
    name: '19-horizon-streaming',
    description: 'Subscribe to live Horizon payment events over Server-Sent Events',
    run: loadExample('../examples/19-horizon-streaming'),
  },
  '20-sep10-authentication': {
    name: '20-sep10-authentication',
    description:
      'SEP-10 Web Authentication: challenge generation, signing, verification, and JWT issuance',
    run: loadExample('../examples/20-sep10-authentication'),
  },
  '21-sep24-deposit-withdrawal': {
    name: '21-sep24-deposit-withdrawal',
    description: 'Run SEP-24 interactive deposit and withdrawal against a Testnet anchor',
    run: loadExample('../examples/21-sep24-deposit-withdrawal'),
  },
  '22-advanced-multisig': {
    name: '22-advanced-multisig',
    description:
      'Advanced multisig: weighted signers, threshold tiers, signer rotation, and failure handling',
    run: loadExample('../examples/22-advanced-multisig'),
  },
  '22-manage-buy-offer': {
    name: '22-manage-buy-offer',
    description: 'Create, modify, and delete buy offers on the Stellar SDEX',
    run: loadExample('../examples/22-manage-buy-offer'),
  },
  '23-soroban-upgrade': {
    name: '23-soroban-upgrade',
    description: 'Deploy, upgrade, and verify a Soroban contract while preserving storage',
    run: loadExample('../examples/23-soroban-upgrade'),
  },
  '23-manage-data-entries': {
    name: '23-manage-data-entries',
    description: 'Create, update, query, and remove account data entries on-ledger',
    run: loadExample('../examples/23-manage-data-entries'),
  },
  '24-create-passive-sell-offer': {
    name: '24-create-passive-sell-offer',
    description: 'Create a passive sell offer on the SDEX for liquidity provisioning',
    run: loadExample('../examples/24-create-passive-sell-offer'),
  },
  '24-cross-contract-invoke': {
    name: '24-cross-contract-invoke',
    description: 'Demonstrate cross-contract invocation, authorization, and returned values',
    run: loadExample('../examples/24-cross-contract-invoke'),
  },
  '25-account-flags': {
    name: '25-account-flags',
    description:
      'View and modify issuer account flags (AUTH_REQUIRED, AUTH_REVOCABLE, AUTH_IMMUTABLE)',
    run: loadExample('../examples/25-account-flags'),
  },
  '26-sponsored-claimable-balance': {
    name: '26-sponsored-claimable-balance',
    description: 'Create and claim a sponsored claimable balance on Testnet',
    run: loadExample('../examples/26-sponsored-claimable-balance'),
  },
  '27-manage-sell-offer': {
    name: '27-manage-sell-offer',
    description: 'Create, update, and remove sell offers directly on the SDEX',
    run: loadExample('../examples/27-manage-sell-offer'),
  },
  '28-trustline-authorization': {
    name: '28-trustline-authorization',
    description: 'Authorize, deauthorize, and reauthorize an asset trustline',
    run: loadExample('../examples/28-trustline-authorization'),
  },
  '29-account-home-domain': {
    name: '29-account-home-domain',
    description: 'Set, inspect, update, and remove an account home domain',
    run: loadExample('../examples/29-account-home-domain'),
  },
  '29-inflation-destination': {
    name: '29-inflation-destination',
    description: 'Set, inspect, and remove an account inflation destination',
    run: loadExample('../examples/29-inflation-destination'),
  },
  '30-end-sponsoring-reserves': {
    name: '30-end-sponsoring-reserves',
    description: 'Complete the lifecycle of sponsored reserves and inspect state',
    run: loadExample('../examples/30-end-sponsoring-reserves'),
  },
  '30-horizon-pagination': {
    name: '30-horizon-pagination',
    description: 'Retrieve and traverse paginated Horizon records safely',
    run: loadExample('../examples/30-horizon-pagination'),
  },
  '32-ledger-bounds': {
    name: '32-ledger-bounds',
    description:
      'Build transactions with ledger bounds, inspect the validity range, and handle out-of-range rejections',
    run: loadExample('../examples/32-ledger-bounds'),
  },
  '33-fee-bump-replacement': {
    name: '33-fee-bump-replacement',
    description:
      'Wrap a signed inner transaction in a fee-bump envelope with a higher fee and a separate fee-source account',
    run: loadExample('../examples/33-fee-bump-replacement'),
  },
  '96-fee-bump-recovery-workflow': {
    name: '96-fee-bump-recovery-workflow',
    description:
      'Recover a low-fee transaction by wrapping it in a higher-fee fee-bump replacement',
    run: loadExample('../examples/96-fee-bump-recovery-workflow'),
    params: [
      {
        type: 'input',
        name: 'innerBaseFee',
        message: 'Enter the original transaction base fee in stroops:',
        default: '10',
      },
      {
        type: 'input',
        name: 'bumpBaseFee',
        message: 'Enter the fee-bump base fee in stroops:',
        default: '500',
      },
    ],
  },
  '37-strict-send-path-payment': {
    name: '37-strict-send-path-payment',
    description: 'Execute a strict-send path payment and observe the received amount',
    run: loadExample('../examples/37-strict-send-path-payment'),
  },
  '36-strict-receive-path-payment': {
    name: '36-strict-receive-path-payment',
    description:
      'Execute a strict-receive path payment with a fixed destination amount and sendMax cap',
    run: loadExample('../examples/36-strict-receive-path-payment'),
  },
  '35-revoke-sponsorship': {
    name: '35-revoke-sponsorship',
    description:
      'Revoke sponsorship from a sponsored ledger entry and inspect reserve responsibility',
    run: loadExample('../examples/35-revoke-sponsorship'),
  },
  '38-account-signer-management': {
    name: '38-account-signer-management',
    description: 'Manage account signers and weights for multi-party authorization',
    run: loadExample('../examples/38-account-signer-management'),
  },
  '39-account-thresholds': {
    name: '39-account-thresholds',
    description: 'Configure and verify low, medium, and high account thresholds',
    run: loadExample('../examples/39-account-thresholds'),
  },
  '41-sponsored-reserve-inspection': {
    name: '41-sponsored-reserve-inspection',
    description: 'Inspect sponsored ledger entries and their effect on account reserves',
    run: loadExample('../examples/41-sponsored-reserve-inspection'),
  },
  '42-account-sequence-numbers': {
    name: '42-account-sequence-numbers',
    description: 'Retrieve, consume, and correctly manage account sequence numbers',
    run: loadExample('../examples/42-account-sequence-numbers'),
  },
  '44-resilient-horizon-stream': {
    name: '44-resilient-horizon-stream',
    description:
      'Consume a Horizon SSE stream with cursor resume, controlled reconnect backoff, and graceful shutdown',
    run: loadExample('../examples/44-resilient-horizon-stream'),
  },
  '45-horizon-effects': {
    name: '45-horizon-effects',
    description: 'Inspect Horizon effects for a transaction and compare them to operations',
    run: loadExample('../examples/45-horizon-effects'),
    params: [
      {
        type: 'input',
        name: 'transactionHash',
        message: 'Optional transaction hash (blank uses latest transaction):',
      },
      {
        type: 'input',
        name: 'accountId',
        message: 'Optional account filter (blank uses transaction source account):',
      },
    ],
  },
  '47-account-data-entries': {
    name: '47-account-data-entries',
    description: 'Create, verify, update, and remove account data entries with reserve context',
    run: loadExample('../examples/47-account-data-entries'),
  },
  '48-asset-authorization-flags': {
    name: '48-asset-authorization-flags',
    description: 'Configure issuer authorization flags and observe trustline authorization changes',
    run: loadExample('../examples/48-asset-authorization-flags'),
  },
  '49-claimable-balance-inspection': {
    name: '49-claimable-balance-inspection',
    description: 'Inspect claimable balances, claimant predicates, and claimant-based filtering',
    run: loadExample('../examples/49-claimable-balance-inspection'),
  },
  '50-asset-issuer-discovery': {
    name: '50-asset-issuer-discovery',
    description:
      'Query Horizon for an asset by code and issuer, inspect trustline counts and authorization flags',
    run: loadExample('../examples/50-asset-issuer-discovery'),
    params: [
      {
        type: 'input',
        name: 'assetCode',
        message: 'Asset code (blank discovers a recently indexed asset):',
      },
      {
        type: 'input',
        name: 'assetIssuer',
        message: 'Asset issuer account ID (required when asset code is set):',
      },
    ],
  },
  '52-account-balance-history': {
    name: '52-account-balance-history',
    description: 'Reconstruct a simple native XLM balance history from recent Horizon effects',
    run: loadExample('../examples/52-account-balance-history'),
    params: [
      {
        type: 'input',
        name: 'accountId',
        message: 'Optional account ID (blank uses recent active account):',
      },
      {
        type: 'input',
        name: 'limit',
        message: 'Number of recent effects to retrieve (1-200):',
        default: '25',
      },
    ],
  },
  '53-ledger-inspection': {
    name: '53-ledger-inspection',
    description:
      'Retrieve and inspect a Horizon ledger sequence, close time, counts, and network parameters',
    run: loadExample('../examples/53-ledger-inspection'),
    params: [
      {
        type: 'input',
        name: 'ledgerSequence',
        message: 'Ledger sequence (blank uses the latest closed ledger):',
      },
    ],
  },
  '59-account-offer-inspection': {
    name: '59-account-offer-inspection',
    description: "Inspect an account's active SDEX offers, assets, prices, and approximate volumes",
    run: loadExample('../examples/59-account-offer-inspection'),
    params: [
      {
        type: 'input',
        name: 'accountId',
        message: 'Optional account ID (blank finds an account with offers when possible):',
      },
      {
        type: 'input',
        name: 'limit',
        message: 'Number of offers to retrieve (1-200):',
        default: '20',
      },
    ],
  },
  '46-transaction-detail-inspection': {
    name: '46-transaction-detail-inspection',
    description: 'Retrieve a Horizon transaction by hash and inspect its metadata and XDR',
    run: loadExample('../examples/46-transaction-detail-inspection'),
    params: [
      {
        type: 'input',
        name: 'transactionHash',
        message: 'Enter a transaction hash, or leave blank to inspect the latest transaction:',
      },
    ],
  },
  '51-failed-transaction-analysis': {
    name: '51-failed-transaction-analysis',
    description:
      'Inspect failed transactions and translate result codes into human-readable diagnostics',
    run: loadExample('../examples/51-failed-transaction-analysis'),
    params: [
      {
        type: 'input',
        name: 'transactionHash',
        message: 'Optional transaction hash (blank searches recent failed transactions):',
      },
    ],
  },
  '148-result-code-decoder': {
    name: '148-result-code-decoder',
    description:
      'Retrieve a transaction from Horizon and decode transaction and operation result codes into diagnostics',
    run: loadExample('../examples/148-result-code-decoder'),
    params: [
      {
        type: 'input',
        name: 'transactionHash',
        message: 'Enter the 64-character transaction hash:',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output JSON?',
        default: false,
      },
    ],
  },
  '55-trade-history': {
    name: '55-trade-history',
    description:
      'Retrieve completed SDEX trades for an asset pair and summarize volume and average price',
    run: loadExample('../examples/55-trade-history'),
    params: [
      {
        type: 'input',
        name: 'baseAsset',
        message: 'Base asset ("native" or CODE:ISSUER, blank uses a recently traded pair):',
      },
      {
        type: 'input',
        name: 'counterAsset',
        message: 'Counter asset ("native" or CODE:ISSUER, blank uses a recently traded pair):',
      },
      {
        type: 'input',
        name: 'limit',
        message: 'Number of trades to retrieve (1-200):',
        default: '10',
      },
    ],
  },
  '56-account-flags-inspection': {
    name: '56-account-flags-inspection',
    description:
      'Inspect and interpret Horizon account flags, master key state, and restrictive configurations',
    run: loadExample('../examples/56-account-flags-inspection'),
    params: [
      {
        type: 'input',
        name: 'accountId',
        message: 'Optional account ID (blank uses recent active account):',
      },
    ],
  },
  '54-fee-stats': {
    name: '54-fee-stats',
    description: 'Query Horizon fee statistics, fee distributions, and recommended fee values',
    run: loadExample('../examples/54-fee-stats'),
  },
  '57-account-reserve-calculator': {
    name: '57-account-reserve-calculator',
    description: 'Calculate an account minimum reserve and available balance from ledger entries',
    run: loadExample('../examples/57-account-reserve-calculator'),
    params: [
      {
        type: 'input',
        name: 'accountId',
        message: 'Optional account ID (blank uses recent active account):',
      },
    ],
  },
  '58-account-relationship-discovery': {
    name: '58-account-relationship-discovery',
    description:
      'Discover and summarize signers, asset issuers, sponsorships, and counterparties for an account',
    run: loadExample('../examples/58-account-relationship-discovery'),
    params: [
      {
        type: 'input',
        name: 'accountId',
        message: 'Optional account ID (blank uses recent active account):',
      },
    ],
  },
  '66-ledger-effects': {
    name: '66-ledger-effects',
    description:
      'Retrieve every effect produced by one closed ledger, grouped by effect type with summary statistics',
    run: loadExample('../examples/66-ledger-effects'),
    params: [
      {
        type: 'input',
        name: 'ledgerSequence',
        message: 'Ledger sequence (blank uses the latest closed ledger):',
      },
      {
        type: 'input',
        name: 'limit',
        message: 'Number of effects to retrieve (1-500):',
        default: '25',
      },
    ],
  },
  '67-soroban-contract-events': {
    name: '67-soroban-contract-events',
    description:
      'Query Soroban contract events over a ledger range and decode topics, payloads, and ledger references',
    run: loadExample('../examples/67-soroban-contract-events'),
    params: [
      {
        type: 'input',
        name: 'contractId',
        message: 'Contract ID (blank discovers a recently active contract):',
      },
      {
        type: 'input',
        name: 'startLedger',
        message: 'Start ledger (blank scans the last ~24h of ledgers):',
      },
      {
        type: 'input',
        name: 'endLedger',
        message: 'End ledger (blank queries up to the latest ledger):',
      },
      {
        type: 'input',
        name: 'limit',
        message: 'Number of events to retrieve (1-200):',
        default: '10',
      },
    ],
  },
  '60-network-configuration': {
    name: '60-network-configuration',
    description:
      'Configure Testnet/Mainnet Horizon, Soroban RPC, and network passphrase for transaction signing',
    run: loadExample('../examples/60-network-configuration'),
    params: [
      {
        type: 'list',
        name: 'network',
        message: 'Select Stellar network:',
        default: 'testnet',
        choices: [
          { name: 'Testnet', value: 'testnet' },
          { name: 'Mainnet (Public)', value: 'mainnet' },
        ],
      },
    ],
  },
  '61-horizon-resource-filtering': {
    name: '61-horizon-resource-filtering',
    description:
      'Demonstrate filtered Horizon queries across transactions, operations, payments, and effects',
    run: loadExample('../examples/61-horizon-resource-filtering'),
    params: [
      {
        type: 'input',
        name: 'accountId',
        message: 'Optional account ID (blank uses recent active account):',
      },
    ],
  },
  '140-account-reserve-analysis': {
    name: '140-account-reserve-analysis',
    description:
      'Inspect account reserve requirements, subentries, liabilities, and estimated spendable XLM',
    run: loadExample('../examples/140-account-reserve-analysis'),
  },
  '62-payment-history': {
    name: '62-payment-history',
    description:
      'Retrieve an account payment history, identify incoming and outgoing transfers, and display assets and transaction references',
    run: loadExample('../examples/62-payment-history'),
    params: [
      {
        type: 'input',
        name: 'accountId',
        message: 'Optional account ID (blank discovers a recently active account):',
      },
      {
        type: 'input',
        name: 'limit',
        message: 'Number of payment records to retrieve (1-200):',
        default: '10',
      },
    ],
  },
  '141-sequence-number-management': {
    name: '141-sequence-number-management',
    description:
      'Retrieve, allocate, detect stale, and manage Stellar account sequence numbers across transactions',
    run: loadExample('../examples/141-sequence-number-management'),
    params: [
      {
        type: 'input',
        name: 'transactionCount',
        message: 'Number of sequential transactions to build and submit (default 3):',
        default: '3',
      },
      {
        type: 'list',
        name: 'json',
        message: 'Output format:',
        default: 'false',
        choices: [
          { name: 'Human-readable', value: 'false' },
          { name: 'JSON', value: 'true' },
        ],
      },
    ],
  },
  '142-batch-transaction-construction': {
    name: '142-batch-transaction-construction',
    description:
      'Construct, inspect, and optionally submit a batch of independent transactions with sequential sequence numbers',
    run: loadExample('../examples/142-batch-transaction-construction'),
    params: [
      {
        type: 'input',
        name: 'batchSize',
        message: 'Number of transactions in the batch (default 3):',
        default: '3',
      },
      {
        type: 'list',
        name: 'dryRun',
        message: 'Run mode:',
        default: 'false',
        choices: [
          { name: 'Submit transactions', value: 'false' },
          { name: 'Dry-run (inspect only, no submission)', value: 'true' },
        ],
      },
      {
        type: 'list',
        name: 'json',
        message: 'Output format:',
        default: 'false',
        choices: [
          { name: 'Human-readable', value: 'false' },
          { name: 'JSON', value: 'true' },
        ],
      },
    ],
  },
  '143-transaction-time-bounds': {
    name: '143-transaction-time-bounds',
    description:
      'Construct, inspect, validate, and submit transactions with time bounds; observe txTOO_EARLY and txTOO_LATE',
    run: loadExample('../examples/143-transaction-time-bounds'),
    params: [
      {
        type: 'list',
        name: 'json',
        message: 'Output format:',
        default: 'false',
        choices: [
          { name: 'Human-readable', value: 'false' },
          { name: 'JSON', value: 'true' },
        ],
      },
    ],
  },
  '63-asset-discovery': {
    name: '63-asset-discovery',
    description:
      'Browse and search Horizon asset records by code, issuer, holder counts, balances, and claimable-balance statistics',
    run: loadExample('../examples/63-asset-discovery'),
    params: [
      {
        type: 'input',
        name: 'assetCode',
        message: 'Optional asset code filter (blank browses indexed assets):',
      },
      {
        type: 'input',
        name: 'limit',
        message: 'Number of asset records to retrieve (1-200):',
        default: '10',
      },
    ],
  },
  '64-liquidity-pool-inspection': {
    name: '64-liquidity-pool-inspection',
    description:
      'Browse Horizon liquidity pools or inspect one pool ID, including reserves, shares, fees, and participants',
    run: loadExample('../examples/64-liquidity-pool-inspection'),
    params: [
      {
        type: 'input',
        name: 'poolId',
        message: 'Optional 64-character pool ID (blank browses available pools):',
      },
      {
        type: 'input',
        name: 'limit',
        message: 'Number of liquidity pools to retrieve (1-200):',
        default: '5',
      },
    ],
  },
  '65-offer-book-inspection': {
    name: '65-offer-book-inspection',
    description:
      'Inspect active Horizon offers with optional selling and buying asset filters and market summary statistics',
    run: loadExample('../examples/65-offer-book-inspection'),
    params: [
      {
        type: 'input',
        name: 'sellingAsset',
        message: 'Optional selling asset ("native", "XLM", or CODE:ISSUER):',
      },
      {
        type: 'input',
        name: 'buyingAsset',
        message: 'Optional buying asset ("native", "XLM", or CODE:ISSUER):',
      },
      {
        type: 'input',
        name: 'limit',
        message: 'Number of active offers to retrieve (1-200):',
        default: '10',
      },
    ],
  },
  '84-muxed-account-handling': {
    name: '84-muxed-account-handling',
    description: 'Create, parse, and validate muxed (M...) accounts and their identifiers',
    run: loadExample('../examples/84-muxed-account-handling'),
  },
  '85-transaction-fee-estimation': {
    name: '85-transaction-fee-estimation',
    description: 'Estimate transaction fees from network fee stats across priority levels',
    run: loadExample('../examples/85-transaction-fee-estimation'),
  },
  '86-transaction-memo-handling': {
    name: '86-transaction-memo-handling',
    description: 'Build, encode, and decode every supported Stellar transaction memo type',
    run: loadExample('../examples/86-transaction-memo-handling'),
  },
  '87-transaction-envelope-inspection': {
    name: '87-transaction-envelope-inspection',
    description: 'Inspect transaction envelopes, signatures, and XDR round-tripping',
    run: loadExample('../examples/87-transaction-envelope-inspection'),
  },
  '149-transaction-envelope-size': {
    name: '149-transaction-envelope-size',
    description:
      'Build transactions and compare serialized XDR envelope sizes across operations, signatures, memos, and fee bumps',
    run: loadExample('../examples/149-transaction-envelope-size'),
    params: [
      {
        type: 'input',
        name: 'operationCount',
        message: 'Number of payment operations (0-100):',
        default: '2',
      },
      {
        type: 'input',
        name: 'memoText',
        message: 'Memo text (blank for the default memo):',
        default: 'Envelope size analysis',
      },
      {
        type: 'input',
        name: 'extraSignatures',
        message: 'Additional signatures beyond the source signer (0-20):',
        default: '1',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output JSON?',
        default: false,
      },
    ],
  },
  '150-mixed-operation-transaction': {
    name: '150-mixed-operation-transaction',
    description:
      'Build and inspect an atomic transaction containing payment, manageData, and bumpSequence operations',
    run: loadExample('../examples/150-mixed-operation-transaction'),
    params: [
      {
        type: 'input',
        name: 'sourceAccount',
        message: 'Existing Horizon source account ID:',
      },
      {
        type: 'confirm',
        name: 'dryRun',
        message: 'Run as a dry run without submission?',
        default: true,
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output JSON?',
        default: false,
      },
    ],
  },
  '151-fee-bump-wrapping': {
    name: '151-fee-bump-wrapping',
    description:
      'Wrap and validate a base64 Stellar transaction envelope with a fee-bump transaction without submitting it',
    run: loadExample('../examples/151-fee-bump-wrapping'),
    params: [
      {
        type: 'input',
        name: 'innerEnvelope',
        message: 'Base64-encoded inner transaction envelope:',
      },
      {
        type: 'input',
        name: 'feeSourceAccount',
        message: 'Existing Horizon fee-source account ID:',
      },
      {
        type: 'input',
        name: 'bumpFee',
        message: 'Fee-bump base fee in stroops:',
        default: '500',
      },
      {
        type: 'confirm',
        name: 'dryRun',
        message: 'Run as a dry run without submission?',
        default: true,
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output JSON?',
        default: false,
      },
    ],
  },
  '88-claimable-balance-inspection': {
    name: '88-claimable-balance-inspection',
    description: 'Query and inspect claimable balances, assets, amounts, claimants, and predicates',
    run: loadExample('../examples/88-claimable-balance-inspection'),
  },
  '89-account-data-inspection': {
    name: '89-account-data-inspection',
    description:
      'Inspect account data entries, decode base64 values, and explain Manage Data state changes',
    run: loadExample('../examples/89-account-data-inspection'),
  },
  '68-soroban-contract-simulation': {
    name: '68-soroban-contract-simulation',
    description:
      'Simulate a Soroban contract invocation, inspect resource estimates and returned values, and assemble the transaction footprint',
    run: loadExample('../examples/68-soroban-contract-simulation'),
  },
  '69-soroban-contract-storage': {
    name: '69-soroban-contract-storage',
    description:
      'Retrieve and inspect Soroban contract storage entries, decode keys and values, and explain instance, persistent, and temporary durability',
    run: loadExample('../examples/69-soroban-contract-storage'),
  },
  '70-soroban-authorization': {
    name: '70-soroban-authorization',
    description:
      'Invoke an authorized Soroban contract method, inspect authorization entries, sign them, and distinguish auth from transaction signatures',
    run: loadExample('../examples/70-soroban-authorization'),
  },
  '71-soroban-storage-update': {
    name: '71-soroban-storage-update',
    description:
      'Read initial contract storage, invoke a state-modifying method, confirm the transaction, and verify the updated storage value',
    run: loadExample('../examples/71-soroban-storage-update'),
  },
  '82-transaction-time-bounds': {
    name: '82-transaction-time-bounds',
    description:
      'Build, simulate, sign, and submit a Soroban contract invocation with custom time bounds, and demonstrate expired and invalid time-bounds handling',
    run: loadExample('../examples/82-transaction-time-bounds'),
  },
  '80-offline-transaction-workflow': {
    name: '80-offline-transaction-workflow',
    description:
      'Prepare and serialize an unsigned transaction, sign it in a simulated offline environment, handle corrupted XDR gracefully, and submit the reconstructed transaction',
    run: loadExample('../examples/80-offline-transaction-workflow'),
    params: [
      {
        type: 'input',
        name: 'amount',
        message: 'Enter payment amount (XLM):',
        default: '10',
      },
    ],
  },
  '100-authorization-entry-inspection': {
    name: '100-authorization-entry-inspection',
    description:
      'Decode a SorobanAuthorizationEntry: distinguish source-account from address credentials, walk the invocation tree, and read nonce and expiration',
    run: loadExample('../examples/100-authorization-entry-inspection'),
  },
  '101-simulation-result-analysis': {
    name: '101-simulation-result-analysis',
    description:
      'Interpret a simulateTransaction response: resource budget, ledger footprint, return value, diagnostic events, and restore preamble',
    run: loadExample('../examples/101-simulation-result-analysis'),
  },
  '102-contract-storage-inspection': {
    name: '102-contract-storage-inspection',
    description:
      'Probe contract storage keys across persistent and temporary durability, decode raw and native values, and handle missing keys gracefully',
    run: loadExample('../examples/102-contract-storage-inspection'),
  },
  '103-storage-ttl-management': {
    name: '103-storage-ttl-management',
    description:
      'Read a storage entry TTL, classify how much life it has left, and build, simulate, and submit an ExtendFootprintTTL transaction',
    run: loadExample('../examples/103-storage-ttl-management'),
  },
  '104-contract-restoration': {
    name: '104-contract-restoration',
    description:
      'Detect archived Soroban contract state, simulate and submit RestoreFootprint, and verify accessibility',
    run: loadExample('../examples/104-contract-restoration'),
  },
  '106-scval-serialization': {
    name: '106-scval-serialization',
    description:
      'Convert JavaScript values to Soroban ScVal objects and back with reusable helpers',
    run: loadExample('../examples/106-scval-serialization'),
  },
  '105-contract-event-decoding': {
    name: '105-contract-event-decoding',
    description:
      'Retrieve Soroban contract events and decode topics and payloads with raw XDR side-by-side',
    run: loadExample('../examples/105-contract-event-decoding'),
  },
  '107-contract-spec-introspection': {
    name: '107-contract-spec-introspection',
    description:
      'Retrieve and parse Soroban contract specifications, displaying functions, types, and docs',
    run: loadExample('../examples/107-contract-spec-introspection'),
    params: [
      {
        type: 'input',
        name: 'contractId',
        message: 'Contract ID (blank uses native SAC on Testnet):',
        default: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      },
      {
        type: 'input',
        name: 'startLedger',
        message: 'Start ledger (blank scans ~24h):',
      },
      {
        type: 'input',
        name: 'limit',
        message: 'Number of events to decode (1-50):',
        default: '5',
      },
      {
        type: 'input',
        name: 'functionName',
        message: 'Optional function name for dynamic selection:',
      },
    ],
  },
  '108-dynamic-contract-invocation': {
    name: '108-dynamic-contract-invocation',
    description:
      'Discover a Soroban contract specification at runtime, encode arguments dynamically, simulate the invocation, and decode the return value',
    run: loadExample('../examples/108-dynamic-contract-invocation'),
    params: [
      {
        type: 'input',
        name: 'contractId',
        message: 'Contract ID:',
        default: 'CDVSGPL3HFBGJ6ZEYQUAVE3OH3XE2ZE5ZT2GWPA3LKOYVD4UBPQJ2VHB',
      },
      {
        type: 'input',
        name: 'functionName',
        message: 'Contract function to invoke:',
        default: 'hello',
      },
      {
        type: 'input',
        name: 'argsJson',
        message: 'Arguments as a JSON object:',
        default: '{"to":"Soroban"}',
      },
    ],
  },
  '109-soroban-transaction-preparation': {
    name: '109-soroban-transaction-preparation',
    description:
      'Build, simulate, prepare, and inspect a Soroban transaction before signing or submission',
    run: loadExample('../examples/109-soroban-transaction-preparation'),
    params: [
      {
        type: 'input',
        name: 'contractId',
        message: 'Contract ID:',
        default: 'CDVSGPL3HFBGJ6ZEYQUAVE3OH3XE2ZE5ZT2GWPA3LKOYVD4UBPQJ2VHB',
      },
      {
        type: 'input',
        name: 'functionName',
        message: 'Contract function:',
        default: 'hello',
      },
      {
        type: 'input',
        name: 'argument',
        message: 'String argument:',
        default: 'Soroban',
      },
    ],
  },
  '110-soroban-transaction-submission': {
    name: '110-soroban-transaction-submission',
    description:
      'Prepare, sign, submit, poll, and inspect the final result of a Soroban transaction',
    run: loadExample('../examples/110-soroban-transaction-submission'),
    params: [
      {
        type: 'input',
        name: 'contractId',
        message: 'Contract ID:',
        default: 'CDVSGPL3HFBGJ6ZEYQUAVE3OH3XE2ZE5ZT2GWPA3LKOYVD4UBPQJ2VHB',
      },
      {
        type: 'input',
        name: 'functionName',
        message: 'Contract function:',
        default: 'hello',
      },
      {
        type: 'input',
        name: 'argument',
        message: 'String argument:',
        default: 'Soroban',
      },
      {
        type: 'input',
        name: 'pollIntervalMs',
        message: 'Polling interval in milliseconds:',
        default: '1000',
      },
      {
        type: 'input',
        name: 'pollTimeoutMs',
        message: 'Polling timeout in milliseconds:',
        default: '30000',
      },
    ],
  },
  '111-soroban-transaction-error-diagnosis': {
    name: '111-soroban-transaction-error-diagnosis',
    description:
      'Retrieve a failed Soroban transaction, classify the failure, decode diagnostics, and provide troubleshooting guidance',
    run: loadExample('../examples/111-soroban-transaction-error-diagnosis'),
    params: [
      {
        type: 'input',
        name: 'transactionHash',
        message: 'Failed transaction hash (blank searches recent failed Soroban transactions):',
      },
    ],
  },
  '81-transaction-preflight': {
    name: '81-transaction-preflight',
    description:
      'Run the full Soroban preflight workflow: simulate, extract footprint/auth/resource-fee data, assemble, sign, submit, and confirm',
    run: loadExample('../examples/81-transaction-preflight'),
  },
  '83-multi-contract-transaction': {
    name: '83-multi-contract-transaction',
    description:
      'Compose a single orchestrator contract invocation touching multiple downstream contracts, simulate and submit it, and explain atomicity and execution order',
    run: loadExample('../examples/83-multi-contract-transaction'),
  },
  '93-trustline-management': {
    name: '93-trustline-management',
    description:
      'Create, inspect, update, and remove asset trustlines — demonstrating changeTrust, limit updates, authorization status, and the reserve cost of each subentry',
    run: loadExample('../examples/93-trustline-management'),
    params: [
      {
        type: 'input',
        name: 'assetCode',
        message: 'Asset code for the trustline (blank uses DEMO):',
        default: 'DEMO',
      },
    ],
  },
  '92-account-payment-stream': {
    name: '92-account-payment-stream',
    description:
      'Subscribe to a Horizon account payment stream, display incoming and outgoing payments in real time, handle errors, and explain streaming versus polling',
    run: loadExample('../examples/92-account-payment-stream'),
    params: [
      {
        type: 'input',
        name: 'accountId',
        message: 'Account ID to monitor (blank discovers a recently active account):',
      },
      {
        type: 'list',
        name: 'paymentFilter',
        message: 'Payment direction filter:',
        default: 'all',
        choices: [
          { name: 'All payments (incoming + outgoing)', value: 'all' },
          { name: 'Incoming only', value: 'incoming' },
          { name: 'Outgoing only', value: 'outgoing' },
        ],
      },
    ],
  },
  '126-claimable-balance-management': {
    name: '126-claimable-balance-management',
    description: 'Discover, inspect, filter, and claim eligible Stellar claimable balances',
    run: loadExample('../examples/126-claimable-balance-management'),
    params: [
      {
        type: 'input',
        name: 'assetFilter',
        message: 'Optional asset filter ("native" or CODE:ISSUER, blank shows all):',
      },
    ],
  },
  '128-account-authorization-flags': {
    name: '128-account-authorization-flags',
    description:
      'Inspect and manage issuer account authorization flags and trustline authorization',
    run: loadExample('../examples/128-account-authorization-flags'),
    params: [
      {
        type: 'input',
        name: 'assetCode',
        message: 'Asset code to demonstrate authorization on (blank uses AUTHCOIN):',
        default: 'AUTHCOIN',
      },
    ],
  },
  '130-sponsored-reserve-management': {
    name: '130-sponsored-reserve-management',
    description:
      "Sponsor a trustline and a data entry, inspect reserve responsibility, then revoke one entry's sponsorship",
    run: loadExample('../examples/130-sponsored-reserve-management'),
  },
  '131-path-payment-route-inspection': {
    name: '131-path-payment-route-inspection',
    description:
      'Discover and rank strict-receive path payment routes without submitting a payment',
    run: loadExample('../examples/131-path-payment-route-inspection'),
    params: [
      {
        type: 'input',
        name: 'destAmount',
        message: 'Fixed destination amount to price routes for (blank uses 25):',
        default: '25',
      },
      {
        type: 'input',
        name: 'maxRoutes',
        message: 'Maximum number of routes to display (blank uses 5):',
        default: '5',
      },
    ],
  },
  '139-account-offer-inspection': {
    name: '139-account-offer-inspection',
    description:
      "Inspect an account's open SDEX offers, grouped by trading pair with summary statistics",
    run: loadExample('../examples/139-account-offer-inspection'),
    params: [
      {
        type: 'input',
        name: 'accountId',
        message: 'Enter Stellar account ID to inspect offers:',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output results in JSON format?',
        default: false,
      },
    ],
  },
  '138-account-merge-preflight': {
    name: '138-account-merge-preflight',
    description: 'Inspect a Stellar account and determine whether it is ready for an account merge',
    run: loadExample('../examples/138-account-merge-preflight'),
    params: [
      {
        type: 'input',
        name: 'sourceAccountId',
        message: 'Enter source account ID (to be merged/deleted):',
      },
      {
        type: 'input',
        name: 'destinationAccountId',
        message: 'Enter destination account ID:',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output results in JSON format?',
        default: false,
      },
    ],
  },
  '132-fee-bump-inspection': {
    name: '132-fee-bump-inspection',
    description: 'Decode and inspect a fee-bump transaction envelope entirely offline',
    run: loadExample('../examples/132-fee-bump-inspection'),
    params: [
      {
        type: 'input',
        name: 'envelopeXdr',
        message: 'Enter base64 transaction envelope XDR (leave blank to generate sample):',
      },
    ],
  },
  '136-transaction-fee-estimation': {
    name: '136-transaction-fee-estimation',
    description: 'Estimate transaction fees from network fee statistics across operation sizes',
    run: loadExample('../examples/136-transaction-fee-estimation'),
    params: [
      {
        type: 'input',
        name: 'operationCount',
        message: 'Enter number of operations for fee estimation:',
        default: '1',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output results in JSON format?',
        default: false,
      },
    ],
  },
  '124-liquidity-pool-inspection': {
    name: '124-liquidity-pool-inspection',
    description: 'Retrieve and analyze a Stellar liquidity pool state and reserves',
    run: loadExample('../examples/124-liquidity-pool-inspection'),
    params: [
      {
        type: 'input',
        name: 'assetA',
        message: 'Enter Asset A (native or CODE:ISSUER):',
        default: 'native',
      },
      { type: 'input', name: 'assetB', message: 'Enter Asset B (CODE:ISSUER):' },
    ],
  },
  '125-liquidity-pool-simulation': {
    name: '125-liquidity-pool-simulation',
    description: 'Simulate liquidity pool deposit and withdrawal operations',
    run: loadExample('../examples/125-liquidity-pool-simulation'),
  },
  '127-trustline-management': {
    name: '127-trustline-management',
    description: 'Retrieve, inspect, create, modify, and remove Stellar trustlines',
    run: loadExample('../examples/127-trustline-management'),
  },
  '129-asset-clawback': {
    name: '129-asset-clawback',
    description: 'Inspect clawback configuration and construct a clawback transaction',
    run: loadExample('../examples/129-asset-clawback'),
  },
  '133-transaction-signature-verification': {
    name: '133-transaction-signature-verification',
    description: 'Decode a transaction envelope and verify its cryptographic signatures offline',
    run: loadExample('../examples/133-transaction-signature-verification'),
    params: [
      { type: 'input', name: 'envelopeXdr', message: 'Enter base64 transaction envelope:' },
      {
        type: 'input',
        name: 'publicKeys',
        message: 'Enter comma-separated public keys to verify against:',
      },
    ],
  },
  '134-multisignature-threshold-inspection': {
    name: '134-multisignature-threshold-inspection',
    description: 'Inspect account signers, thresholds, and evaluate transaction authorization',
    run: loadExample('../examples/134-multisignature-threshold-inspection'),
  },
  '135-transaction-preflight-validation': {
    name: '135-transaction-preflight-validation',
    description: 'Perform preflight validation checks on a transaction envelope before submission',
    run: loadExample('../examples/135-transaction-preflight-validation'),
  },
  '137-dynamic-fee-selection': {
    name: '137-dynamic-fee-selection',
    description: 'Retrieve fee stats and calculate transaction fees using dynamic strategies',
    run: loadExample('../examples/137-dynamic-fee-selection'),
  },
  '157-horizon-pagination': {
    name: '157-horizon-pagination',
    description:
      'Traverse multiple Horizon collections with reusable pagination, duplicate prevention, and metrics',
    run: loadExample('../examples/157-horizon-pagination'),
    params: [
      {
        type: 'input',
        name: 'pageSize',
        message: 'Records per page:',
        default: '5',
      },
      {
        type: 'input',
        name: 'maxRecords',
        message: 'Maximum records per collection:',
        default: '15',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output JSON?',
        default: false,
      },
    ],
  },
  '158-resilient-horizon-streaming': {
    name: '158-resilient-horizon-streaming',
    description:
      'Consume a Horizon stream with cursor resume, duplicate filtering, and exponential backoff reconnects',
    run: loadExample('../examples/158-resilient-horizon-streaming'),
    params: [
      {
        type: 'list',
        name: 'resource',
        message: 'Horizon stream resource:',
        choices: ['payments', 'operations', 'transactions'],
        default: 'payments',
      },
      {
        type: 'input',
        name: 'maxEvents',
        message: 'Maximum events before stopping (blank = duration only):',
        default: '3',
      },
      {
        type: 'input',
        name: 'streamDurationSeconds',
        message: 'Stream duration in seconds:',
        default: '8',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output JSON?',
        default: false,
      },
    ],
  },
  '159-horizon-stream-filtering': {
    name: '159-horizon-stream-filtering',
    description:
      'Apply client-side AND/OR filters to Horizon operation streams while preserving the underlying cursor',
    run: loadExample('../examples/159-horizon-stream-filtering'),
    params: [
      {
        type: 'list',
        name: 'filterMode',
        message: 'Filter evaluation mode:',
        choices: ['and', 'or'],
        default: 'and',
      },
      {
        type: 'input',
        name: 'operationType',
        message: 'Operation type filter:',
        default: 'payment',
      },
      {
        type: 'input',
        name: 'maxEvents',
        message: 'Maximum accepted events:',
        default: '3',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output JSON?',
        default: false,
      },
    ],
  },
  '160-horizon-retry-rate-limit': {
    name: '160-horizon-retry-rate-limit',
    description:
      'Retry transient Horizon failures and rate limits with Retry-After parsing and request diagnostics',
    run: loadExample('../examples/160-horizon-retry-rate-limit'),
    params: [
      {
        type: 'input',
        name: 'accountId',
        message: 'Account ID for sample requests (optional):',
      },
      {
        type: 'input',
        name: 'maxRetries',
        message: 'Maximum retry attempts:',
        default: '4',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output JSON?',
        default: false,
      },
    ],
  },
  '165-payment-reconciliation': {
    name: '165-payment-reconciliation',
    description: 'Inspect recent account payments and derive a minimal reconciliation summary',
    run: loadExample('../examples/165-payment-reconciliation'),
  },
  '166-persistent-payment-monitoring': {
    name: '166-persistent-payment-monitoring',
    description: 'Inspect recent account payments and derive a minimal monitoring checkpoint',
    run: loadExample('../examples/166-persistent-payment-monitoring'),
  },
  '167-asset-and-trustline-inspection': {
    name: '167-asset-and-trustline-inspection',
    description: 'Inspect account trustlines and summarize non-native asset holdings',
    run: loadExample('../examples/167-asset-and-trustline-inspection'),
  },
  '168-issuer-authorization-inspection': {
    name: '168-issuer-authorization-inspection',
    description: 'Inspect asset authorization flags and trustline authorization-related balances',
    run: loadExample('../examples/168-issuer-authorization-inspection'),
  },
};
