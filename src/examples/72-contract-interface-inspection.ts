import { contract, xdr, rpc } from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Resolves a human-readable type name from an XDR ScSpecTypeDef.
 *
 * Soroban contract specs encode argument and return types as XDR ScSpecTypeDef
 * union values. This helper converts each variant to a readable string so the
 * example output is self-explanatory for developers building tooling on top of
 * contract metadata.
 */
function resolveTypeName(typeDef: xdr.ScSpecTypeDef): string {
  const t = typeDef.switch();

  switch (t.name) {
    case 'scSpecTypeVoid':
      return 'void';
    case 'scSpecTypeBool':
      return 'bool';
    case 'scSpecTypeU32':
      return 'u32';
    case 'scSpecTypeI32':
      return 'i32';
    case 'scSpecTypeU64':
      return 'u64';
    case 'scSpecTypeI64':
      return 'i64';
    case 'scSpecTypeU128':
      return 'u128';
    case 'scSpecTypeI128':
      return 'i128';
    case 'scSpecTypeU256':
      return 'u256';
    case 'scSpecTypeI256':
      return 'i256';
    case 'scSpecTypeBytes':
      return 'bytes';
    case 'scSpecTypeString':
      return 'string';
    case 'scSpecTypeSymbol':
      return 'symbol';
    case 'scSpecTypeAddress':
      return 'address';
    case 'scSpecTypeMuxedAddress':
      return 'muxed_address';
    case 'scSpecTypeTimepoint':
      return 'timepoint';
    case 'scSpecTypeDuration':
      return 'duration';
    case 'scSpecTypeVal':
      return 'val';
    case 'scSpecTypeError':
      return 'error';
    case 'scSpecTypeOption':
      return `Option<${resolveTypeName(typeDef.option().valueType())}>`;
    case 'scSpecTypeResult':
      return `Result<${resolveTypeName(typeDef.result().okType())}, ${resolveTypeName(typeDef.result().errorType())}>`;
    case 'scSpecTypeVec':
      return `Vec<${resolveTypeName(typeDef.vec().elementType())}>`;
    case 'scSpecTypeMap':
      return `Map<${resolveTypeName(typeDef.map().keyType())}, ${resolveTypeName(typeDef.map().valueType())}>`;
    case 'scSpecTypeTuple': {
      const types = typeDef.tuple().valueTypes().map(resolveTypeName);
      return `Tuple<${types.join(', ')}>`;
    }
    case 'scSpecTypeBytesN':
      return `BytesN<${typeDef.bytesN().n()}>`;
    case 'scSpecTypeUdt':
      return typeDef.udt().name().toString();
    default:
      return t.name ?? 'unknown';
  }
}

/**
 * Displays contract functions parsed from the ScSpec metadata.
 *
 * Each xdr.ScSpecFunctionV0 carries the function name, documentation,
 * ordered inputs (name + type), and a list of output types.  We iterate those
 * and print a concise signature that mirrors what a developer would write in a
 * language binding.
 */
function displayFunctions(funcs: xdr.ScSpecFunctionV0[]): void {
  if (funcs.length === 0) {
    console.log(chalk.gray('  (no exported functions found)'));
    return;
  }

  funcs.forEach((fn) => {
    const name = fn.name().toString();
    const doc = fn.doc().toString().trim();
    const inputs = fn.inputs();
    const outputs = fn.outputs();

    const params = inputs
      .map((inp) => `${inp.name().toString()}: ${chalk.cyan(resolveTypeName(inp.type()))}`)
      .join(', ');

    const returnType =
      outputs.length === 0
        ? chalk.cyan('void')
        : outputs.map((o) => chalk.cyan(resolveTypeName(o))).join(', ');

    console.log(`  ${chalk.yellow(name)}(${params}) → ${returnType}`);
    if (doc) {
      console.log(`    ${chalk.gray(doc)}`);
    }
  });
}

