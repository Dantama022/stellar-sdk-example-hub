/*
 * Generates the deterministic XDR fixtures used by
 * tests/transaction-result-inspector.test.ts.
 *
 * Every value below is built locally from fixed key material, so running this
 * script produces byte-identical output and never contacts a Stellar network.
 *
 * Usage (from the repository root):
 *
 *   node tests/fixtures/transaction-result/generate-fixtures.js
 *
 * The generated JSON files are committed so the test suite does not need to
 * regenerate them.
 */

const fs = require('fs');
const path = require('path');

const {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} = require('stellar-sdk-v16');

const OUTPUT_DIR = __dirname;

const SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const DESTINATION = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
const CONTRACT = Buffer.alloc(32, 3);

const NETWORK_PASSPHRASE = Networks.TESTNET;

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

function accountId(keypair) {
  return xdr.AccountId.publicKeyTypeEd25519(keypair.rawPublicKey());
}

function contractAddress() {
  return xdr.ScAddress.scAddressTypeContract(CONTRACT);
}

function accountEntry(keypair, balance) {
  return new xdr.AccountEntry({
    accountId: accountId(keypair),
    balance: xdr.Int64.fromString(balance),
    seqNum: xdr.Int64.fromString('1070000000000000000'),
    numSubEntries: 0,
    inflationDest: null,
    flags: 0,
    homeDomain: '',
    thresholds: Buffer.from([1, 0, 0, 0]),
    signers: [],
    ext: new xdr.AccountEntryExt(0),
  });
}

function ledgerEntry(data) {
  return new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 4321,
    data,
    ext: new xdr.LedgerEntryExt(0),
  });
}

function accountLedgerEntry(keypair, balance) {
  return ledgerEntry(xdr.LedgerEntryData.account(accountEntry(keypair, balance)));
}

function dataLedgerEntry(keypair, name, value) {
  return ledgerEntry(
    xdr.LedgerEntryData.data(
      new xdr.DataEntry({
        accountId: accountId(keypair),
        dataName: name,
        dataValue: Buffer.from(value, 'utf8'),
        ext: new xdr.DataEntryExt(0),
      }),
    ),
  );
}

function contractDataLedgerEntry(key, value) {
  return ledgerEntry(
    xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: contractAddress(),
        key: nativeToScVal(key, { type: 'symbol' }),
        durability: xdr.ContractDataDurability.persistent(),
        val: nativeToScVal(value, { type: 'i64' }),
      }),
    ),
  );
}

function contractCodeLedgerEntry(hash) {
  return ledgerEntry(
    xdr.LedgerEntryData.contractCode(
      new xdr.ContractCodeEntry({
        ext: new xdr.ContractCodeEntryExt(0),
        hash,
        code: Buffer.from('0061736d', 'hex'),
      }),
    ),
  );
}

function created(entry) {
  return xdr.LedgerEntryChange.ledgerEntryCreated(entry);
}

function updated(entry) {
  return xdr.LedgerEntryChange.ledgerEntryUpdated(entry);
}

function removed(key) {
  return xdr.LedgerEntryChange.ledgerEntryRemoved(key);
}

function operationMeta(changes) {
  return new xdr.OperationMeta({ changes });
}

function operationMetaV2(changes, events) {
  return new xdr.OperationMetaV2({
    ext: new xdr.ExtensionPoint(0),
    changes,
    events: events || [],
  });
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

function paymentSuccess() {
  return xdr.OperationResult.opInner(
    xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess()),
  );
}

function paymentUnderfunded() {
  return xdr.OperationResult.opInner(
    xdr.OperationResultTr.payment(xdr.PaymentResult.paymentUnderfunded()),
  );
}

function manageDataSuccess() {
  return xdr.OperationResult.opInner(
    xdr.OperationResultTr.manageData(xdr.ManageDataResult.manageDataSuccess()),
  );
}

function invokeHostFunctionSuccess(returnValueHash) {
  return xdr.OperationResult.opInner(
    xdr.OperationResultTr.invokeHostFunction(
      xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(returnValueHash),
    ),
  );
}

function invokeHostFunctionTrapped() {
  return xdr.OperationResult.opInner(
    xdr.OperationResultTr.invokeHostFunction(
      xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
    ),
  );
}

