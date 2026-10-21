import { diagnoseSep30, validateRecoveryConfig, RecoveryConfig } from '../src/examples/342-sep30-service-diagnostics';
const config: RecoveryConfig = {baseUrl:'https://recovery.example.test', timeoutMs:100, providerProbePath:'/health'};
const fake = (obj: unknown, status=200) => jest.fn().mockResolvedValue({ok:status===200,status,json:async()=>obj}) as unknown as typeof fetch;

test('validates URL, timeout and optional local HTTP', () => {
  expect(()=>validateRecoveryConfig({...config,baseUrl:''})).toThrow();
  expect(()=>validateRecoveryConfig({...config,baseUrl:'http://example.org'})).toThrow();
  expect(()=>validateRecoveryConfig({...config,baseUrl:'http://localhost:3000',allowLocalHttp:true})).not.toThrow();
  expect(()=>validateRecoveryConfig({...config,providerProbePath:'//foreign.test'})).toThrow();
});
test('no standard SEP-30 health endpoint; no implicit request or compatibility claim', async () => {
  const fetcher = jest.fn() as unknown as typeof fetch;
  const result = await diagnoseSep30({...config,providerProbePath:undefined},fetcher);
  expect(result.category).toBe('unsupported');
  expect(result.sep30Compatible).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
test('provider-specific success is not proof of SEP30 compatibility or recovery', async () => {
  const result = await diagnoseSep30(config,fake({ok:true}),()=>25);
  expect(result).toMatchObject({reachable:true,providerHealth:true,sep30Compatible:null,recoveryCompleted:false,category:'ok'});
});
test('connection failure, timeout and HTTP errors return safe categories', async () => {
  const network = jest.fn().mockRejectedValue(new Error('private-token=abc')) as unknown as typeof fetch;
  expect((await diagnoseSep30(config,network)).category).toBe('network');
  const timeout = jest.fn().mockImplementation((_: string, opts: RequestInit) => new Promise((_,reject) => {
    opts.signal?.addEventListener('abort',()=>reject(new Error('aborted')));
  })) as unknown as typeof fetch;
  expect((await diagnoseSep30({...config,timeoutMs:1},timeout)).category).toBe('timeout');
  expect((await diagnoseSep30(config,fake({},503))).category).toBe('http_error');
});
test('malformed provider JSON and incompatible response are not healthy', async () => {
  const invalid = jest.fn().mockResolvedValue({ok:true,status:200,json:async()=>{throw new Error('bad');}}) as unknown as typeof fetch;
  expect((await diagnoseSep30(config,invalid)).category).toBe('invalid_json');
  expect((await diagnoseSep30(config,fake({status:'running'}))).category).toBe('invalid_response');
  const text = JSON.stringify(await diagnoseSep30(config,fake({ok:false})));
  expect(text).not.toContain('private-token');
});
