import { WorkflowError } from '../utils/example-input';
import dotenv from 'dotenv';
import { Horizon, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { resolveNetworkConfiguration } from './60-network-configuration';
import { accountId, amount, amountUnits, asset } from '../utils/example-input';

export interface Trustline {
  balance: string;
  limit: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
}

export function validateChange(action: string, limit: string, line?: Trustline): string {
  if (!['create', 'update', 'remove'].includes(action))
    throw new WorkflowError('Action must be create, update, or remove');
  if (action === 'create' && line) throw new WorkflowError('Trustline already exists; use update');
  if (action !== 'create' && !line) throw new WorkflowError('No matching trustline');
  const requested = action === 'remove' ? '0' : amount(limit);
  if (line) {
    amount(line.balance, true);
    const buying = amount(line.buying_liabilities || '0', true);
    const selling = amount(line.selling_liabilities || '0', true);
    if (
      action === 'remove' &&
      (amountUnits(line.balance) !== 0n ||
        amountUnits(buying) !== 0n ||
        amountUnits(selling) !== 0n)
    ) {
      throw new WorkflowError(
        'Resolve the asset balance and cancel outstanding offers/liabilities before removal',
      );
    }
    if (amountUnits(requested) < amountUnits(line.balance) + amountUnits(buying)) {
      throw new WorkflowError('Limit cannot be below balance plus buying liabilities');
    }
  }
  return requested;
}

export async function run(): Promise<void> {
  const config = resolveNetworkConfiguration();
  const owner = accountId(process.env.ACCOUNT_ID);
  const issued = asset(process.env.TRUST_ASSET);
  if (issued.isNative()) throw new WorkflowError('XLM is native and needs no trustline');
  if (issued.getIssuer() === owner) throw new WorkflowError('An issuer cannot trust its own asset');
  const server = new Horizon.Server(config.horizonUrl);
  const account = await server.loadAccount(owner);
  const lines = account.balances.filter(
    (b) => b.asset_type === 'credit_alphanum4' || b.asset_type === 'credit_alphanum12',
  );
  console.table(
    lines.map((b) => ({
      code: b.asset_code,
      issuer: b.asset_issuer,
      balance: b.balance,
      limit: b.limit,
    })),
  );
  const action = process.env.TRUST_ACTION || 'inspect';
  if (action === 'inspect') return;
  const line = lines.find(
    (b) => b.asset_code === issued.getCode() && b.asset_issuer === issued.getIssuer(),
  );
  const limit = validateChange(action, process.env.TRUST_LIMIT || '', line);
  await server.loadAccount(issued.getIssuer());
  const transaction = new TransactionBuilder(account, {
    fee: String(await server.fetchBaseFee()),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset: issued, limit }))
    .setTimeout(180)
    .build();
  console.log('Unsigned transaction XDR (not simulated, signed, or submitted):');
  console.log(transaction.toXDR());
}

if (require.main === module) {
  dotenv.config();
  run().catch((error: unknown) => {
    console.error(
      error instanceof WorkflowError
        ? error.message
        : 'Retrieval or processing failed; check network availability and checkpoint scope. The failing batch was not checkpointed.',
    );
    process.exitCode = 1;
  });
}
