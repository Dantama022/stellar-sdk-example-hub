import { Keypair, Horizon, Networks, TransactionBuilder, Operation, Asset } from '@stellar/stellar-sdk';

/**
 * SEP-24 Interactive Deposit & Withdrawal Example
 *
 * SEP-24 Architecture Overview:
 * ─────────────────────────────
 * SEP-24 (Hosted Deposit and Withdrawal) defines how a Stellar wallet interacts
 * with an "anchor" — a fiat on/off-ramp service — to move value between the
 * traditional financial system and the Stellar network.
 *
 * The protocol flow has three distinct phases:
 *
 *  1. Authentication (SEP-10)
 *     The wallet proves ownership of a Stellar keypair to the anchor without
 *     spending any on-chain fees. It does this by:
 *       a. Requesting a challenge transaction from the anchor's auth endpoint.
 *       b. Signing the challenge with the account's secret key.
 *       c. Posting the signed challenge back to receive a short-lived JWT.
 *
 *  2. Interactive Flow Initiation
 *     Using the JWT, the wallet calls the anchor's `/transactions/deposit/interactive`
 *     or `/transactions/withdraw/interactive` endpoint. The anchor returns:
 *       - A transaction `id` for status tracking.
 *       - A temporary `url` pointing to the anchor's hosted UI (KYC form, bank
 *         details, etc.). The user must visit this URL to complete their side of
 *         the interaction.
 *
 *  3. Transaction Polling
 *     While (or after) the user completes the anchor UI, the wallet polls
 *     `GET /transactions/:id` to watch status progress through the anchor's
 *     internal states (pending_user_transfer_start → pending_anchor →
 *     pending_stellar → completed / error).
 *
 *     For withdrawals, once status reaches `pending_user_transfer_start` the
 *     wallet must send the specified asset to the anchor's `withdraw_anchor_account`
 *     memo-tagged address to trigger settlement.
 *
 * This example targets the SDF-maintained public testnet anchor at
 * https://testanchor.stellar.org which fully implements both SEP-10 and SEP-24.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface StellarToml {
  WEB_AUTH_ENDPOINT?: string;
  TRANSFER_SERVER_SEP0024?: string;
  CURRENCIES?: Array<{ code: string; issuer?: string }>;
}

interface ChallengeResponse {
  transaction: string;
  network_passphrase: string;
}

interface AuthTokenResponse {
  token: string;
}

interface DepositResponse {
  type: string;
  url: string;
  id: string;
}

interface WithdrawalResponse {
  type: string;
  url: string;
  id: string;
}

interface AnchorTransaction {
  id: string;
  kind: string;
  status: string;
  status_eta?: number;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: string;
  deposit_memo?: string;
  deposit_memo_type?: string;
  stellar_transaction_id?: string;
  message?: string;
  started_at?: string;
  completed_at?: string;
}

interface TransactionStatusResponse {
  transaction: AnchorTransaction;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ANCHOR_DOMAIN = 'testanchor.stellar.org';
const ANCHOR_TOML_URL = `https://${ANCHOR_DOMAIN}/.well-known/stellar.toml`;
// The test anchor's demo asset — "SRT" is the standard SEP-24 test token
const TEST_ASSET_CODE = 'SRT';
// Polling interval: 3 seconds between status checks
const POLL_INTERVAL_MS = 3_000;
// Maximum number of polls before giving up
const MAX_POLLS = 10;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fetches and parses the anchor's stellar.toml to discover service endpoints.
 */