/**
 * Displays user-defined structs (UDT structs) from the contract spec.
 *
 * Structs encode custom data structures that contract functions accept or
 * return.  Each field has a name and a type.  Knowing their shape lets SDK
 * consumers construct the correct ScVal representations.
 */
function displayStructs(entries: xdr.ScSpecEntry[]): void {
  const structs = entries.filter(
    (e) => e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtStructV0().value,
  );

  if (structs.length === 0) return;

  console.log(chalk.bold('\n  Structs:'));
  structs.forEach((e) => {
    const udt = e.udtStructV0();
    const doc = udt.doc().toString().trim();
    console.log(`  ${chalk.yellow(udt.name().toString())} {`);
    if (doc) console.log(`    ${chalk.gray('// ' + doc)}`);
    udt.fields().forEach((f) => {
      console.log(`    ${f.name().toString()}: ${chalk.cyan(resolveTypeName(f.type()))}`);
    });
    console.log('  }');
  });
}

/**
 * Displays user-defined enums (UDT enums) from the contract spec.
 *
 * Enums map symbolic names to u32 discriminant values.  They are used as
 * strongly typed integer flags or state values inside contracts.
 */
function displayEnums(entries: xdr.ScSpecEntry[]): void {
  const enums = entries.filter(
    (e) => e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtEnumV0().value,
  );

  if (enums.length === 0) return;

  console.log(chalk.bold('\n  Enums:'));
  enums.forEach((e) => {
    const udt = e.udtEnumV0();
    const doc = udt.doc().toString().trim();
    console.log(`  ${chalk.yellow(udt.name().toString())} {`);
    if (doc) console.log(`    ${chalk.gray('// ' + doc)}`);
    udt.cases().forEach((c) => {
      console.log(`    ${c.name().toString()} = ${c.value()}`);
    });
    console.log('  }');
  });
}

/**
 * Displays user-defined unions (UDT unions / Rust-style enums) from the spec.
 *
 * Tagged unions represent Rust enums that carry optional data.  Each case is
 * either void (no payload) or a tuple of additional types.  These are common
 * return or argument types in production Soroban contracts.
 */
function displayUnions(entries: xdr.ScSpecEntry[]): void {
  const unions = entries.filter(
    (e) => e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtUnionV0().value,
  );

  if (unions.length === 0) return;

  console.log(chalk.bold('\n  Unions (tagged enums):'));
  unions.forEach((e) => {
    const udt = e.udtUnionV0();
    const doc = udt.doc().toString().trim();
    console.log(`  ${chalk.yellow(udt.name().toString())} {`);
    if (doc) console.log(`    ${chalk.gray('// ' + doc)}`);
    udt.cases().forEach((c) => {
      switch (c.switch().value) {
        case xdr.ScSpecUdtUnionCaseV0Kind.scSpecUdtUnionCaseVoidV0().value: {
          const vc = c.voidCase();
          console.log(`    ${vc.name().toString()}`);
          break;
        }
        case xdr.ScSpecUdtUnionCaseV0Kind.scSpecUdtUnionCaseTupleV0().value: {
          const tc = c.tupleCase();
          const types = tc.type().map(resolveTypeName).join(', ');
          console.log(`    ${tc.name().toString()}(${chalk.cyan(types)})`);
          break;
        }
      }
    });
    console.log('  }');
  });
}

/**
 * Displays error enums defined in the contract spec.
 *
 * Error enums encode the numeric codes that a contract can emit as
 * contract-specific error values.  Tooling and clients use these codes to
 * translate raw error numbers into descriptive messages.
 */
