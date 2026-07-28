import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { createHash } from 'crypto';

/**
 * Builds a memo of the requested type, surfacing SDK validation errors clearly.
 */
export function buildMemo(type: string, value: string): Memo {
  switch (type) {
    case 'MEMO_TEXT':
      return Memo.text(value);
    case 'MEMO_ID':
      return Memo.id(value);
    case 'MEMO_HASH':
      return Memo.hash(value);
    case 'MEMO_RETURN':
      return Memo.return(value);
    case 'MEMO_NONE':
      return Memo.none();
    default:
      throw new Error(`Unsupported memo type: ${type}`);
  }
}

/**
 * Describes a memo the way it would be read back off a submitted transaction.
 */
export function describeMemo(memo: Memo): string {
  const value = memo.value;
  const encoded = Buffer.isBuffer(value) ? value.toString('hex') : String(value ?? '');
  return `${memo.type} -> ${encoded || '(empty)'}`;
}

/**
 * Attaches a memo to a minimal payment transaction and returns its XDR.
 */
export function buildTransactionWithMemo(memo: Memo, sourceAccountId: string): string {
  const account = new Account(sourceAccountId, '0');

  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.payment({
        destination: sourceAccountId,
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .addMemo(memo)
    .setTimeout(30)
    .build()
    .toXDR();
}

/**
 * Runs the transaction memo handling example.
 */
export async function run(): Promise<void> {
  console.log('Starting Transaction Memo Handling Example...');

  const source = Keypair.random().publicKey();
  const hash = createHash('sha256').update('invoice-1042').digest('hex');

  const samples: Array<[string, string]> = [
    ['MEMO_TEXT', 'deposit:alice'],
    ['MEMO_ID', '1042'],
    ['MEMO_HASH', hash],
    ['MEMO_RETURN', hash],
  ];

  for (const [type, value] of samples) {
    const memo = buildMemo(type, value);
    const xdr = buildTransactionWithMemo(memo, source);

    console.log(`\n${describeMemo(memo)}`);
    console.log(`  Transaction XDR length: ${xdr.length}`);

    // Reading a memo back from a submitted transaction uses the same fields.
    const parsed = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as any;
    console.log(`  Decoded from XDR: ${describeMemo(parsed.memo)}`);
  }

  try {
    buildMemo('MEMO_TEXT', 'x'.repeat(29));
  } catch (error: any) {
    console.log(`\nHandled invalid memo: ${error.message}`);
  }

  console.log('\nNotes:');
  console.log('  - MEMO_TEXT is limited to 28 bytes; MEMO_HASH/RETURN are exactly 32 bytes.');
  console.log('  - MEMO_ID is a uint64, the usual choice for exchange deposit identifiers.');
  console.log('  - Memos are public forever: never store names, emails, or secrets in them.');

  console.log('\nMemo handling completed successfully.');
}
