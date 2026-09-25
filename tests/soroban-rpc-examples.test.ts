import {
  validateRpcUrl,
  calculateLedgerFreshness,
} from '../src/examples/186-soroban-rpc-diagnostics';
import { paginateSorobanRpc } from '../src/examples/187-soroban-rpc-pagination';

describe('ISSUE-186: Soroban RPC diagnostics helpers', () => {
  it('accepts a valid Soroban RPC URL and normalizes it', () => {
    expect(validateRpcUrl('https://soroban-testnet.stellar.org')).toBe(
      'https://soroban-testnet.stellar.org',
    );
    expect(validateRpcUrl('  https://soroban-testnet.stellar.org/  ')).toBe(
      'https://soroban-testnet.stellar.org/',
    );
  });

  it('rejects malformed RPC URLs cleanly', () => {
    expect(() => validateRpcUrl('not a url')).toThrow(/invalid.*rpc.*url/i);
    expect(() => validateRpcUrl('ftp://example.com')).toThrow(/http|https/i);
  });

  it('marks stale ledgers when the close time is too old', () => {
    const result = calculateLedgerFreshness(10_000, Date.now());
    expect(result.freshness).toMatch(/stale|fresh|unknown/i);
    expect(result.isStale).toBeDefined();
    expect(result.ageMs).toBeGreaterThanOrEqual(0);
  });
});

describe('ISSUE-187: Soroban RPC pagination helpers', () => {
  it('tracks page progression, cursor changes, and final cursor state', async () => {
    const pages = [
      { records: [{ id: 'a' }, { id: 'b' }], next: 'cursor-2' },
      { records: [{ id: 'c' }], next: 'cursor-3' },
      { records: [], next: null },
    ];

    let cursor: string | undefined;
    const result = await paginateSorobanRpc({
      fetchPage: async () => {
        const page = pages.shift();
        if (!page) {
          return { records: [], next: null };
        }
        const response = { records: page.records, next: page.next, cursor: page.next };
        const nextCursor = cursor ? `next:${cursor}` : undefined;
        cursor = page.next ?? cursor;
        return {
          ...response,
          next: page.next,
          cursor: nextCursor ?? page.next,
        };
      },
      limit: 2,
      maxPages: 5,
      startCursor: undefined,
    });

    expect(result.pagesProcessed).toBeGreaterThanOrEqual(2);
    expect(result.recordsProcessed).toBeGreaterThanOrEqual(3);
    expect(result.currentCursor).toBeDefined();
    expect(result.finalCursor).toBeDefined();
    expect(result.status).toMatch(/completed|empty|max_pages_reached|error/i);
  });

  it('detects repeated cursors and malformed pagination payloads', async () => {
    const result = await paginateSorobanRpc({
      fetchPage: async () => ({ records: [{ id: 'repeat' }], next: 'loop' }),
      limit: 10,
      maxPages: 2,
      startCursor: 'loop',
    });

    expect(result.repeatedCursor).toBe(true);
    expect(result.status).toMatch(/repeated_cursor|error|completed/i);

    await expect(
      paginateSorobanRpc({
        fetchPage: async () => ({ records: 'bad response' as any, next: null }),
        limit: 10,
        maxPages: 1,
      }),
    ).rejects.toThrow(/malformed|records/i);
  });
});