function transactionResult(code, operationResults, feeCharged) {
  const result =
    code === 'txSuccess'
      ? xdr.TransactionResultResult.txSuccess(operationResults)
      : code === 'txFailed'
        ? xdr.TransactionResultResult.txFailed(operationResults)
        : xdr.TransactionResultResult.txBadSeq();

  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString(feeCharged || '100'),
    result,
    ext: new xdr.TransactionResultExt(0),
  });
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

function contractEvent(type, topics, data, contractId) {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    // ContractId is a typedef for Hash in the XDR definitions, so a raw 32-byte
    // buffer is the encoded contract identifier.
    contractId: contractId === undefined ? CONTRACT : contractId,
    type,
    body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
  });
}

function diagnosticEvent(successful, event) {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: successful,
    event,
  });
}

function sorobanErrorEvent(code, successful) {
  const contractError = xdr.ScVal.scvError(xdr.ScError.sceContract(code));

  return diagnosticEvent(
    successful,
    contractEvent(
      xdr.ContractEventType.diagnostic(),
      [nativeToScVal('error', { type: 'symbol' })],
      contractError,
    ),
  );
}

function fnCallEvent(functionName, successful) {
  return diagnosticEvent(
    successful,
    contractEvent(
      xdr.ContractEventType.diagnostic(),
      [nativeToScVal('fn_call', { type: 'symbol' }), nativeToScVal(functionName, { type: 'symbol' })],
      nativeToScVal('invoked', { type: 'symbol' }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Metadata builders
// ---------------------------------------------------------------------------

function metaV0(operations) {
  return new xdr.TransactionMeta(0, operations);
}

function metaV1(txChanges, operations) {
  return new xdr.TransactionMeta(1, new xdr.TransactionMetaV1({ txChanges, operations }));
}

function metaV2(txChangesBefore, operations, txChangesAfter) {
  return new xdr.TransactionMeta(
    2,
    new xdr.TransactionMetaV2({ txChangesBefore, operations, txChangesAfter }),
  );
}

function metaV3(txChangesBefore, operations, txChangesAfter, sorobanMeta) {
  return new xdr.TransactionMeta(
    3,
    new xdr.TransactionMetaV3({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore,
      operations,
      txChangesAfter,
      sorobanMeta,
    }),
  );
}

function metaV4(txChangesBefore, operations, txChangesAfter, sorobanMeta, events, diagnostics) {
  return new xdr.TransactionMeta(
    4,
    new xdr.TransactionMetaV4({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore,
      operations,
      txChangesAfter,
      sorobanMeta,
      events,
      diagnosticEvents: diagnostics,
    }),
  );
}

function sorobanMetaV1(returnValue, events, diagnostics) {
  return new xdr.SorobanTransactionMeta({
    ext: new xdr.SorobanTransactionMetaExt(0),
    events,
    returnValue,
    diagnosticEvents: diagnostics,
  });
}

function sorobanMetaV2(returnValue) {
  return new xdr.SorobanTransactionMetaV2({
    ext: new xdr.SorobanTransactionMetaExt(0),
    returnValue,
  });
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

function classicEnvelope() {
  return new TransactionBuilder(new Account(SOURCE.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: DESTINATION.publicKey(),
        asset: Asset.native(),
        amount: '10',
      }),
    )
    .addOperation(
      Operation.manageData({
        name: 'config',
        value: 'v1',
      }),
    )
    .setTimeout(0)
    .build();
}

function sorobanEnvelope() {
  const invokeContract = new xdr.InvokeContractArgs({
    contractAddress: contractAddress(),
    functionName: 'increment',
    args: [nativeToScVal(1, { type: 'i32' })],
  });

  const sorobanData = new SorobanDataBuilder()
    .setResourceFee(1200)
    .setResources(1000000, 2000, 3000)
    .setReadOnly([xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: CONTRACT }))])
    .setReadWrite([
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contractAddress(),
          key: nativeToScVal('counter', { type: 'symbol' }),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      ),
    ])
    .build();

  return new TransactionBuilder(new Account(SOURCE.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(invokeContract),
        auth: [],
      }),
    )
    .setSorobanData(sorobanData)
    .setTimeout(0)
    .build();
}

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------

function baseFixture(name, description, transaction, result, meta) {
  return {
    name,
    description,
    networkPassphrase: NETWORK_PASSPHRASE,
    transactionHash: transaction.hash().toString('hex'),
    ledger: 4321,
    envelopeXdr: transaction.toEnvelope().toXDR('base64'),
    resultXdr: result.toXDR('base64'),
    resultMetaXdr: meta ? meta.toXDR('base64') : null,
  };
}

