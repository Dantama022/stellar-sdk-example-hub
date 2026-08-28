import { Horizon, StrKey } from '@stellar/stellar-sdk';
import chalk from 'chalk';
import inquirer from 'inquirer';

export interface MergePreflightReport {
  sourceAccountId: string;
  destinationAccountId: string;
  isMergeReady: boolean;
  xlmBalance: string;
  transferableBalance: string;
  blockingConditions: string[];
  remediationSuggestions: string[];
  accountDetails: {
    subentries: number;
    trustlinesCount: number;
    openOffersCount: number;
    signersCount: number;
    sponsorshipsCount: number;
  };
}

export async function run(params?: any): Promise<void> {
  console.log(chalk.bold.green('\n🔍 Stellar Account Merge Preflight Analysis'));

  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  let sourceAccountId = params?.sourceAccountId;
  let destinationAccountId = params?.destinationAccountId;
  let isJson = params?.json === 'true' || params?.json === true;

  if ((!sourceAccountId || !destinationAccountId) && !isJson) {
    const prompt = await inquirer.prompt([
      {
        type: 'input',
        name: 'sourceAccountId',
        message: 'Enter source account ID (to be merged/deleted):',
      },
      {
        type: 'input',
        name: 'destinationAccountId',
        message: 'Enter destination account ID (to receive remaining funds):',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output results in JSON format?',
        default: false,
      },
    ]);
    sourceAccountId = prompt.sourceAccountId;
    destinationAccountId = prompt.destinationAccountId;
    isJson = prompt.json;
  }

  // Graceful Handling: Validate Source & Destination
  if (!sourceAccountId || !StrKey.isValidEd25519PublicKey(sourceAccountId)) {
    const err = 'Invalid source account ID format.';
    if (isJson) return console.log(JSON.stringify({ error: err }));
    console.error(chalk.red(`\n❌ ${err}`));
    return;
  }

  if (!destinationAccountId || !StrKey.isValidEd25519PublicKey(destinationAccountId)) {
    const err = 'Invalid destination account ID format.';
    if (isJson) return console.log(JSON.stringify({ error: err }));
    console.error(chalk.red(`\n❌ ${err}`));
    return;
  }

  if (sourceAccountId === destinationAccountId) {
    const err = 'Source and destination accounts cannot be the same.';
    if (isJson) return console.log(JSON.stringify({ error: err }));
    console.error(chalk.red(`\n❌ ${err}`));
    return;
  }

  try {
    console.log(chalk.cyan('\nFetching account states from Horizon...'));
    
    // Fetch source and destination accounts concurrently
    const [sourceAccount, destResponse] = await Promise.all([
      server.loadAccount(sourceAccountId),
      server.loadAccount(destinationAccountId).catch(() => null),
    ]);

    if (!destResponse) {
      const err = 'Destination account does not exist on the network.';
      if (isJson) return console.log(JSON.stringify({ error: err }));
      console.error(chalk.red(`\n❌ ${err}`));
      return;
    }

    // Fetch open offers for the source account
    const offersResponse = await server.offers().forAccount(sourceAccountId).call();
    const openOffers = offersResponse.records;

    const blockingConditions: string[] = [];
    const remediationSuggestions: string[] = [];

    // 1. Inspect Trustlines & Non-native Balances
    const nonNativeBalances = sourceAccount.balances.filter((b: any) => b.asset_type !== 'native');
    if (nonNativeBalances.length > 0) {
      blockingConditions.push(`Account has ${nonNativeBalances.length} active trustlines / non-native asset balance(s).`);
      remediationSuggestions.push('Remove all trustlines and clear non-native asset balances before merging.');
    }

    // 2. Inspect Open Offers
    if (openOffers.length > 0) {
      blockingConditions.push(`Account has ${openOffers.length} open SDEX offer(s).`);
      remediationSuggestions.push('Cancel all active buy/sell offers to unlock locked reserves.');
    }

    // 3. Inspect Signers (Extra signers beyond master key)
    const extraSigners = sourceAccount.signers.filter((s: any) => s.key !== sourceAccountId);
    if (extraSigners.length > 0) {
      blockingConditions.push(`Account has ${extraSigners.length} auxiliary signer(s) configured.`);
      remediationSuggestions.push('Remove extra signers or reduce their weights/thresholds if required.');
    }

    // 4. Inspect Liabilities
    let totalSellingLiabilities = 0;
    let totalBuyingLiabilities = 0;
    sourceAccount.balances.forEach((b: any) => {
      if (b.selling_liabilities) totalSellingLiabilities += parseFloat(b.selling_liabilities);
      if (b.buying_liabilities) totalBuyingLiabilities += parseFloat(b.buying_liabilities);
    });

    if (totalSellingLiabilities > 0 || totalBuyingLiabilities > 0) {
      blockingConditions.push('Account has active buying or selling liabilities.');
      remediationSuggestions.push('Settle or clear obligations associated with open trades.');
    }

    // 5. Sponsorship checks
    const numSponsored = (sourceAccount as any).num_sponsored || 0;
    const numSponsoring = (sourceAccount as any).num_sponsoring || 0;
    if (numSponsored > 0 || numSponsoring > 0) {
      blockingConditions.push(`Active sponsorship state detected (Sponsored: ${numSponsored}, Sponsoring: ${numSponsoring}).`);
      remediationSuggestions.push('Revoke or end sponsorship relations before executing account merge.');
    }

    // Calculate native balance & transferable balance
    const nativeBalanceObj = sourceAccount.balances.find((b: any) => b.asset_type === 'native');
    const xlmBalance = nativeBalanceObj ? nativeBalanceObj.balance : '0';
    
    // Account merge transfers the entire remaining XLM balance to the destination
    const transferableBalance = xlmBalance;
    const isMergeReady = blockingConditions.length === 0;

    const report: MergePreflightReport = {
      sourceAccountId,
      destinationAccountId,
      isMergeReady,
      xlmBalance,
      transferableBalance,
      blockingConditions,
      remediationSuggestions,
      accountDetails: {
        subentries: sourceAccount.subentry_count,
        trustlinesCount: nonNativeBalances.length,
        openOffersCount: openOffers.length,
        signersCount: sourceAccount.signers.length,
        sponsorshipsCount: numSponsored + numSponsoring,
      },
    };

    if (isJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    // Console output display
    console.log(chalk.bold.cyan('\n📋 Account Merge Readiness Report:'));
    console.log(`  Source Account:      ${sourceAccountId}`);
    console.log(`  Destination Account: ${destinationAccountId}`);
    console.log(`  XLM Balance:         ${xlmBalance} XLM`);
    console.log(`  Transferable Amount: ${transferableBalance} XLM`);
    console.log(`  Merge Ready?         ${isMergeReady ? chalk.green('YES ✅') : chalk.red('NO ❌')}`);

    if (!isMergeReady) {
      console.log(chalk.bold.yellow('\n🚧 Blocking Conditions:'));
      blockingConditions.forEach((b) => console.log(`  - ${b}`));

      console.log(chalk.bold.blue('\n💡 Remediation Suggestions:'));
      remediationSuggestions.forEach((r) => console.log(`  - ${r}`));
    } else {
      console.log(chalk.green('\n✨ Account is fully cleared and ready for merging via AccountMerge operation!'));
    }

  } catch (error: any) {
    if (error.response?.status === 404) {
      if (isJson) return console.log(JSON.stringify({ error: 'Source account not found on network.' }));
      console.error(chalk.red('\n❌ Source account not found on the network.'));
    } else {
      if (isJson) return console.log(JSON.stringify({ error: error.message }));
      console.error(chalk.red(`\n❌ Error performing merge preflight: ${error.message}`));
    }
  }
}