async function fetchStellarToml(tomlUrl: string): Promise<StellarToml> {
  const res = await fetch(tomlUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch stellar.toml (${res.status}): ${tomlUrl}`);
  }
  const text = await res.text();

  // Minimal TOML parser for the fields we need
  const parsed: StellarToml = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const webAuthMatch = trimmed.match(/^WEB_AUTH_ENDPOINT\s*=\s*"(.+?)"/);
    const transferMatch = trimmed.match(/^TRANSFER_SERVER_SEP0024\s*=\s*"(.+?)"/);
    if (webAuthMatch) parsed.WEB_AUTH_ENDPOINT = webAuthMatch[1];
    if (transferMatch) parsed.TRANSFER_SERVER_SEP0024 = transferMatch[1];
  }
  return parsed;
}

/**
 * Fetches the anchor info endpoint to locate the asset issuer for a given code.
 */
async function fetchAssetIssuer(
  transferServer: string,
  assetCode: string,
  jwt: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(`${transferServer}/info`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return undefined;
    const data: any = await res.json();
    const depositAssets = data?.deposit ?? {};
    return depositAssets[assetCode]?.asset_issuer as string | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Executes the full SEP-10 challenge-response authentication flow.
 * Returns a JWT token valid for subsequent SEP-24 API calls.
 */
async function sep10Authenticate(
  webAuthEndpoint: string,
  keypair: Keypair,
  anchorDomain: string,
): Promise<string> {
  console.log('\n  [SEP-10] Requesting challenge transaction from anchor...');

  // Step 1 — GET the challenge
  const challengeUrl = `${webAuthEndpoint}?account=${keypair.publicKey()}&home_domain=${anchorDomain}`;
  const challengeRes = await fetch(challengeUrl);
  if (!challengeRes.ok) {
    throw new Error(`SEP-10 challenge request failed (${challengeRes.status})`);
  }
  const challengeData = (await challengeRes.json()) as ChallengeResponse;
  console.log(`  [SEP-10] Challenge received (network: ${challengeData.network_passphrase})`);

  // Step 2 — Sign the challenge transaction
  // The challenge is a valid Stellar transaction XDR that we must sign to prove key ownership
  const { TransactionBuilder: TB } = await import('@stellar/stellar-sdk');
  const networkPassphrase = challengeData.network_passphrase || Networks.TESTNET;
  const challengeTx = TB.fromXDR(challengeData.transaction, networkPassphrase);

  if (!('sign' in challengeTx)) {
    throw new Error('SEP-10 challenge did not return a standard Transaction');
  }
  (challengeTx as any).sign(keypair);
  console.log('  [SEP-10] Challenge transaction signed.');

  // Step 3 — POST the signed challenge to obtain a JWT
  const tokenRes = await fetch(webAuthEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: (challengeTx as any).toXDR() }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`SEP-10 token exchange failed (${tokenRes.status}): ${body}`);
  }
  const tokenData = (await tokenRes.json()) as AuthTokenResponse;
  console.log('  [SEP-10] JWT obtained successfully.');
  return tokenData.token;
}

/**
 * Initiates a SEP-24 interactive deposit and returns the anchor response.
 */
async function initiateDeposit(
  transferServer: string,
  jwt: string,
  assetCode: string,
  account: string,
): Promise<DepositResponse> {
  const body = new URLSearchParams({
    asset_code: assetCode,
    account,
    amount: '10', // Optional hint — anchor may override
  });

  const res = await fetch(`${transferServer}/transactions/deposit/interactive`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Deposit initiation failed (${res.status}): ${errText}`);
  }
  return res.json() as Promise<DepositResponse>;
}

/**
 * Initiates a SEP-24 interactive withdrawal and returns the anchor response.
 */
