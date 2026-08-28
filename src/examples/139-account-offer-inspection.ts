import { Horizon, StrKey } from '@stellar/stellar-sdk';
import chalk from 'chalk';
import inquirer from 'inquirer';

export interface OfferStats {
  pair: string;
  totalOffered: number;
  averagePrice: number;
  lowestSellPrice: number | null;
  highestBuyPrice: number | null;
  activeOffers: number;
}

export interface FormattedOffer {
  id: string;
  sellingAsset: string;
  buyingAsset: string;
  amount: string;
  price: string;
  priceDecimal: string;
  type: 'ASK' | 'BID';
}

function formatAsset(asset: any): string {
  if (asset.asset_type === 'native') return 'XLM';
  return `${asset.asset_code}:${asset.asset_issuer}`;
}

export async function run(params?: any): Promise<void> {
  console.log(chalk.bold.green('\n🔍 Stellar Account Offer Inspection'));

  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  let accountId = params?.accountId;
  let isJson = params?.json === 'true' || params?.json === true;

  if (!accountId && !isJson) {
    const prompt = await inquirer.prompt([
      {
        type: 'input',
        name: 'accountId',
        message: 'Enter the Stellar account ID to inspect:',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output results in JSON format?',
        default: false,
      },
    ]);
    accountId = prompt.accountId;
    isJson = prompt.json;
  }

  // Graceful Handling: Invalid Account ID
  if (!accountId || !StrKey.isValidEd25519PublicKey(accountId)) {
    const errMsg =
      'Invalid account ID. Please provide a valid Stellar public key (starting with G).';
    if (isJson) {
      console.log(JSON.stringify({ error: errMsg }, null, 2));
      return;
    }
    console.error(chalk.red(`\n❌ ${errMsg}`));
    return;
  }

  try {
    const offersResponse = await server.offers().forAccount(accountId).limit(200).call();
    const offers = offersResponse.records;

    // Graceful Handling: No open offers
    if (offers.length === 0) {
      const msg = `No active offers found for account ${accountId}.`;
      if (isJson) {
        console.log(JSON.stringify({ accountId, offers: [] }, null, 2));
        return;
      }
      console.log(chalk.yellow(`\n⚠️ ${msg}`));
      return;
    }

    const groupedOffers: Record<string, Horizon.ServerApi.OfferRecord[]> = {};
    const formattedOffers: FormattedOffer[] = [];

    offers.forEach((offer) => {
      const selling = formatAsset(offer.selling);
      const buying = formatAsset(offer.buying);

      const pair = [selling, buying].sort().join(' / ');
      if (!groupedOffers[pair]) groupedOffers[pair] = [];
      groupedOffers[pair].push(offer);

      const isAsk = selling === pair.split(' / ')[0];

      formattedOffers.push({
        id: String(offer.id),
        sellingAsset: selling,
        buyingAsset: buying,
        amount: offer.amount,
        price: `${offer.price_r.n}/${offer.price_r.d}`,
        priceDecimal: offer.price,
        type: isAsk ? 'ASK' : 'BID',
      });
    });

    const summaryStats: OfferStats[] = Object.entries(groupedOffers).map(([pair, pairOffers]) => {
      let totalAmount = 0;
      let sumPrice = 0;
      let lowestSell = Infinity;
      let highestBuy = -Infinity;

      pairOffers.forEach((o) => {
        const amt = parseFloat(o.amount);
        const price = parseFloat(o.price);

        totalAmount += amt;
        sumPrice += price;

        const selling = formatAsset(o.selling);
        const isAsk = selling === pair.split(' / ')[0];

        if (isAsk && price < lowestSell) lowestSell = price;
        if (!isAsk && price > highestBuy) highestBuy = price;
      });

      return {
        pair,
        activeOffers: pairOffers.length,
        totalOffered: totalAmount,
        averagePrice: sumPrice / pairOffers.length,
        lowestSellPrice: lowestSell === Infinity ? null : lowestSell,
        highestBuyPrice: highestBuy === -Infinity ? null : highestBuy,
      };
    });

    if (isJson) {
      console.log(
        JSON.stringify({ accountId, offers: formattedOffers, summary: summaryStats }, null, 2),
      );
      return;
    }

    // Console Output
    console.log(chalk.cyan(`\nFound ${offers.length} active offer(s) for ${accountId}:\n`));

    formattedOffers.forEach((o) => {
      console.log(`${chalk.bold('Offer ID:')} ${o.id}`);
      console.log(
        `  ${chalk.gray('Selling:')} ${o.sellingAsset} | ${chalk.gray('Buying:')} ${o.buyingAsset}`,
      );
      console.log(
        `  ${chalk.gray('Amount:')} ${o.amount} | ${chalk.gray('Price:')} ${o.priceDecimal} (${o.price})`,
      );
      console.log(`  ${chalk.gray('Type:')} ${o.type}`);
      console.log('---');
    });

    console.log(chalk.bold.cyan('\n📊 Summary Statistics by Trading Pair:'));
    summaryStats.forEach((stat) => {
      console.log(`\n${chalk.bold.yellow(stat.pair)}`);
      console.log(`  Active Offers:  ${stat.activeOffers}`);
      console.log(`  Total Offered:  ${stat.totalOffered.toFixed(7)}`);
      console.log(`  Average Price:  ${stat.averagePrice.toFixed(7)}`);
      console.log(`  Lowest Ask:     ${stat.lowestSellPrice ? stat.lowestSellPrice : 'N/A'}`);
      console.log(`  Highest Bid:    ${stat.highestBuyPrice ? stat.highestBuyPrice : 'N/A'}`);
    });
  } catch (error: any) {
    if (error.response?.status === 404) {
      if (isJson)
        return console.log(JSON.stringify({ error: 'Account not found on the network.' }));
      console.error(chalk.red('\n❌ Account not found on the network. It may be unfunded.'));
    } else {
      if (isJson) return console.log(JSON.stringify({ error: error.message }));
      console.error(chalk.red(`\n❌ Error fetching offers: ${error.message}`));
    }
  }
}
