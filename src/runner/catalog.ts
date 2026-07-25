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
  '37-strict-send-path-payment': {
    name: '37-strict-send-path-payment',
    description: 'Execute a strict-send path payment and observe the received amount',
    run: loadExample('../examples/37-strict-send-path-payment'),
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
};