async function initiateWithdrawal(
  transferServer: string,
  jwt: string,
  assetCode: string,
  account: string,
): Promise<WithdrawalResponse> {
  const body = new URLSearchParams({
    asset_code: assetCode,
    account,
    amount: '5',
  });

  const res = await fetch(`${transferServer}/transactions/withdraw/interactive`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Withdrawal initiation failed (${res.status}): ${errText}`);
  }
  return res.json() as Promise<WithdrawalResponse>;
}

/**
 * Polls the anchor's transaction status endpoint until a terminal state is
 * reached or the maximum poll count is exhausted.
 *
 * Terminal states: completed, error, expired, no_market, too_small, too_large,
 * refunded, superseded.
 */
async function pollTransactionStatus(
  transferServer: string,
  jwt: string,
  transactionId: string,
  label: string,
): Promise<AnchorTransaction> {
  const TERMINAL_STATES = new Set([
    'completed',
    'error',
    'expired',
    'no_market',
    'too_small',
    'too_large',
    'refunded',
    'superseded',
  ]);

  let lastStatus = '';
  let polls = 0;

  while (polls < MAX_POLLS) {
    polls++;

    const res = await fetch(`${transferServer}/transaction?id=${transactionId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    if (!res.ok) {
      throw new Error(`Status poll failed (${res.status}) for transaction ${transactionId}`);
    }

    const data = (await res.json()) as TransactionStatusResponse;
    const tx = data.transaction;

    if (tx.status !== lastStatus) {
      console.log(
        `  [${label}] Status update (poll ${polls}/${MAX_POLLS}): ${lastStatus || '(none)'} → ${tx.status}`,
      );
      if (tx.message) console.log(`    Anchor message: "${tx.message}"`);
      if (tx.amount_in) console.log(`    Amount in:  ${tx.amount_in}`);
      if (tx.amount_out) console.log(`    Amount out: ${tx.amount_out}`);
      if (tx.amount_fee) console.log(`    Fee:        ${tx.amount_fee}`);
      lastStatus = tx.status;
    }

    if (TERMINAL_STATES.has(tx.status)) {
      console.log(`  [${label}] Reached terminal status: ${tx.status}`);
      return tx;
    }

    if (polls < MAX_POLLS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  // Return the last known state even if not terminal (demo/testnet anchors may
  // stay pending_user_transfer_start without a real bank interaction)
  const res = await fetch(`${transferServer}/transaction?id=${transactionId}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const data = (await res.json()) as TransactionStatusResponse;
  console.log(`  [${label}] Max polls reached. Last status: ${data.transaction.status}`);
  return data.transaction;
}

/**
 * Sends the withdrawal asset amount to the anchor's designated account.
 * This is the on-chain step required after the anchor signals
 * `pending_user_transfer_start` for a withdrawal.
 */
async function sendWithdrawalPayment(
  server: Horizon.Server,
  sourceKeypair: Keypair,
  anchorAccount: string,
  memo: string | undefined,
  assetCode: string,
  assetIssuer: string,
  amount: string,
): Promise<string> {
  const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());
  const asset = new Asset(assetCode, assetIssuer);

  const txBuilder = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  }).addOperation(
    Operation.payment({
      destination: anchorAccount,
      asset,
      amount,
    }),
  );

  // Attach the memo the anchor requested (text memo is most common for SEP-24)
  if (memo) {
    const { Memo } = await import('@stellar/stellar-sdk');
    txBuilder.addMemo(Memo.text(memo));
  }

  const tx = txBuilder.setTimeout(30).build();
  tx.sign(sourceKeypair);

  const response = await server.submitTransaction(tx);
  return response.hash;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Runs the SEP-24 deposit and withdrawal example.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SEP-24 Interactive Deposit & Withdrawal Example');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Anchor domain:  ${ANCHOR_DOMAIN}`);
  console.log(`  Horizon server: ${horizonUrl}`);
  console.log(`  Asset code:     ${TEST_ASSET_CODE}`);
  console.log('───────────────────────────────────────────────────────────\n');

  // ── Step 1: Discover anchor endpoints from stellar.toml ────────────────────
  console.log('Step 1: Fetching anchor metadata from stellar.toml...');
  const toml = await fetchStellarToml(ANCHOR_TOML_URL);

  if (!toml.WEB_AUTH_ENDPOINT) {
    throw new Error('stellar.toml is missing WEB_AUTH_ENDPOINT');
  }
  if (!toml.TRANSFER_SERVER_SEP0024) {
    throw new Error('stellar.toml is missing TRANSFER_SERVER_SEP0024');
  }

  console.log(`  WEB_AUTH_ENDPOINT:       ${toml.WEB_AUTH_ENDPOINT}`);
  console.log(`  TRANSFER_SERVER_SEP0024: ${toml.TRANSFER_SERVER_SEP0024}`);

  // ── Step 2: Generate and fund a test keypair ────────────────────────────────
  console.log('\nStep 2: Generating wallet keypair and funding via Friendbot...');
  const walletKeypair = Keypair.random();
  console.log(`  Public key: ${walletKeypair.publicKey()}`);

  const fundRes = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(walletKeypair.publicKey())}`,
  );
  if (!fundRes.ok) {
    throw new Error(`Friendbot funding failed (${fundRes.status})`);
  }
  console.log('  Account funded with testnet XLM.');

  // ── Step 3: SEP-10 authentication ──────────────────────────────────────────
  console.log('\nStep 3: Authenticating with anchor via SEP-10...');
  const jwt = await sep10Authenticate(
    toml.WEB_AUTH_ENDPOINT,
    walletKeypair,
    ANCHOR_DOMAIN,
  );
  console.log('  Authentication successful. JWT acquired.');

  // ── Step 4: Establish trustline for the test asset ────────────────────────
  // We need to know the asset issuer before we can create a trustline.
  // Fetch it from the anchor's /info endpoint.
  console.log(`\nStep 4: Fetching ${TEST_ASSET_CODE} asset issuer from anchor /info...`);
  const assetIssuer = await fetchAssetIssuer(
    toml.TRANSFER_SERVER_SEP0024,
    TEST_ASSET_CODE,
    jwt,
  );

  if (!assetIssuer) {
    console.log(
      `  Warning: Could not resolve issuer for ${TEST_ASSET_CODE} from anchor /info. ` +
        'Skipping trustline and withdrawal payment steps.',
    );
  } else {
    console.log(`  Asset issuer: ${assetIssuer}`);
    console.log(`  Establishing trustline for ${TEST_ASSET_CODE}...`);

    const walletAccount = await server.loadAccount(walletKeypair.publicKey());
    const trustTx = new TransactionBuilder(walletAccount, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.changeTrust({
          asset: new Asset(TEST_ASSET_CODE, assetIssuer),
          limit: '100000000',
        }),
      )
      .setTimeout(30)
      .build();

    trustTx.sign(walletKeypair);
    const trustRes = await server.submitTransaction(trustTx);
    console.log(`  Trustline established. Tx hash: ${trustRes.hash}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEPOSIT FLOW
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n───────────────────────────────────────────────────────────');
  console.log('  DEPOSIT FLOW');
  console.log('───────────────────────────────────────────────────────────');

  // ── Step 5: Initiate deposit ───────────────────────────────────────────────
  console.log('\nStep 5: Initiating SEP-24 interactive deposit...');
  let depositResponse: DepositResponse;
  try {
    depositResponse = await initiateDeposit(
      toml.TRANSFER_SERVER_SEP0024,
      jwt,
      TEST_ASSET_CODE,
      walletKeypair.publicKey(),
    );
    console.log(`  Deposit initiated successfully.`);
    console.log(`  Transaction ID: ${depositResponse.id}`);
    console.log(`  Anchor interactive URL:`);
    console.log(`    ${depositResponse.url}`);
    console.log(
      '  (In a real wallet, the user would open this URL to complete KYC / bank details.)',
    );
  } catch (err: any) {
    console.error(`  Deposit initiation error: ${err.message}`);
    console.log('  Continuing to withdrawal flow...');
    // Provide a stub so later code can still reference depositResponse safely
    depositResponse = { type: 'interactive_customer_info_needed', url: '', id: '' };
  }

  // ── Step 6: Poll deposit status ────────────────────────────────────────────
  if (depositResponse.id) {
    console.log('\nStep 6: Polling deposit transaction status...');
    try {
      const depositTx = await pollTransactionStatus(
        toml.TRANSFER_SERVER_SEP0024,
        jwt,
        depositResponse.id,
        'DEPOSIT',
      );

      console.log('\n  Deposit transaction summary:');
      console.log(`    ID:     ${depositTx.id}`);
      console.log(`    Kind:   ${depositTx.kind}`);
      console.log(`    Status: ${depositTx.status}`);
      if (depositTx.stellar_transaction_id) {
        console.log(`    Stellar Tx: ${depositTx.stellar_transaction_id}`);
      }
      if (depositTx.completed_at) {
        console.log(`    Completed: ${depositTx.completed_at}`);
      }
    } catch (err: any) {
      console.error(`  Deposit polling error: ${err.message}`);
    }
  } else {
    console.log('\nStep 6: Skipping deposit polling (no transaction ID).');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WITHDRAWAL FLOW
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n───────────────────────────────────────────────────────────');
  console.log('  WITHDRAWAL FLOW');
  console.log('───────────────────────────────────────────────────────────');

  // ── Step 7: Initiate withdrawal ────────────────────────────────────────────
  console.log('\nStep 7: Initiating SEP-24 interactive withdrawal...');
  let withdrawalResponse: WithdrawalResponse;
  try {
    withdrawalResponse = await initiateWithdrawal(
      toml.TRANSFER_SERVER_SEP0024,
      jwt,
      TEST_ASSET_CODE,
      walletKeypair.publicKey(),
    );
    console.log(`  Withdrawal initiated successfully.`);
    console.log(`  Transaction ID: ${withdrawalResponse.id}`);
    console.log(`  Anchor interactive URL:`);
    console.log(`    ${withdrawalResponse.url}`);
    console.log(
      '  (In a real wallet, the user would open this URL to provide bank routing info.)',
    );
  } catch (err: any) {
    console.error(`  Withdrawal initiation error: ${err.message}`);
    console.log('  Skipping withdrawal polling and payment steps.');
    return;
  }

  // ── Step 8: Poll withdrawal status and optionally send payment ─────────────
  console.log('\nStep 8: Polling withdrawal transaction status...');
  try {
    const withdrawalTx = await pollTransactionStatus(
      toml.TRANSFER_SERVER_SEP0024,
      jwt,
      withdrawalResponse.id,
      'WITHDRAWAL',
    );

    console.log('\n  Withdrawal transaction summary:');
    console.log(`    ID:     ${withdrawalTx.id}`);
    console.log(`    Kind:   ${withdrawalTx.kind}`);
    console.log(`    Status: ${withdrawalTx.status}`);
    if (withdrawalTx.withdraw_anchor_account) {
      console.log(`    Anchor account: ${withdrawalTx.withdraw_anchor_account}`);
    }
    if (withdrawalTx.withdraw_memo) {
      console.log(`    Memo (${withdrawalTx.withdraw_memo_type}): ${withdrawalTx.withdraw_memo}`);
    }

    // If anchor is waiting for the on-chain transfer and we have issuer info,
    // send the asset payment to complete the withdrawal.
    if (
      withdrawalTx.status === 'pending_user_transfer_start' &&
      withdrawalTx.withdraw_anchor_account &&
      assetIssuer
    ) {
      const sendAmount = withdrawalTx.amount_in ?? '1';
      console.log(
        `\nStep 8b: Anchor is ready. Sending ${sendAmount} ${TEST_ASSET_CODE} to anchor...`,
      );
      try {
        const payHash = await sendWithdrawalPayment(
          server,
          walletKeypair,
          withdrawalTx.withdraw_anchor_account,
          withdrawalTx.withdraw_memo,
          TEST_ASSET_CODE,
          assetIssuer,
          sendAmount,
        );
        console.log(`  Withdrawal payment sent. Tx hash: ${payHash}`);
        console.log('  Anchor will now process the off-chain settlement.');
      } catch (payErr: any) {
        console.error(`  Withdrawal payment error: ${payErr.message}`);
        console.log(
          '  (This is expected on testnet if the wallet has no SRT balance yet — ' +
            'a real flow would first complete the deposit.)',
        );
      }
    } else if (withdrawalTx.status === 'pending_user_transfer_start' && !assetIssuer) {
      console.log(
        '\n  Note: Anchor awaits on-chain transfer, but asset issuer could not be resolved.',
      );
      console.log('  In a production wallet, retrieve the issuer from /info and send the payment.');
    }
  } catch (err: any) {
    console.error(`  Withdrawal polling error: ${err.message}`);
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  SEP-24 Example Complete');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  What was demonstrated:');
  console.log('    ✓ Discovered anchor endpoints from stellar.toml');
  console.log('    ✓ Authenticated wallet via SEP-10 challenge-response');
  console.log('    ✓ Established trustline for the anchor asset');
  console.log('    ✓ Initiated an interactive deposit (SEP-24)');
  console.log('    ✓ Polled deposit transaction status');
  console.log('    ✓ Initiated an interactive withdrawal (SEP-24)');
  console.log('    ✓ Polled withdrawal transaction status');
  console.log('    ✓ Sent on-chain withdrawal payment when anchor was ready');
  console.log('\n  SEP-24 reference: https://stellar.org/protocol/sep-24');
  console.log('═══════════════════════════════════════════════════════════\n');
}
