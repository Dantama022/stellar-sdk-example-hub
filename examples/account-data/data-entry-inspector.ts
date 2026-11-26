/** #576: inspect existing ManageData entries on Horizon. */
import { Fetcher, Network, account, validAccount } from '../_shared/horizon-readonly';
import { DataProposal, inspectDataProposal } from './data-entry-validator';

export async function validateAccountData(
  proposal: DataProposal, network: Network, baseReserveStroops?: string | bigint,
  fetcher: Fetcher = fetch,
) {
  validAccount(proposal.accountId);
  const acc = await account(proposal.accountId, network, fetcher);
  return { network, ...inspectDataProposal(proposal, acc, baseReserveStroops) };
}
if (require.main === module) {
  const [accountId, key, value, network = 'testnet'] = process.argv.slice(2);
  validateAccountData({ accountId: accountId ?? '', key: key ?? '', value }, network as Network, '5000000')
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}
