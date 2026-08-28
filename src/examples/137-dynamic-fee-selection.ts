import { Horizon } from '@stellar/stellar-sdk';

export async function run(params?: any): Promise<void> {
  const server = new Horizon.Server(process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org');
  
  const strategy = params?.strategy || 'median'; // 'min', 'median', 'high', 'custom'
  const customMultiplier = parseFloat(params?.multiplier || '1.2');
  const maxFee = parseInt(params?.maxFee || '10000');
  const opCount = parseInt(params?.opCount || '1');

  try {
    const feeStats = await server.feeStats();
    
    // Using cast to 'any' to bypass strict TS checking for the underlying JSON properties
    const baseFee = parseInt((feeStats as any).last_ledger_base_fee || '100');
    const p50 = parseInt((feeStats as any).p50_accepted_fee || '100');
    const p90 = parseInt((feeStats as any).p90_accepted_fee || '100');

    let selectedPerOpFee = baseFee;

    switch (strategy) {
      case 'min':
        selectedPerOpFee = baseFee;
        break;
      case 'median':
        selectedPerOpFee = p50;
        break;
      case 'high':
        selectedPerOpFee = p90;
        break;
      case 'custom':
        selectedPerOpFee = Math.ceil(p50 * customMultiplier);
        break;
    }

    let finalFee = selectedPerOpFee * opCount;

    if (finalFee > maxFee) {
      finalFee = maxFee;
    }

    const output = {
      statistics: {
        baseFee,
        p50,
        p90
      },
      configuration: {
        strategy,
        opCount,
        maxFeeLimit: maxFee
      },
      calculation: {
        selectedPerOpFee,
        finalFee
      }
    };

    console.log(params?.json ? JSON.stringify(output, null, 2) : output);

  } catch (error: any) {
    console.error('Error fetching fee statistics:', error.message);
  }
}