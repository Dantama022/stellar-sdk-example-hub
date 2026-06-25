import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Contract,
  xdr,
  rpc,
  Account,
  Asset,
} from '@stellar/stellar-sdk';

/**
 * Runs the Soroban error parsing example.
 * Demonstrates triggering contract simulation errors, capturing transaction submission
 * errors, and decoding complex XDR-encoded RPC error responses into human-readable messages.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';

  console.log('Starting Soroban Error Parsing Example...');
  console.log(`Connecting to Horizon: ${horizonUrl}`);
  console.log(`Connecting to Soroban RPC: ${rpcUrl}`);

  const server = new Horizon.Server(horizonUrl);
  const rpcServer = new rpc.Server(rpcUrl);

  const keypair = Keypair.random();
  console.log(`\nGenerated random keypair for error triggers: ${keypair.publicKey()}`);

  // We will demonstrate two main types of errors:
  // 1. Soroban Contract Simulation Error (calling a nonexistent contract/method)
  // 2. Transaction Submission Error (such as bad sequence or signature failures)

  // ==========================================
  // Case 1: Contract Simulation Error
  // ==========================================
  console.log('\n--- Case 1: Triggering a Soroban Simulation Error ---');
  // We use a dummy contract address CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
  const dummyContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
  const contract = new Contract(dummyContractId);

  // Attempt to call a nonexistent method 'hello' on the nonexistent contract
  const callOp = contract.call('hello', xdr.ScVal.scvSymbol('Stellar'));

  // Create a mock source account with sequence number 1
  const sourceAccount = new Account(keypair.publicKey(), '1');
  const simTx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(callOp)
    .setTimeout(30)
    .build();

  try {
    console.log('Simulating transaction on-chain...');
    const simResult = await rpcServer.simulateTransaction(simTx);

    if (rpc.Api.isSimulationError(simResult)) {
      console.log('Simulation Error Captured!');
      console.log('Raw Error String:', simResult.error);

      // Parse common error formats or codes in the error string
      formatSimulationError(simResult.error);
    } else {
      console.log('Simulation surprisingly succeeded or returned non-error.');
    }
  } catch (err: any) {
    console.log('Simulation request failed:', err.message);
  }

  // ==========================================
  // Case 2: Transaction Submission Error
  // ==========================================
  console.log('\n--- Case 2: Triggering and Parsing a Transaction Submission Error ---');

  // We build a transaction with an invalid sequence number (e.g. sequence '0' or '999999999999')
  // on a freshly generated account that has not been funded. This will fail with bad sequence/auth.
  const invalidAccount = new Account(keypair.publicKey(), '999999999999');
  const badTx = new TransactionBuilder(invalidAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build();

  // Sign with the keypair
  badTx.sign(keypair);

  try {
    console.log('Submitting invalid transaction to Horizon...');
    await server.submitTransaction(badTx);
    console.log('Unexpected success: Transaction was accepted!');
  } catch (error: any) {
    console.log('Transaction Submission Error Captured!');

    // Horizon errors usually contain response.data.extras
    const extras = error.response?.data?.extras;
    const resultCodes = extras?.result_codes;

    if (resultCodes) {
      console.log('\nParsed Horizon Error Summary:');
      console.log(`  - Transaction Result Code: ${resultCodes.transaction}`);
      if (resultCodes.operations) {
        console.log(`  - Operations Result Codes: ${resultCodes.operations.join(', ')}`);
      }
    }

    const resultXdr = error.response?.data?.extras?.result_xdr;

    if (resultXdr) {
      console.log('\nDecoding result_xdr (base64) using SDK utilities...');
      try {
        const decodedResult = xdr.TransactionResult.fromXDR(resultXdr, 'base64');
        const codeValue = decodedResult.result().switch().value;
        const codeName = decodedResult.result().switch().name;

        console.log(`  - Result Code Name:  ${codeName}`);
        console.log(`  - Result Code Value: ${codeValue}`);
        console.log(`  - Fee Charged:       ${decodedResult.feeCharged().toString()} stroops`);

        // Check if there are specific operation results to traverse
        if (decodedResult.result().switch().value === xdr.TransactionResultCode.txFailed().value) {
          const results = decodedResult.result().results() || [];
          console.log(`  - Encountered txFailed. Operation results count: ${results.length}`);
          results.forEach((opResult, idx) => {
            console.log(`    - Op [${idx}] Result Name: ${opResult.switch().name}`);
          });
        }
      } catch (xdrErr: any) {
        console.log('Failed to decode result_xdr:', xdrErr.message);
      }
    } else {
      console.log(
        '\nNo result_xdr found in the error response. Fallback to parsing message:',
        error.message,
      );
    }
  }
}

/**
 * Parses and formats raw simulation errors into human-readable statements.
 *
 * @param errorStr The raw simulation error string from the RPC response.
 */
function formatSimulationError(errorStr: string): void {
  console.log('\nFormatted Diagnostics:');

  if (errorStr.includes('HostValidationError')) {
    console.log('  Category: Host Validation Error');
    console.log(
      '  Reason:   The Soroban host rejected the contract validation. The contract ID may be invalid or not exist.',
    );
  } else if (errorStr.includes('ContractNotFound') || errorStr.includes('does not exist')) {
    console.log('  Category: Contract Not Found');
    console.log('  Reason:   The target Contract ID has not been deployed or has expired.');
  } else if (errorStr.includes('nonexistent_method') || errorStr.includes('SymbolNotFound')) {
    console.log('  Category: Method Not Found');
    console.log('  Reason:   The method invoked is not defined in the contract ABI.');
  } else {
    console.log('  Category: General Contract/RPC Failure');
    console.log(`  Details:  ${errorStr}`);
  }
}