function displayErrorEnums(entries: xdr.ScSpecEntry[]): void {
  const errorEnums = entries.filter(
    (e) => e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtErrorEnumV0().value,
  );

  if (errorEnums.length === 0) return;

  console.log(chalk.bold('\n  Error Enums:'));
  errorEnums.forEach((e) => {
    const udt = e.udtErrorEnumV0();
    const doc = udt.doc().toString().trim();
    console.log(`  ${chalk.yellow(udt.name().toString())} {`);
    if (doc) console.log(`    ${chalk.gray('// ' + doc)}`);
    udt.cases().forEach((c) => {
      const caseDoc = c.doc().toString().trim();
      const suffix = caseDoc ? chalk.gray(` // ${caseDoc}`) : '';
      console.log(`    ${c.name().toString()} = ${c.value()}${suffix}`);
    });
    console.log('  }');
  });
}

/**
 * Retrieves the WASM bytecode for a deployed contract using two getLedgerEntries calls.
 *
 * Step 1 — Fetch the ContractData entry for the contract instance, which
 *           contains a reference (hash) to the installed WASM code.
 * Step 2 — Fetch the ContractCode entry using that hash to get the raw WASM.
 *
 * The Stellar RPC server exposes getContractWasmByContractId() which wraps
 * exactly these two calls.  Using it is the recommended approach; the manual
 * two-step version is illustrated in the inline comments for learning purposes.
 */
async function fetchContractWasm(server: rpc.Server, contractId: string): Promise<Buffer> {
  // getContractWasmByContractId performs the two-step fetch:
  //   1. getLedgerEntries(ContractData key)  → reads wasmHash from the instance
  //   2. getLedgerEntries(ContractCode key)  → reads the raw WASM bytes
  const wasm = await server.getContractWasmByContractId(contractId);
  return wasm;
}

/**
 * Runs the Soroban Contract Interface Inspection example.
 *
 * Demonstrates how to:
 *  - Connect to a Soroban RPC endpoint
 *  - Retrieve a contract's WASM bytes via the two-step ledger entry lookup
 *  - Parse the embedded ScSpec metadata using contract.Spec.fromWasm()
 *  - Display all exported functions with their parameter and return types
 *  - Display user-defined types: structs, enums, unions, and error enums
 *
 * ScSpec metadata is compiled into every Soroban WASM as a custom Wasm section
 * named "contractspecv0".  The JS SDK's contract.Spec class reads that section
 * and exposes the type information as iterable xdr.ScSpecEntry objects, which
 * power Stellar CLI's on-the-fly help text, the JS SDK's contract.Client, and
 * any other tooling that needs to understand a contract's interface at runtime.
 */
