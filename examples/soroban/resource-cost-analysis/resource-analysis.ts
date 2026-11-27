/**
 * Step 4: compare simulated resource requirements with network limits.
 *
 * Limits are read from the network's own ConfigSetting ledger entries (via getLedgerEntries), not
 * embedded here, because validators can change them by vote. If they cannot be read, usage is
 * still shown but flagged as "unknown", never silently treated as fine.
 *
 * Terminology: the simulation's resources are what the RPC proposes the transaction DECLARES
 * (they become the transaction's own resource limits). They are not a separate, exact CPU meter
 * reading, and the response does not distinguish the two. Network limits are the per-transaction
 * caps those declarations must stay under.
 */
import { xdr } from '@stellar/stellar-sdk';
import { CostRpcClient, rpcCall } from './rpc';
import { NetworkLimits, ResourceAnalysis, ResourceLine, SimulatedResources } from './types';

const big = (v: { toString(): string } | number): bigint => BigInt(v.toString());

export function configSettingKeys(): xdr.LedgerKey[] {
  return [
    xdr.ConfigSettingId.configSettingContractComputeV0(),
    xdr.ConfigSettingId.configSettingContractLedgerCostV0(),
    xdr.ConfigSettingId.configSettingContractBandwidthV0(),
  ].map((id) => xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: id })));
}

/** Pure: read the limits we know about out of ledger entries. Unknown or absent entries are skipped. */
export function parseNetworkLimits(entries: { val: xdr.LedgerEntryData }[], ledgerSeq?: number): NetworkLimits {
  const limits: NetworkLimits = { ledgerSeq };
  for (const entry of entries) {
    let setting: xdr.ConfigSettingEntry;
    try {
      setting = entry.val.configSetting();
    } catch {
      continue; // not a config setting entry
    }
    switch (setting.switch().name) {
      case 'configSettingContractComputeV0':
        limits.txMaxInstructions = big(setting.contractCompute().txMaxInstructions());
        break;
      case 'configSettingContractLedgerCostV0': {
        const c = setting.contractLedgerCost();
        limits.txMaxReadBytes = big(c.txMaxReadBytes());
        limits.txMaxWriteBytes = big(c.txMaxWriteBytes());
        limits.txMaxReadLedgerEntries = big(c.txMaxReadLedgerEntries());
        limits.txMaxWriteLedgerEntries = big(c.txMaxWriteLedgerEntries());
        break;
      }
      case 'configSettingContractBandwidthV0':
        limits.txMaxSizeBytes = big(setting.contractBandwidth().txMaxSizeBytes());
        break;
    }
  }
  return limits;
}

/** Fetch limits over RPC. Throws RPC_UNAVAILABLE on transport failure. */
export async function fetchNetworkLimits(client: CostRpcClient): Promise<NetworkLimits> {
  const res = await rpcCall('getLedgerEntries(configSetting)', () => client.getLedgerEntries(configSettingKeys()));
  return parseNetworkLimits(res.entries ?? [], res.latestLedger);
}

function line(name: string, used: bigint, limit: bigint | undefined, warnRatio: number): ResourceLine {
  if (limit === undefined || limit <= 0n) return { name, used, status: 'unknown' };
  // Basis points in bigint, so very large values keep their precision.
  const percent = Number((used * 10000n) / limit) / 100;
  const warnBp = BigInt(Math.round(warnRatio * 10000));
  const status = used > limit ? 'exceeded' : used * 10000n >= limit * warnBp ? 'warning' : 'ok';
  return { name, used, limit, percent, status };
}

export function analyzeResources(resources: SimulatedResources, limits: NetworkLimits | undefined, warnRatio: number): ResourceAnalysis {
  const lines = [
    line('CPU instructions', resources.instructions, limits?.txMaxInstructions, warnRatio),
    line('Read bytes', resources.readBytes, limits?.txMaxReadBytes, warnRatio),
    line('Write bytes', resources.writeBytes, limits?.txMaxWriteBytes, warnRatio),
    line('Ledger entries read', BigInt(resources.readEntries), limits?.txMaxReadLedgerEntries, warnRatio),
    line('Ledger entries written', BigInt(resources.writeEntries), limits?.txMaxWriteLedgerEntries, warnRatio),
  ];

  const warnings: string[] = [];
  for (const l of lines) {
    if (l.status === 'exceeded') {
      warnings.push(`${l.name}: ${l.used} exceeds the network per-transaction limit of ${l.limit}. The network would reject this transaction.`);
    } else if (l.status === 'warning') {
      warnings.push(`${l.name}: ${l.used} is ${l.percent}% of the per-transaction limit (${l.limit}). Little headroom if ledger state changes before inclusion.`);
    }
  }
  const limitsAvailable = lines.some((l) => l.limit !== undefined);
  if (!limitsAvailable) {
    warnings.push('Network limits could not be read, so resource usage was not compared with them.');
  } else if (lines.some((l) => l.status === 'unknown')) {
    warnings.push(`No network limit available for: ${lines.filter((l) => l.status === 'unknown').map((l) => l.name).join(', ')}.`);
  }
  return { lines, warnings, limitsAvailable };
}