const classicTx = classicEnvelope();
const sorobanTx = sorobanEnvelope();

const fixtures = [];

// 1. Successful classic transaction with two successful operations.
fixtures.push(
  baseFixture(
    'classic-success',
    'Successful classic transaction with two successful payment/manageData operations',
    classicTx,
    transactionResult('txSuccess', [paymentSuccess(), manageDataSuccess()], '200'),
    metaV2(
      [updated(accountLedgerEntry(SOURCE, '9999999700'))],
      [operationMeta([created(dataLedgerEntry(SOURCE, 'config', 'v1'))]), operationMeta([])],
      [],
    ),
  ),
);

// 2. Failed classic transaction (transaction level failure, no operation results).
fixtures.push(
  baseFixture(
    'classic-failed',
    'Classic transaction rejected at validation time (txBadSeq) with no operation results',
    classicTx,
    transactionResult('txBadSeq', [], '100'),
    metaV2([updated(accountLedgerEntry(SOURCE, '9999999800'))], [], []),
  ),
);

// 3. Transaction with several operation results, one of which failed.
fixtures.push(
  baseFixture(
    'multi-operation-results',
    'Failed transaction whose operation results mix successes with a failed payment',
    classicTx,
    transactionResult(
      'txFailed',
      [paymentSuccess(), paymentUnderfunded()],
      '300',
    ),
    metaV2(
      [],
      [operationMeta([updated(accountLedgerEntry(SOURCE, '9999999600'))]), operationMeta([])],
      [],
    ),
  ),
);

// 4. Successful Soroban transaction with a return value, contract event and diagnostics.
fixtures.push(
  baseFixture(
    'soroban-success',
    'Successful Soroban invocation with return value, contract event and diagnostic events',
    sorobanTx,
    transactionResult('txSuccess', [invokeHostFunctionSuccess(Buffer.alloc(32, 8))], '1500'),
    metaV3(
      [updated(accountLedgerEntry(SOURCE, '9999998200'))],
      [operationMeta([created(contractDataLedgerEntry('counter', 43))])],
      [],
      sorobanMetaV1(
        nativeToScVal(42, { type: 'i64' }),
        [
          contractEvent(
            xdr.ContractEventType.contract(),
            [nativeToScVal('increment', { type: 'symbol' })],
            nativeToScVal(43, { type: 'i64' }),
          ),
        ],
        [fnCallEvent('increment', true)],
      ),
    ),
  ),
);

// 5. Failed Soroban contract invocation with diagnostic error details.
fixtures.push(
  baseFixture(
    'soroban-contract-failure',
    'Failed Soroban contract invocation (trapped) with a contract error diagnostic event',
    sorobanTx,
    transactionResult('txFailed', [invokeHostFunctionTrapped()], '1400'),
    metaV3(
      [updated(accountLedgerEntry(SOURCE, '9999998300'))],
      [operationMeta([])],
      [],
      sorobanMetaV1(xdr.ScVal.scvVoid(), [], [
        fnCallEvent('increment', false),
        sorobanErrorEvent(5, false),
      ]),
    ),
  ),
);

// 6. Soroban transaction returning a map containing an i128 (JSON-safety check).
fixtures.push(
  baseFixture(
    'soroban-return-map',
    'Successful Soroban invocation returning a map with an i128 value',
    sorobanTx,
    transactionResult('txSuccess', [invokeHostFunctionSuccess(Buffer.alloc(32, 4))], '900'),
    metaV3(
      [],
      [operationMeta([created(contractDataLedgerEntry('counter', 1))])],
      [],
      sorobanMetaV1(
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: nativeToScVal('total', { type: 'symbol' }),
            val: nativeToScVal(12345678901234567890n, { type: 'i128' }),
          }),
        ]),
        [],
        [],
      ),
    ),
  ),
);

// 7. Transaction whose metadata contains no ledger changes but does have diagnostics.
fixtures.push(
  baseFixture(
    'metadata-empty-changes',
    'Soroban transaction with diagnostics but no ledger entry changes in metadata',
    sorobanTx,
    transactionResult('txSuccess', [invokeHostFunctionSuccess(Buffer.alloc(32, 5))], '800'),
    metaV3([], [operationMeta([])], [], sorobanMetaV1(xdr.ScVal.scvVoid(), [], [
      diagnosticEvent(
        true,
        contractEvent(
          xdr.ContractEventType.diagnostic(),
          [nativeToScVal('core_metrics', { type: 'symbol' })],
          nativeToScVal('read', { type: 'symbol' }),
        ),
      ),
    ])),
  ),
);