export async function run(params?: { contractId?: string }): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  console.log(chalk.blue(`Connecting to Soroban RPC at: ${rpcUrl}`));
  const server = new rpc.Server(rpcUrl);

  // -----------------------------------------------------------------------
  // Step 1: Determine the contract to inspect.
  //
  // We default to the native XLM (SAC) contract on Testnet.  This is a
  // well-known contract that is always deployed and always has a rich spec
  // containing functions (balance, transfer, mint, …), structs, and error
  // enums, making it an ideal subject for learning.
  //
  // Override by passing `contractId` via the runner params or by setting the
  // CONTRACT_ID environment variable.
  // -----------------------------------------------------------------------
  const contractId =
    (params?.contractId ?? '').trim() ||
    process.env.CONTRACT_ID ||
    'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'; // native SAC on Testnet

  console.log(chalk.yellow(`\nInspecting contract: ${contractId}`));

  // Validate that the provided value looks like a Stellar contract address.
  if (!contractId.startsWith('C') || contractId.length !== 56) {
    console.error(
      chalk.red('Error: contract ID must be a 56-character Stellar address starting with "C".'),
    );
    return;
  }

  // -----------------------------------------------------------------------
  // Step 2: Retrieve the contract WASM from the ledger.
  //
  // Contract specs are stored on-chain inside the compiled WASM binary.  To
  // read them we first need the raw bytes.  The RPC helper wraps the two-step
  // ledger entry lookup (instance → code) in a single call.
  // -----------------------------------------------------------------------
  console.log(chalk.yellow('\nStep 1: Fetching contract WASM from the ledger...'));
  let wasm: Buffer;
  try {
    wasm = await fetchContractWasm(server, contractId);
    console.log(
      chalk.green(`WASM fetched successfully. Size: ${wasm.length.toLocaleString()} bytes.`),
    );
  } catch (err: any) {
    // Handle the most common failure modes gracefully so that the example
    // remains useful as a learning resource even when the network is
    // unavailable or the contract ID is wrong.
    if (err?.message?.includes('not found') || err?.message?.includes('404')) {
      console.warn(
        chalk.red(
          `Contract "${contractId}" was not found on this network.\n` +
            'The contract may not be deployed, or the contract ID may be incorrect.',
        ),
      );
    } else if (err?.message?.includes('fetch')) {
      console.warn(
        chalk.red(`Network error while connecting to ${rpcUrl}.\n`) +
          chalk.gray('Check that SOROBAN_RPC_URL is set correctly and the RPC node is reachable.'),
      );
    } else {
      console.warn(chalk.red(`Failed to fetch contract WASM: ${err?.message ?? String(err)}`));
    }
    console.log(
      chalk.cyan(
        '\nSummary: Demonstrated graceful handling of contract specification retrieval failure.\n' +
          'To run with a specific contract, set CONTRACT_ID or pass contractId as a parameter.',
      ),
    );
    return;
  }

  // -----------------------------------------------------------------------
  // Step 3: Parse the contract specification (ScSpec) from the WASM.
  //
  // Every Soroban contract compiled with soroban-sdk embeds a "contractspecv0"
  // custom Wasm section.  contract.Spec.fromWasm() locates that section and
  // decodes each XDR ScSpecEntry it contains.  The resulting Spec object
  // exposes:
  //   - spec.entries   — all raw xdr.ScSpecEntry instances
  //   - spec.funcs()   — filtered list of function entries
  //   - spec.getFunc() — look up a single function by name
  //   - spec.errorCases() — all error enum cases across the spec
  //   - spec.jsonSchema() — JSON Schema representation for tooling
  // -----------------------------------------------------------------------
  console.log(chalk.yellow('\nStep 2: Parsing contract specification (ScSpec)...'));
  let spec: contract.Spec;
  try {
    spec = contract.Spec.fromWasm(wasm);
    console.log(chalk.green(`Spec parsed. Total entries: ${spec.entries.length}`));
  } catch (err: any) {
    console.warn(
      chalk.red(
        `Unable to parse contract spec: ${err?.message ?? String(err)}\n` +
          'This contract may not have been compiled with soroban-sdk, ' +
          'or its spec section may be missing or malformed.',
      ),
    );
    return;
  }

  if (spec.entries.length === 0) {
    console.warn(chalk.yellow('The contract spec is empty — no interface metadata is available.'));
    return;
  }

  // -----------------------------------------------------------------------
  // Step 4: Display exported functions.
  //
  // Function entries carry: name, documentation string, ordered inputs
  // (each with a name and ScSpecTypeDef), and a list of output types.
  //
  // This is exactly the information used by contract.Client to auto-generate
  // typed TypeScript methods and by Stellar CLI to produce per-contract help
  // text via `stellar contract invoke -- --help`.
  // -----------------------------------------------------------------------
  const funcs = spec.funcs();
  console.log(chalk.bold(`\n━━━ Exported Functions (${funcs.length}) ━━━`));
  displayFunctions(funcs);

  // -----------------------------------------------------------------------
  // Step 5: Display user-defined types.
  //
  // Contracts can define custom types: structs, Rust-style tagged unions, and
  // plain integer enums.  Each is stored as a separate ScSpecEntry and decoded
  // by the SDK into its corresponding XDR representation.
  //
  // Displaying these types is critical for tool authors because contract
  // functions that accept or return UDTs cannot be called correctly without
  // knowing the field names and types of those structs or the variant names of
  // those enums.
  // -----------------------------------------------------------------------
  const hasCustomTypes = spec.entries.some(
    (e) =>
      e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtStructV0().value ||
      e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtEnumV0().value ||
      e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtUnionV0().value ||
      e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtErrorEnumV0().value,
  );

  if (hasCustomTypes) {
    console.log(chalk.bold('\n━━━ User-Defined Types ━━━'));
    displayStructs(spec.entries);
    displayEnums(spec.entries);
    displayUnions(spec.entries);
    displayErrorEnums(spec.entries);
  } else {
    console.log(chalk.gray('\nNo user-defined types found in this contract.'));
  }

  // -----------------------------------------------------------------------
  // Step 6: Print a JSON Schema preview for one function (if any exist).
  //
  // spec.jsonSchema(funcName) returns a draft-07 JSON Schema object that
  // describes the input arguments of the named function.  This is used by the
  // Stellar Lab's Contract Explorer to render a form-based UI for any contract
  // without needing manually written schemas.
  // -----------------------------------------------------------------------
  if (funcs.length > 0) {
    // Find the first non-constructor function to preview.
    const previewFunc = funcs.find((f) => !f.name().toString().startsWith('__')) ?? funcs[0];
    const funcName = previewFunc.name().toString();

    console.log(chalk.bold(`\n━━━ JSON Schema Preview: ${funcName} ━━━`));
    console.log(chalk.gray('(contract.Spec.jsonSchema() generates draft-07 schemas for tooling)'));
    try {
      const schema = spec.jsonSchema(funcName);
      // Pretty-print a truncated excerpt so the output stays readable.
      const schemaJson = JSON.stringify(schema, null, 2);
      const lines = schemaJson.split('\n');
      const preview = lines.slice(0, 30).join('\n');
      console.log(chalk.gray(preview));
      if (lines.length > 30) {
        console.log(chalk.gray(`  … (${lines.length - 30} more lines)`));
      }
    } catch (err: any) {
      console.log(chalk.gray(`  (JSON schema generation skipped: ${err?.message})`));
    }
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  const structCount = spec.entries.filter(
    (e) => e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtStructV0().value,
  ).length;
  const enumCount = spec.entries.filter(
    (e) => e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtEnumV0().value,
  ).length;
  const unionCount = spec.entries.filter(
    (e) => e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtUnionV0().value,
  ).length;
  const errorEnumCount = spec.entries.filter(
    (e) => e.switch().value === xdr.ScSpecEntryKind.scSpecEntryUdtErrorEnumV0().value,
  ).length;

  console.log(chalk.bold.green('\n━━━ Inspection Complete ━━━'));
  console.log(`Contract: ${chalk.cyan(contractId)}`);
  console.log(`Functions:    ${chalk.yellow(String(funcs.length))}`);
  console.log(`Structs:      ${chalk.yellow(String(structCount))}`);
  console.log(`Enums:        ${chalk.yellow(String(enumCount))}`);
  console.log(`Unions:       ${chalk.yellow(String(unionCount))}`);
  console.log(`Error enums:  ${chalk.yellow(String(errorEnumCount))}`);
  console.log(
    chalk.cyan(
      '\nHow the SDK decodes ScSpec metadata:\n' +
        '  1. The WASM binary is fetched from the ledger via two getLedgerEntries\n' +
        '     calls: first to get the contract instance (which contains the wasmHash),\n' +
        '     then to get the ContractCode entry that holds the raw WASM bytes.\n' +
        '  2. contract.Spec.fromWasm(wasm) locates the "contractspecv0" custom\n' +
        '     Wasm section and reads the XDR-encoded ScSpecEntry stream stored there.\n' +
        '  3. Each entry is decoded into a typed xdr.ScSpecEntry union, classified\n' +
        '     by its kind: FunctionV0, UdtStructV0, UdtEnumV0, UdtUnionV0, etc.\n' +
        '  4. Tooling (CLI, contract.Client, Stellar Lab) uses this metadata to\n' +
        '     generate type-safe bindings, interactive UIs, and on-the-fly help text.',
    ),
  );
}
