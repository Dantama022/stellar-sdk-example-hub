import { run as runCreateAccount } from '../examples/01-create-account';
import { run as runPayment } from '../examples/02-payment';
import { run as runTrustline } from '../examples/03-create-trustline';
import { run as runMultisig } from '../examples/04-multisig';
import { run as runSorobanInvoke } from '../examples/05-soroban-invoke';
import { run as runClaimableBalances } from '../examples/07-claimable-balances';
import { run as runFeeBump } from '../examples/09-fee-bump';
import { run as runTimeLockedEscrow } from '../examples/14-time-locked-escrow';
import { run as runBatchedOperations } from '../examples/16-batched-operations';
import { run as runAssetIssuance } from '../examples/12-asset-issuance';
import { run as runOfflineSigning } from '../examples/17-offline-signing';
import { run as runSorobanErrors } from '../examples/18-soroban-errors';
import { run as runSep10Authentication } from '../examples/20-sep10-authentication';
import { run as runManageBuyOffer } from '../examples/22-manage-buy-offer';
import { run as runManageDataEntries } from '../examples/23-manage-data-entries';
import { run as runPassiveSellOffer } from '../examples/24-create-passive-sell-offer';
import { run as runAccountFlags } from '../examples/25-account-flags';
import { run as runSorobanEvents } from '../examples/10-soroban-events';
import { run as runSorobanDeploy } from '../examples/13-soroban-deploy';
import { run as runAccountMerge } from '../examples/15-account-merge';
import { run as runCrossContractInvoke } from '../examples/24-cross-contract-invoke';

export interface Example {
  name: string;
  description: string;
  run: (params?: any) => Promise<void>;
  params?: Array<{
    type: string;
    name: string;
    message: string;
    default?: any;
  }>;
}

export const examples: Record<string, Example> = {
  '01-create-account': {
    name: '01-create-account',
    description: 'Generate keypairs and fund a test account using Friendbot',
    run: runCreateAccount,
  },
  '02-payment': {
    name: '02-payment',
    description: 'Send native XLM payment to a destination address',
    run: runPayment,
  },
  '03-create-trustline': {
    name: '03-create-trustline',
    description: 'Establish a trustline for a custom asset (USD)',
    run: runTrustline,
  },
  '04-multisig': {
    name: '04-multisig',
    description: 'Configure multi-signature and modify account thresholds',
    run: runMultisig,
  },
  '05-soroban-invoke': {
    name: '05-soroban-invoke',
    description: 'Simulate and invoke a Soroban smart contract method',
    run: runSorobanInvoke,
  },
  '07-claimable-balances': {
    name: '07-claimable-balances',
    description: 'Create and claim a claimable balance with claimant predicates',
    run: runClaimableBalances,
  },
  '09-fee-bump': {
    name: '09-fee-bump',
    description: 'Wrap a source transaction in a sponsor-paid fee-bump transaction',
    run: runFeeBump,
  },
  '12-asset-issuance': {
    name: '12-asset-issuance',
    description: 'Issue a custom asset and lock the issuer account',
    run: runAssetIssuance,
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
  '14-time-locked-escrow': {
    name: '14-time-locked-escrow',
    description: 'Demonstrate a time-bounded transaction before and after validity',
    run: runTimeLockedEscrow,
  },
  '16-batched-operations': {
    name: '16-batched-operations',
    description: 'Submit multiple payment operations atomically in one transaction',
    run: runBatchedOperations,
  },
  '17-offline-signing': {
    name: '17-offline-signing',
    description: 'Construct, export XDR, sign offline, and verify a transaction',
    run: runOfflineSigning,
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
    run: runSorobanErrors,
  },
  '20-sep10-authentication': {
    name: '20-sep10-authentication',
    description:
      'SEP-10 Web Authentication: challenge generation, signing, verification, and JWT issuance',
    run: runSep10Authentication,
  },
  '22-manage-buy-offer': {
    name: '22-manage-buy-offer',
    description: 'Create, modify, and delete buy offers on the Stellar SDEX',
    run: runManageBuyOffer,
  },
  '23-manage-data-entries': {
    name: '23-manage-data-entries',
    description: 'Create, update, query, and remove account data entries on-ledger',
    run: runManageDataEntries,
  },
  '24-create-passive-sell-offer': {
    name: '24-create-passive-sell-offer',
    description: 'Create a passive sell offer on the SDEX for liquidity provisioning',
    run: runPassiveSellOffer,
  },
  '25-account-flags': {
    name: '25-account-flags',
    description:
      'View and modify issuer account flags (AUTH_REQUIRED, AUTH_REVOCABLE, AUTH_IMMUTABLE)',
    run: runAccountFlags,
  },
  '10-soroban-events': {
    name: '10-soroban-events',
    description: 'Subscribe to and decode Soroban contract event streams',
    run: runSorobanEvents,
  },
  '13-soroban-deploy': {
    name: '13-soroban-deploy',
    description: 'Upload and deploy a Soroban WASM smart contract',
    run: runSorobanDeploy,
  },
  '15-account-merge': {
    name: '15-account-merge',
    description: 'Merge an account into a destination account to recover the minimum reserve',
    run: runAccountMerge,
  },
  '24-cross-contract-invoke': {
    name: '24-cross-contract-invoke',
    description: 'Demonstrate cross-contract invocation, authorization, and returned values',
    run: runCrossContractInvoke,
  },
};
