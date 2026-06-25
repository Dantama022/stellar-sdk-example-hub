import { EventEmitter } from 'events';

import { executeExamples, SpawnProcess } from '../src/validation/executor';
import { DiscoveredExample, ValidationConfig } from '../src/validation/types';

interface FakeChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => boolean;
}

describe('Example executor', () => {
  const baseConfig: ValidationConfig = {
    examplesDir: '/tmp/examples',
    exampleFilePattern: '^\\d{2}-.+\\.ts$',
    timeoutMs: 50,
    exclusions: [],
  };

  const examples: DiscoveredExample[] = [
    {
      name: '01-create-account',
      filePath: '/tmp/examples/01-create-account.ts',
      relativePath: 'src/examples/01-create-account.ts',
    },
  ];

  it('marks excluded examples as skipped without spawning', async () => {
    const spawnProcess: SpawnProcess = jest.fn(() => {
      throw new Error('spawn should not be called');
    });

    const results = await executeExamples(examples, {
      config: {
        ...baseConfig,
        exclusions: [{ match: '01-create-account', reason: 'Requires network' }],
      },
      spawnProcess,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('skipped');
    expect(results[0].skipReason).toBe('Requires network');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('captures process output and marks passed executions', async () => {
    const spawnProcess = createSpawnProcess({
      stdout: 'hello from example\n',
      stderr: '',
      exitCode: 0,
    });

    const results = await executeExamples(examples, {
      config: baseConfig,
      spawnProcess,
    });

    expect(results[0].status).toBe('passed');
    expect(results[0].stdout).toContain('hello from example');
    expect(results[0].stderr).toBe('');
  });

  it('continues execution after a failing example', async () => {
    const multiExamples: DiscoveredExample[] = [
      examples[0],
      {
        name: '02-payment',
        filePath: '/tmp/examples/02-payment.ts',
        relativePath: 'src/examples/02-payment.ts',
      },
    ];

    const spawnProcess = jest
      .fn<ReturnType<SpawnProcess>, Parameters<SpawnProcess>>()
      .mockImplementationOnce(() => createFakeChild({ stderr: 'boom', exitCode: 1 }))
      .mockImplementationOnce(() => createFakeChild({ stdout: 'ok', exitCode: 0 }));

    const results = await executeExamples(multiExamples, {
      config: baseConfig,
      spawnProcess,
    });

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('passed');
  });

  it('marks timed out execution as failed', async () => {
    const spawnProcess: SpawnProcess = jest.fn(() => createFakeTimeoutChild());

    const results = await executeExamples(examples, {
      config: { ...baseConfig, timeoutMs: 10 },
      spawnProcess,
    });

    expect(results[0].status).toBe('failed');
    expect(results[0].errorMessage).toBe('Execution timed out');
  });
});

function createSpawnProcess(result: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}): SpawnProcess {
  return jest.fn(() => createFakeChild(result));
}

function createFakeChild(result: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn(() => true);

  process.nextTick(() => {
    if (result.stdout) {
      child.stdout.emit('data', Buffer.from(result.stdout));
    }
    if (result.stderr) {
      child.stderr.emit('data', Buffer.from(result.stderr));
    }
    child.emit('close', result.exitCode, null);
  });

  return child;
}

function createFakeTimeoutChild(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn(() => {
    child.emit('close', null, 'SIGTERM');
    return true;
  });

  return child;
}
