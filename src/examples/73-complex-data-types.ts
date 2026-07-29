import {
  Keypair,
  rpc,
  Contract,
  xdr,
  nativeToScVal,
  scValToNative,
  Networks,
  TransactionBuilder,
  Account,
  Address,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Primitive and simple scalar ScVal construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Demonstrates how every Soroban primitive type maps to an xdr.ScVal variant.
 *
 * The Soroban VM passes all arguments and return values as ScVal (Smart Contract
 * Value), a tagged XDR union.  Developers need to match the expected ScVal
 * variant precisely — passing scvString where scvSymbol is required will cause
 * a host validation error at simulation time.
 *
 * nativeToScVal(value, { type }) is the high-level SDK helper that infers the
 * correct variant from a hint string.  For the most common types you can also
 * construct ScVal instances directly with xdr.ScVal.*() factory methods.
 */
function demonstratePrimitives(): void {
  console.log(chalk.bold('\n━━━ Primitive Types ━━━'));
  console.log(chalk.gray('Each JS value is converted to the matching xdr.ScVal variant.\n'));

  // Boolean — scvBool
  const boolVal = nativeToScVal(true, { type: 'bool' });
  console.log(`  bool    true  → ${chalk.cyan(boolVal.switch().name)}  decoded: ${scValToNative(boolVal)}`);

  // Unsigned 32-bit integer — scvU32
  const u32Val = nativeToScVal(42, { type: 'u32' });
  console.log(`  u32     42    → ${chalk.cyan(u32Val.switch().name)}  decoded: ${scValToNative(u32Val)}`);

  // Signed 32-bit integer — scvI32
  const i32Val = nativeToScVal(-7, { type: 'i32' });
  console.log(`  i32     -7    → ${chalk.cyan(i32Val.switch().name)}  decoded: ${scValToNative(i32Val)}`);

  // Unsigned 64-bit integer — scvU64 (JS BigInt required for >2^53)
  const u64Val = nativeToScVal(BigInt('18446744073709551615'), { type: 'u64' });
  console.log(`  u64     18446744073709551615 → ${chalk.cyan(u64Val.switch().name)}`);

  // Signed 128-bit integer — scvI128 (common for token amounts in Soroban)
  const i128Val = nativeToScVal(BigInt('170141183460469231731687303715884105727'), { type: 'i128' });
  console.log(`  i128    (max i128) → ${chalk.cyan(i128Val.switch().name)}`);

  // String — scvString (UTF-8 bytes)
  const strVal = nativeToScVal('hello Soroban', { type: 'string' });
  console.log(`  string  "hello Soroban" → ${chalk.cyan(strVal.switch().name)}  decoded: "${scValToNative(strVal)}"`);

  // Symbol — scvSymbol (short identifiers, at most 32 bytes, used for enum tags)
  const symVal = nativeToScVal('transfer', { type: 'symbol' });
  console.log(`  symbol  "transfer" → ${chalk.cyan(symVal.switch().name)}  decoded: "${scValToNative(symVal)}"`);

  // Bytes — scvBytes (raw byte buffer)
  const bytesVal = nativeToScVal(Buffer.from('deadbeef', 'hex'), { type: 'bytes' });
  console.log(`  bytes   0xDEADBEEF → ${chalk.cyan(bytesVal.switch().name)}  decoded: ${(scValToNative(bytesVal) as Buffer).toString('hex')}`);

  // Void — scvVoid (represents absence of a value, e.g. no-return functions)
  const voidVal = xdr.ScVal.scvVoid();
  console.log(`  void    (no value) → ${chalk.cyan(voidVal.switch().name)}`);

  console.log(chalk.gray('\n  SDK tip: use nativeToScVal(value, { type }) for concise construction.'));
  console.log(chalk.gray('  For explicit control use xdr.ScVal.scvU32(n), .scvBool(b), etc.'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Vector (Vec) encoding and decoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vectors are ordered, homogeneous sequences wrapped in scvVec.
 *
 * nativeToScVal(array, { type: 'vec', element: { type } }) encodes every
 * element to the specified inner type.  scValToNative decodes a scvVec back
 * to a plain JS array.  Heterogeneous vecs (mixed element types) require
 * building each ScVal individually and calling xdr.ScVal.scvVec([...]).
 */
function demonstrateVec(): void {
  console.log(chalk.bold('\n━━━ Vec<u32> — Ordered Sequence ━━━'));

  // Encode a JS number array as Vec<u32>
  const numbers = [10, 20, 30, 40, 50];
  const vecVal = nativeToScVal(numbers, { type: 'vec', element: { type: 'u32' } });

  console.log(`  JS input:  [${numbers.join(', ')}]`);
  console.log(`  ScVal type: ${chalk.cyan(vecVal.switch().name)}`);
  console.log(`  Elements:  ${(vecVal.vec() ?? []).map((v) => v.switch().name).join(', ')}`);

  // Decode back to JS
  const decoded = scValToNative(vecVal) as number[];
  console.log(`  Decoded:   [${decoded.join(', ')}]`);

  // Vec<string> — each element becomes scvString
  const words = ['stellar', 'soroban', 'sdk'];
  const strVec = nativeToScVal(words, { type: 'vec', element: { type: 'string' } });
  const decodedWords = scValToNative(strVec) as string[];
  console.log(`\n  Vec<string> ["${words.join('", "')}"] decoded: ["${decodedWords.join('", "')}"]`);

  // Manual construction — heterogeneous vec mixing u32 and symbol
  const mixedVec = xdr.ScVal.scvVec([
    xdr.ScVal.scvU32(99),
    xdr.ScVal.scvSymbol('flag'),
    xdr.ScVal.scvBool(true),
  ]);
  console.log(
    chalk.gray(
      `\n  Mixed vec (manual):  scvVec([scvU32(99), scvSymbol("flag"), scvBool(true)])\n` +
        `  Note: contracts rarely accept truly mixed vecs; scvVec is more commonly\n` +
        `  used for tuple-like returns where each index has a known type.`,
    ),
  );

  console.log(chalk.gray('\n  SDK tip: nativeToScVal([...], { type: "vec", element }) handles uniform arrays.'));
  console.log(chalk.gray('  For mixed-type vecs construct each ScVal manually and wrap with scvVec([...]).'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Map encoding and decoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps are key-value collections stored as scvMap — an ordered array of
 * ScMapEntry pairs.  Keys and values each have their own ScVal type.
 *
 * The SDK represents a Soroban map as an array of [key, value] tuples in JS,
 * not as a plain object, because Soroban maps allow non-string keys and
 * maintain insertion order.
 */
function demonstrateMap(): void {
  console.log(chalk.bold('\n━━━ Map<symbol, u32> — Key-Value Collection ━━━'));

  // Encode a JS array of [key, value] pairs as Map<symbol, u32>
  const pairs: [string, number][] = [
    ['alice', 100],
    ['bob', 250],
    ['carol', 75],
  ];

  const mapVal = nativeToScVal(pairs, {
    type: 'map',
    key: { type: 'symbol' },
    value: { type: 'u32' },
  });

  console.log(`  JS input:  [${pairs.map(([k, v]) => `["${k}", ${v}]`).join(', ')}]`);
  console.log(`  ScVal type: ${chalk.cyan(mapVal.switch().name)}`);
  console.log(`  Entries:   ${(mapVal.map() ?? []).length} ScMapEntry items`);

  // Decode back to JS
  const decoded = scValToNative(mapVal) as [string, number][];
  decoded.forEach(([k, v]) => console.log(`    "${k}" → ${v}`));

  // Map<address, i128> — the pattern used by token contract allowances
  const addr1 = Keypair.random().publicKey();
  const addr2 = Keypair.random().publicKey();

  const allowancePairs: [string, bigint][] = [
    [addr1, BigInt('1000000000000')],
    [addr2, BigInt('500000000000')],
  ];

  const allowanceMap = nativeToScVal(allowancePairs, {
    type: 'map',
    key: { type: 'address' },
    value: { type: 'i128' },
  });

  console.log(`\n  Map<address, i128> — ${(allowanceMap.map() ?? []).length} entries encoded`);
  console.log(chalk.gray('  (Common pattern: token allowance or balance mappings)'));

  // Manual construction — build a ScMapEntry array directly
  const manualMap = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('version'),
      val: xdr.ScVal.scvU32(2),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('active'),
      val: xdr.ScVal.scvBool(true),
    }),
  ]);
  console.log(chalk.gray(`\n  Manual scvMap:  { version: 2, active: true } → scvMap([ScMapEntry, ScMapEntry])`));
  const manualDecoded = scValToNative(manualMap) as [string, unknown][];
  manualDecoded.forEach(([k, v]) => console.log(`    "${k}" → ${v}`));

  console.log(chalk.gray('\n  SDK tip: nativeToScVal([...pairs], { type: "map", key, value }) encodes uniformly-typed maps.'));
  console.log(chalk.gray('  Use xdr.ScVal.scvMap([new xdr.ScMapEntry(...)]) for mixed or dynamic map construction.'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Struct (UDT) encoding and decoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Soroban structs are user-defined types (UDTs) represented as scvMap on the
 * wire, with symbol keys matching each field name.
 *
 * The contract.Spec class is the cleanest way to encode structs: it reads the
 * field definitions from the contract's ScSpec metadata and calls
 * spec.nativeToScVal() on each field value automatically.
 *
 * When no Spec is available (e.g. during testing or when constructing manually),
 * you can build the scvMap yourself — one ScMapEntry per field in the same
 * order they appear in the Rust struct definition.
 *
 * This section demonstrates the manual approach so the mapping is explicit and
 * educational.
 */
function demonstrateStruct(): void {
  console.log(chalk.bold('\n━━━ Struct (UDT) — Composite Named Fields ━━━'));

  // Imagine a Soroban contract that defines:
  //
  //   #[contracttype]
  //   pub struct TokenMetadata {
  //       pub name:     Symbol,
  //       pub decimals: u32,
  //       pub total:    i128,
  //   }
  //
  // On the wire a struct is a scvMap with symbol keys in declaration order.

  const structVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('name'),
      val: xdr.ScVal.scvSymbol('MyToken'),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('decimals'),
      val: xdr.ScVal.scvU32(7),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('total'),
      val: nativeToScVal(BigInt('1000000000'), { type: 'i128' }),
    }),
  ]);

  console.log('  Rust struct:  TokenMetadata { name: Symbol, decimals: u32, total: i128 }');
  console.log(`  JS object:    { name: "MyToken", decimals: 7, total: 1_000_000_000n }`);
  console.log(`  ScVal type:   ${chalk.cyan(structVal.switch().name)}`);
  console.log(`  Fields:       ${(structVal.map() ?? []).length} ScMapEntry items`);

  // Decode — scValToNative converts scvMap with symbol keys to a [string, value][] array.
  // For structs you typically want a plain object; we reshape the array here.
  const rawDecoded = scValToNative(structVal) as [string, unknown][];
  const asObject: Record<string, unknown> = Object.fromEntries(rawDecoded);
  console.log('  Decoded:     ', asObject);

  // When using contract.Spec, encoding is as simple as:
  //   spec.nativeToScVal({ name: 'MyToken', decimals: 7, total: 1_000_000_000n }, typeDefForTokenMetadata)
  // The Spec resolves field types automatically from the XDR spec entry.
  console.log(chalk.gray('\n  SDK tip: with contract.Spec available, use spec.nativeToScVal(obj, typeDef)'));
  console.log(chalk.gray('  for automatic field-type resolution. Without a Spec, build the scvMap manually'));
  console.log(chalk.gray('  ensuring field order matches the Rust struct declaration.'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — Enum and tagged union encoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Soroban supports two flavours of "enum":
 *
 * 1. Integer enum — a u32 discriminant.  Rust:  `pub enum Status { Active = 0, Paused = 1 }`
 *    On the wire: scvU32(discriminant_value)
 *
 * 2. Tagged union (Rust enum with data) — a scvVec whose first element is a
 *    scvSymbol tag and subsequent elements are the payload values.
 *    Rust:  `pub enum Event { Transfer(Address, u128), Mint }`
 *    On the wire: scvVec([scvSymbol("Transfer"), scvAddress(...), scvI128(...)])
 *                 scvVec([scvSymbol("Mint")])
 *
 * The contract.Spec class handles both via spec.nativeToScVal({ tag, values }, typeDef).
 * Below we construct both manually so the wire format is transparent.
 */
function demonstrateEnum(): void {
  console.log(chalk.bold('\n━━━ Integer Enum — u32 Discriminant ━━━'));

  // Rust:  pub enum Status { Active = 0, Paused = 1, Deprecated = 2 }
  // JS integer enum values are simple scvU32 wrappers.
  const activeVal = xdr.ScVal.scvU32(0);   // Status::Active
  const pausedVal = xdr.ScVal.scvU32(1);   // Status::Paused

  console.log(`  Status::Active     (0) → ${chalk.cyan(activeVal.switch().name)}(${scValToNative(activeVal)})`);
  console.log(`  Status::Paused     (1) → ${chalk.cyan(pausedVal.switch().name)}(${scValToNative(pausedVal)})`);

  console.log(chalk.bold('\n━━━ Tagged Union — Rust Enum with Payload ━━━'));

  // Rust:  pub enum Event {
  //            Transfer { from: Address, amount: i128 },
  //            Mint,
  // }

  const fromAddr = Address.fromString(Keypair.random().publicKey());

  // Event::Transfer — scvVec([tag, ...payload])
  const transferEvent = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Transfer'),
    fromAddr.toScVal(),
    nativeToScVal(BigInt('5000000000'), { type: 'i128' }),
  ]);

  // Event::Mint (void case) — scvVec([tag])
  const mintEvent = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Mint'),
  ]);

  console.log(`  Event::Transfer  → ${chalk.cyan(transferEvent.switch().name)}`);
  console.log(`    elements: ${(transferEvent.vec() ?? []).map((v) => v.switch().name).join(', ')}`);
  const [transferTag, transferFrom, transferAmt] = transferEvent.vec() ?? [];
  console.log(`    tag:    "${scValToNative(transferTag)}"`);
  console.log(`    from:   ${scValToNative(transferFrom)}`);
  console.log(`    amount: ${scValToNative(transferAmt)}`);

  console.log(`\n  Event::Mint      → ${chalk.cyan(mintEvent.switch().name)}`);
  const [mintTag] = mintEvent.vec() ?? [];
  console.log(`    tag:    "${scValToNative(mintTag)}" (void case — no payload)`);

  console.log(chalk.gray('\n  SDK tip: with contract.Spec use spec.nativeToScVal({ tag: "Transfer", values: [...] }, typeDef).'));
  console.log(chalk.gray('  Without a Spec, build scvVec([scvSymbol(tag), ...payloadScVals]) manually.'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — Optional value encoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Soroban's Option<T> maps directly to JavaScript's null / undefined.
 *
 * - Some(value)  → the inner ScVal for that value
 * - None         → scvVoid()
 *
 * nativeToScVal handles this automatically when the type hint includes
 * { type: 'option', ... }, but constructing it manually is equally clear.
 */
function demonstrateOption(): void {
  console.log(chalk.bold('\n━━━ Option<u32> — Optional Value ━━━'));

  // Option::Some(42) — the value itself
  const someVal = nativeToScVal(42, { type: 'u32' });
  console.log(`  Option::Some(42)  → ${chalk.cyan(someVal.switch().name)}  decoded: ${scValToNative(someVal)}`);

  // Option::None — represented as scvVoid
  const noneVal = xdr.ScVal.scvVoid();
  console.log(`  Option::None      → ${chalk.cyan(noneVal.switch().name)}  decoded: ${scValToNative(noneVal)}`);

  // Encoding helper — nullable JS value
  function encodeOption(value: number | null): xdr.ScVal {
    return value === null ? xdr.ScVal.scvVoid() : nativeToScVal(value, { type: 'u32' });
  }

  const opt1 = encodeOption(99);
  const opt2 = encodeOption(null);

  console.log(`\n  encodeOption(99)   → ${chalk.cyan(opt1.switch().name)}  round-trip: ${scValToNative(opt1)}`);
  console.log(`  encodeOption(null) → ${chalk.cyan(opt2.switch().name)}  round-trip: ${scValToNative(opt2)}`);

  console.log(chalk.gray('\n  SDK tip: when calling spec.funcArgsToScVals(), pass null/undefined for optional'));
  console.log(chalk.gray('  arguments and the Spec will emit scvVoid automatically.'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 7 — Address encoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Soroban addresses represent either an account (G…) or a contract (C…).
 * Both are encoded as scvAddress using Address.fromString().toScVal() or
 * nativeToScVal(strAddress, { type: 'address' }).
 *
 * Decoding returns the string representation (G… or C…).
 */
function demonstrateAddress(): void {
  console.log(chalk.bold('\n━━━ Address — Account and Contract IDs ━━━'));

  const accountId = Keypair.random().publicKey();
  const contractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  // Using nativeToScVal
  const accountAddrVal = nativeToScVal(accountId, { type: 'address' });
  const contractAddrVal = nativeToScVal(contractId, { type: 'address' });

  console.log(`  Account address  → ${chalk.cyan(accountAddrVal.switch().name)}`);
  console.log(`  decoded:           ${scValToNative(accountAddrVal)}`);

  console.log(`\n  Contract address → ${chalk.cyan(contractAddrVal.switch().name)}`);
  console.log(`  decoded:           ${scValToNative(contractAddrVal)}`);

  // Equivalent using Address class directly
  const addrObj = Address.fromString(accountId);
  const directVal = addrObj.toScVal();
  console.log(`\n  Address.fromString().toScVal() → ${chalk.cyan(directVal.switch().name)}`);
  console.log(chalk.gray('\n  SDK tip: both approaches are equivalent. Address.fromString() validates the'));
  console.log(chalk.gray('  checksum and throws immediately if the string is not a valid Stellar address.'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 8 — Invalid argument handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When a JS value cannot be converted to the requested ScVal type, nativeToScVal
 * throws a TypeError synchronously before any network call is made.  This lets
 * you validate arguments early and produce clear error messages rather than
 * receiving an opaque simulation error from the RPC node.
 *
 * Common mistakes:
 *   - Passing a plain number where BigInt is required for u64/i128/u256
 *   - Passing a string that is not a valid Stellar address for scSpecTypeAddress
 *   - Passing a value whose magnitude exceeds the target integer range
 */
function demonstrateInvalidArguments(): void {
  console.log(chalk.bold('\n━━━ Invalid Argument Handling ━━━'));

  // Case 1: wrong type hint
  try {
    // A JS string cannot be encoded as u32
    nativeToScVal('not-a-number' as unknown as number, { type: 'u32' });
    console.log(chalk.red('  [FAIL] Expected TypeError was not thrown'));
  } catch (err: any) {
    console.log(chalk.green(`  ✓ Wrong type → ${err.constructor.name}: ${err.message}`));
  }

  // Case 2: invalid Stellar address string
  try {
    nativeToScVal('GBADADDRESS', { type: 'address' });
    console.log(chalk.red('  [FAIL] Expected error was not thrown'));
  } catch (err: any) {
    console.log(chalk.green(`  ✓ Invalid address → ${err.constructor.name}: ${err.message.slice(0, 80)}`));
  }

  // Case 3: integer out of u32 range
  try {
    nativeToScVal(5_000_000_000, { type: 'u32' }); // > 2^32−1 = 4,294,967,295
    console.log(chalk.red('  [FAIL] Expected RangeError was not thrown'));
  } catch (err: any) {
    console.log(chalk.green(`  ✓ Out-of-range u32 → ${err.constructor.name}: ${err.message}`));
  }

  // Case 4: null passed for a non-optional type
  try {
    nativeToScVal(null as unknown as number, { type: 'u32' });
    console.log(chalk.red('  [FAIL] Expected TypeError was not thrown'));
  } catch (err: any) {
    console.log(chalk.green(`  ✓ null for non-optional → ${err.constructor.name}: ${err.message}`));
  }

  console.log(chalk.gray('\n  SDK tip: validate types and ranges before calling nativeToScVal to surface'));
  console.log(chalk.gray('  errors locally rather than waiting for an RPC simulation response.'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 9 — Live simulation: invoking the native SAC balance() function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Demonstrates encoding a real contract argument (an Address) and decoding
 * the real return value (i128 token balance) through a live simulation.
 *
 * The native XLM Stellar Asset Contract (SAC) is permanently deployed on every
 * Testnet/Mainnet instance and always has a `balance(id: Address) → i128`
 * function.  We query the balance of a freshly funded Friendbot account so the
 * result is non-zero and the simulation always succeeds.
 *
 * The transaction is only simulated — not submitted — which means no fees are
 * deducted and no sequence number is consumed.  Simulation is sufficient to
 * exercise the full argument-encoding and return-value-decoding path.
 */
async function demonstrateLiveSimulation(server: rpc.Server): Promise<void> {
  console.log(chalk.bold('\n━━━ Live Simulation: balance() on Native SAC ━━━'));

  // The native XLM SAC contract ID on Testnet
  const sacContractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  // Create and fund a fresh account via Friendbot so it has a known XLM balance
  console.log(chalk.yellow('  Funding a fresh account via Friendbot...'));
  const keypair = Keypair.random();
  const fundRes = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
  if (!fundRes.ok) {
    console.warn(chalk.red(`  Friendbot request failed (${fundRes.status}). Skipping live simulation.`));
    return;
  }
  console.log(chalk.green(`  Funded: ${keypair.publicKey()}`));

  // Encode the address argument: balance(id: Address) → i128
  // We use nativeToScVal with type "address" — the SDK converts the G… string
  // to an xdr.ScVal.scvAddress wrapping an xdr.ScAddress.scaAccountId.
  const idScVal = nativeToScVal(keypair.publicKey(), { type: 'address' });
  console.log(`\n  Argument encoding:`);
  console.log(`    JS value:  "${keypair.publicKey().slice(0, 20)}…"`);
  console.log(`    ScVal type: ${chalk.cyan(idScVal.switch().name)}`);

  // Build the invocation operation
  const sacContract = new Contract(sacContractId);
  const callOp = sacContract.call('balance', idScVal);

  const sourceAccount = new Account(keypair.publicKey(), '1');
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '1000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(callOp)
    .setTimeout(30)
    .build();

  // Simulate — this calls getLedgerEntries under the hood to read the account's
  // storage footprint, computes resource fees, and runs the contract in a
  // sandboxed host environment without committing any state changes.
  console.log(chalk.yellow('\n  Simulating balance() call...'));
  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    console.warn(chalk.red(`  Simulation error: ${simResult.error}`));
    console.warn(chalk.gray('  (The SAC may not be deployed on this RPC endpoint.)'));
    return;
  }

  console.log(chalk.green('  Simulation succeeded!'));
  console.log(`  Min resource fee: ${simResult.minResourceFee} stroops`);

  // Decode the return value
  // The SAC balance() function returns i128, which the SDK maps to BigInt.
  if (simResult.result?.retval) {
    const retval = simResult.result.retval;
    console.log(`\n  Return value:`);
    console.log(`    Raw ScVal type: ${chalk.cyan(retval.switch().name)}`);

    const nativeBalance = scValToNative(retval) as bigint;
    // XLM SAC balance is in stroops (1 XLM = 10_000_000 stroops)
    const xlmBalance = Number(nativeBalance) / 10_000_000;
    console.log(`    Decoded BigInt: ${nativeBalance.toString()} stroops`);
    console.log(chalk.green(`    XLM balance:   ${xlmBalance.toFixed(7)} XLM`));
  } else {
    console.log(chalk.gray('  No return value in simulation result (unexpected for balance()).'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the Soroban Complex Data Type Invocation example.
 *
 * This example is structured in two parts:
 *
 * Part A — Offline encoding/decoding showcase (no network required)
 *   Demonstrates every major Soroban type — primitives, Vec, Map, Struct,
 *   Enum, tagged union, Option, and Address — showing the JS value, the
 *   resulting ScVal variant, and the decoded round-trip value side by side.
 *   Invalid argument cases are also exercised to show early error behaviour.
 *
 * Part B — Live simulation (network required)
 *   Invokes the native XLM SAC's balance() function against Testnet, encoding
 *   the Address argument and decoding the i128 return value through a real
 *   simulateTransaction RPC call.
 *
 * How JS ↔ Soroban type mapping works
 * ─────────────────────────────────────
 * The SDK converts between JavaScript values and xdr.ScVal using two
 * complementary functions:
 *
 *   nativeToScVal(jsValue, { type })  — JS → ScVal (for encoding arguments)
 *   scValToNative(scVal)              — ScVal → JS (for decoding return values)
 *
 * When a contract.Spec is available (obtained via contract.Spec.fromWasm()),
 * the higher-level spec.funcArgsToScVals(name, argsObject) and
 * spec.funcResToNative(name, retvalScVal) methods use the contract's type
 * metadata to drive conversion automatically, eliminating the need for manual
 * type hints.  The lower-level xdr.ScVal.*() factories give full control when
 * building values that don't fit the nativeToScVal type system.
 */
export async function run(): Promise<void> {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  console.log(chalk.blue(`Soroban Complex Data Types — RPC: ${rpcUrl}`));

  // ── Part A: Offline encoding/decoding ──────────────────────────────────────
  console.log(chalk.bold.yellow('\n═══ Part A: Type Encoding & Decoding (offline) ═══'));
  console.log(chalk.gray('No network connection required for this section.\n'));

  demonstratePrimitives();
  demonstrateVec();
  demonstrateMap();
  demonstrateStruct();
  demonstrateEnum();
  demonstrateOption();
  demonstrateAddress();
  demonstrateInvalidArguments();

  // ── Part B: Live simulation ────────────────────────────────────────────────
  console.log(chalk.bold.yellow('\n═══ Part B: Live Simulation Against Testnet ═══'));

  const server = new rpc.Server(rpcUrl);
  try {
    await demonstrateLiveSimulation(server);
  } catch (err: any) {
    if (err?.message?.includes('fetch') || err?.message?.includes('ECONNREFUSED')) {
      console.warn(
        chalk.red(`  Network error: ${err.message}\n`) +
          chalk.gray('  Check that SOROBAN_RPC_URL is reachable and retry.'),
      );
    } else {
      console.warn(chalk.red(`  Live simulation failed: ${err?.message ?? String(err)}`));
    }
    console.log(chalk.gray('  Part A (offline) completed successfully regardless.'));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(chalk.bold.green('\n━━━ Summary ━━━'));
  console.log(
    chalk.cyan(
      'Type conversion reference:\n' +
        '  Primitive   bool/u32/i32/u64/i64/u128/i128/u256/i256\n' +
        '              → nativeToScVal(value, { type }) or xdr.ScVal.scv*()\n' +
        '  String      → nativeToScVal(str, { type: "string" })  → scvString\n' +
        '  Symbol      → nativeToScVal(str, { type: "symbol" })  → scvSymbol\n' +
        '  Bytes       → nativeToScVal(Buffer, { type: "bytes" }) → scvBytes\n' +
        '  Vec<T>      → nativeToScVal(array, { type: "vec", element: { type } })\n' +
        '  Map<K,V>    → nativeToScVal([[k,v],...], { type: "map", key, value })\n' +
        '  Struct      → xdr.ScVal.scvMap([new xdr.ScMapEntry(...)]) (symbol keys)\n' +
        '  Int enum    → xdr.ScVal.scvU32(discriminant)\n' +
        '  Tagged union→ xdr.ScVal.scvVec([scvSymbol(tag), ...payload])\n' +
        '  Option<T>   → Some: the inner ScVal;  None: xdr.ScVal.scvVoid()\n' +
        '  Address     → nativeToScVal(str, { type: "address" }) or Address.fromString().toScVal()\n\n' +
        '  With contract.Spec:\n' +
        '    spec.funcArgsToScVals(funcName, argsObj) — encode all args at once\n' +
        '    spec.funcResToNative(funcName, retvalScVal) — decode return value',
    ),
  );
}
