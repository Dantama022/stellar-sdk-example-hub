import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ASSET_CODE = 'USDC';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const assetCode = process.env.ASSET_CODE || DEFAULT_ASSET_CODE;
  const server = new Horizon.Server(horizonUrl);
  const page = await server.assets().forCode(assetCode).limit(5).call();

  const records = page.records as Array<{
    asset_code?: string;
    asset_issuer?: string;
    accounts?: {
      authorized?: number;
      authorized_to_maintain_liabilities?: number;
      unauthorized?: number;
    };
    flags?: {
      auth_required?: boolean;
      auth_revocable?: boolean;
      auth_immutable?: boolean;
      auth_clawback_enabled?: boolean;
    };
  }>;

  console.log('=== Stellar Asset Issuer Authorization Inspection Example ===');
  console.log(`Asset Code: ${assetCode}`);
  console.log(`Matching Assets: ${records.length}`);
  records.forEach((record, index) => {
    console.log(`${index + 1}. ${record.asset_code ?? 'unknown'}:${record.asset_issuer ?? 'unknown'}`);
    console.log(`   auth_required=${record.flags?.auth_required ?? false}`);
    console.log(`   auth_revocable=${record.flags?.auth_revocable ?? false}`);
    console.log(`   auth_immutable=${record.flags?.auth_immutable ?? false}`);
    console.log(`   unauthorized_accounts=${record.accounts?.unauthorized ?? 0}`);
  });
}
