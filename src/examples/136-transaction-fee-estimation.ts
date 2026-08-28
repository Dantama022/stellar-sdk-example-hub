import { Horizon } from '@stellar/stellar-sdk';
import chalk from 'chalk';
import inquirer from 'inquirer';

export interface FeeEstimationResult {
  baseFeeInStroops: number;
  operationCount: number;
  minimumFeeStroops: number;
  minimumFeeXlm: string;
  feeBumpEstimatedStroops: number;
  feeBumpEstimatedXlm: string;
}

export function calculateTransactionFees(
  baseFeeStroops: number,
  operationCount: number,
): FeeEstimationResult {
  const minFeeStroops = baseFeeStroops * Math.max(1, operationCount);
  const feeBumpStroops = minFeeStroops + baseFeeStroops * 2;

  return {
    baseFeeInStroops: baseFeeStroops,
    operationCount,
    minimumFeeStroops: minFeeStroops,
    minimumFeeXlm: (minFeeStroops / 10_000_000).toFixed(7),
    feeBumpEstimatedStroops: feeBumpStroops,
    feeBumpEstimatedXlm: (feeBumpStroops / 10_000_000).toFixed(7),
  };
}

export async function run(params?: any): Promise<void> {
  console.log(chalk.bold.green('\n📊 Stellar Transaction Fee Estimation Example'));

  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  let opCountInput = params?.operationCount;
  let isJson = params?.json === 'true' || params?.json === true;

  if (opCountInput === undefined && !isJson) {
    const prompt = await inquirer.prompt([
      {
        type: 'input',
        name: 'operationCount',
        message: 'Enter number of operations for transaction simulation:',
        default: '1',
      },
      {
        type: 'confirm',
        name: 'json',
        message: 'Output results in JSON format?',
        default: false,
      },
    ]);
    opCountInput = prompt.operationCount;
    isJson = prompt.json;
  }

  const operationCount = parseInt(opCountInput || '1', 10);

  try {
    console.log(chalk.cyan('\nRetrieving current network fee statistics from Horizon...'));
    const feeStats: any = await server.feeStats();
    const baseFeeStroops = parseInt(feeStats.last_ledger_base_fee, 10) || 100;

    const singleOpEst = calculateTransactionFees(baseFeeStroops, 1);
    const multiOpEst = calculateTransactionFees(baseFeeStroops, operationCount);

    const report = {
      baseFeeStroops,
      singleOperation: singleOpEst,
      customOperations: multiOpEst,
    };

    if (isJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(chalk.bold.cyan('\n📋 Network Fee Overview:'));
    console.log(
      `  Current Base Fee:  ${baseFeeStroops} stroops (${(baseFeeStroops / 10_000_000).toFixed(7)} XLM)`,
    );
    console.log(`  Ledger Capacity:   ${feeStats.ledger_capacity_usage || 'N/A'}`);
    console.log(`  P50 Accepted Fee:  ${feeStats.p50_accepted_fee || baseFeeStroops} stroops`);
    console.log(`  P95 Accepted Fee:  ${feeStats.p95_accepted_fee || baseFeeStroops} stroops`);

    console.log(chalk.bold.cyan(`\n📊 Fee Estimation Breakdown (${operationCount} operation(s)):`));
    console.log(
      `  Minimum Fee:       ${multiOpEst.minimumFeeStroops} stroops (${multiOpEst.minimumFeeXlm} XLM)`,
    );
    console.log(
      `  Fee-Bump Estimate: ${multiOpEst.feeBumpEstimatedStroops} stroops (${multiOpEst.feeBumpEstimatedXlm} XLM)`,
    );

    console.log(chalk.bold.yellow('\n💡 Fee Comparison Across Sizes:'));
    [1, 2, 5, 10].forEach((count) => {
      const est = calculateTransactionFees(baseFeeStroops, count);
      console.log(
        `  - ${count} operation(s): ${est.minimumFeeStroops} stroops (${est.minimumFeeXlm} XLM)`,
      );
    });
  } catch (error: any) {
    const errPayload = {
      error: `Failed to retrieve fee statistics from Horizon: ${error.message}`,
    };
    if (isJson) {
      console.log(JSON.stringify(errPayload, null, 2));
      return;
    }
    console.error(chalk.red(`\n❌ ${errPayload.error}`));
    console.log(chalk.yellow('⚠️ Falling back to default network base fee (100 stroops).'));

    const fallbackEst = calculateTransactionFees(100, operationCount);
    console.log(
      `  Fallback Estimate (${operationCount} ops): ${fallbackEst.minimumFeeStroops} stroops (${fallbackEst.minimumFeeXlm} XLM)`,
    );
  }
}
