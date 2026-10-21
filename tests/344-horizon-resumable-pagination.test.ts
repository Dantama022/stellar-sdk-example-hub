import { initialUrl, parseCheckpoint, scanHorizon, fetchPageWithRetry, Checkpoint, CheckpointStore } from '../src/examples/344-horizon-resumable-pagination';
const endpoint = 'https://horizon-testnet.stellar.org/operations';
class MemoryStore implements CheckpointStore {
  saved?: Checkpoint;
  async load(): Promise<unknown> { return this.saved; }
  async save(value: Checkpoint): Promise<void> { this.saved = value; }
}
const record = (n: number) => ({paging_token: String(n), id: `operation-${n}`});
const page = (numbers: number[], next?: number) => ({
  _embedded: {records: numbers.map(record)},
  _links: {next: next === undefined ? undefined : {href: `${endpoint}?order=asc&limit=2&cursor=${next}`}},
});
const response = (value: unknown, status = 200) => ({ok: status === 200, status, json: async () => value});
const mocked = (...values: unknown[]): typeof fetch => jest.fn().mockImplementation(() => Promise.resolve(response(values.shift()))) as unknown as typeof fetch;

test('multiple pages, incremental processing and checkpoint resume', async () => {
  const store = new MemoryStore();
  const seen: string[] = [];
  const fetcher = mocked(page([1,2],2), page([3],3), page([]));
  expect(await scanHorizon({endpoint, store, fetcher, pageSize: 2, onRecord: async r => {seen.push(r.id as string);}})).toBe(3);
  expect(seen).toEqual(['operation-1','operation-2','operation-3']);
  expect(store.saved?.cursor).toBe('3');
  expect(await scanHorizon({endpoint, store, fetcher: mocked(page([4])), pageSize:2, onRecord: async r => {seen.push(r.id as string);}})).toBe(1);
  expect(seen).toContain('operation-4');
});
test('processing failure commits only successfully processed cursor; recovery may replay if effect succeeded but checkpoint failed', async () => {
  const store = new MemoryStore();
  await expect(scanHorizon({endpoint, store, fetcher: mocked(page([1,2])), pageSize:2,
    onRecord: async r => {if (r.paging_token === '2') throw new Error('interrupted');}})).rejects.toThrow('interrupted');
  expect(store.saved?.cursor).toBe('1');
  expect(await scanHorizon({endpoint, store, fetcher: mocked(page([2])), pageSize:2,
    onRecord: async () => {}})).toBe(1);
});
test('empty page, invalid checkpoint and cursor validation', async () => {
  const store = new MemoryStore();
  expect(await scanHorizon({endpoint, store, fetcher: mocked(page([])), onRecord: async () => {}})).toBe(0);
  expect(() => parseCheckpoint({version:2,endpoint,order:'asc',cursor:'a'},endpoint)).toThrow();
  expect(() => initialUrl('http://example.com/operations')).toThrow();
  await expect(scanHorizon({endpoint, store, fetcher: mocked(page([2,1])), onRecord: async () => {}})).rejects.toThrow('Non-increasing');
});
test('retry only 429/5xx/network with bounded calls; reject 400, malformed JSON and unsafe continuation', async () => {
  const url = initialUrl(endpoint,2);
  const sleep = jest.fn(async () => {});
  const retry = jest.fn().mockResolvedValueOnce(response({},429)).mockResolvedValueOnce(response(page([1])));
  expect((await fetchPageWithRetry(url,retry as typeof fetch,sleep,1))._embedded.records).toHaveLength(1);
  expect(retry).toHaveBeenCalledTimes(2);
  const bad = jest.fn().mockResolvedValue(response({},400));
  await expect(fetchPageWithRetry(url,bad as typeof fetch,sleep,2)).rejects.toThrow('Horizon HTTP 400');
  expect(bad).toHaveBeenCalledTimes(1);
  await expect(fetchPageWithRetry(url,mocked({oops:true}),sleep,0)).rejects.toThrow('Invalid Horizon');
  const store = new MemoryStore();
  const unsafe = {_embedded:{records:[record(1)]},_links:{next:{href:'https://attacker.example/operations?cursor=1&order=asc'}}};
  await expect(scanHorizon({endpoint,store,fetcher:mocked(unsafe),onRecord:async()=>{}})).rejects.toThrow('Unsafe');
});
test('processes a large stream with bounded page size', async () => {
  const store = new MemoryStore();
  let processed = 0;
  const f = jest.fn().mockImplementation(async (url: string) => {
    const cursor = Number(new URL(url).searchParams.get('cursor') || 0);
    const ids = [cursor+1, cursor+2];
    return response(page(ids, cursor+2));
  });
  await scanHorizon({endpoint,store,fetcher:f as typeof fetch,pageSize:2,maxRecords:1000,
    onRecord:async()=>{processed++;}});
  expect(processed).toBe(1000);
  expect(store.saved?.cursor).toBe('1000');
});