// 8. Metadata version 1.
fixtures.push(
  baseFixture(
    'metadata-v1',
    'Classic transaction with a version 1 TransactionMeta',
    classicTx,
    transactionResult('txSuccess', [paymentSuccess(), manageDataSuccess()], '200'),
    metaV1(
      [created(dataLedgerEntry(SOURCE, 'config', 'v1'))],
      [
        operationMeta([updated(accountLedgerEntry(SOURCE, '9999999700'))]),
        operationMeta([removed(xdr.LedgerKey.data(new xdr.LedgerKeyData({
          accountId: accountId(SOURCE),
          dataName: 'legacy',
        })))]),
      ],
    ),
  ),
);

// 9. Metadata version 0 (classic pre-v1 metadata layout).
fixtures.push(
  baseFixture(
    'metadata-v0',
    'Classic transaction with the original version 0 TransactionMeta layout',
    classicTx,
    transactionResult('txSuccess', [paymentSuccess()], '100'),
    metaV0([operationMeta([updated(accountLedgerEntry(SOURCE, '9999999800'))])]),
  ),
);

// 10. Metadata version 4 with new-style operation meta, transaction events and diagnostics.
fixtures.push(
  baseFixture(
    'metadata-v4',
    'Soroban transaction with version 4 metadata: operation meta v2, transaction events, diagnostics',
    sorobanTx,
    transactionResult('txSuccess', [invokeHostFunctionSuccess(Buffer.alloc(32, 6))], '2000'),
    metaV4(
      [updated(accountLedgerEntry(SOURCE, '9999997900'))],
      [
        operationMetaV2(
          [
            created(contractDataLedgerEntry('counter', 7)),
            created(contractCodeLedgerEntry(Buffer.alloc(32, 2))),
          ],
          [
            contractEvent(
              xdr.ContractEventType.contract(),
              [nativeToScVal('increment', { type: 'symbol' })],
              nativeToScVal(7, { type: 'i64' }),
            ),
          ],
        ),
      ],
      [],
      sorobanMetaV2(nativeToScVal(7, { type: 'i64' })),
      [
        new xdr.TransactionEvent({
          stage: xdr.TransactionEventStage.transactionEventStageAfterAllTxes(),
          event: contractEvent(
            xdr.ContractEventType.system(),
            [nativeToScVal('fee', { type: 'symbol' })],
            nativeToScVal(2000, { type: 'i64' }),
          ),
        }),
      ],
      [fnCallEvent('increment', true)],
    ),
  ),
);

// 11. Result without optional metadata.
fixtures.push(
  baseFixture(
    'missing-metadata',
    'Transaction whose result is available but whose metadata was not exposed',
    classicTx,
    transactionResult('txSuccess', [paymentSuccess(), manageDataSuccess()], '200'),
    null,
  ),
);

// 12. Result XDR that cannot be decoded.
fixtures.push({
  name: 'malformed-result',
  description: 'Result value that is not valid base64-encoded TransactionResult XDR',
  networkPassphrase: NETWORK_PASSPHRASE,
  transactionHash: classicTx.hash().toString('hex'),
  ledger: 4321,
  envelopeXdr: classicTx.toEnvelope().toXDR('base64'),
  resultXdr: 'AAAA-not-valid-xdr-AAAA',
  resultMetaXdr: null,
});

// 13. Metadata with a switch value the installed SDK does not understand.
const v2MetaXdr = metaV2([], [], []).toXDR();
const unsupportedMetaXdr = Buffer.from(v2MetaXdr);
unsupportedMetaXdr.writeUInt32BE(5, 0);

fixtures.push({
  name: 'unsupported-metadata-version',
  description: 'TransactionMeta whose version tag (5) is newer than the installed SDK supports',
  networkPassphrase: NETWORK_PASSPHRASE,
  transactionHash: classicTx.hash().toString('hex'),
  ledger: 4321,
  envelopeXdr: classicTx.toEnvelope().toXDR('base64'),
  resultXdr: transactionResult('txSuccess', [paymentSuccess()], '100').toXDR('base64'),
  resultMetaXdr: unsupportedMetaXdr.toString('base64'),
});

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------

for (const fixture of fixtures) {
  const file = path.join(OUTPUT_DIR, `${fixture.name}.json`);

  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
}

console.log(`Wrote ${fixtures.length} fixtures to ${OUTPUT_DIR}`);
