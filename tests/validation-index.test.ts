import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

import { runExampleValidation } from '../src/validation';
import { SpawnProcess } from '../src/validation/executor';

describe('Validation pipeline', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validation-index-'));
    await fs.mkdir(path.join(tempDir, 'src', 'examples'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'config'), { recursive: true });

    await fs.writeFile(
      path.join(tempDir, 'src', 'examples', '01-good.ts'),
      'export async function run() {}',
    );
    await fs.writeFile(
      path.join(tempDir, 'src', 'examples', '02-skip.ts'),
      'export async function run() {}',
    );

    await fs.writeFile(
      path.join(tempDir, 'config', 'validation.json'),
      JSON.stringify(
        {
          examplesDir: 'src/examples',
          exampleFilePattern: '^\\d{2}-.+\\.ts$',
          timeoutMs: 1000,
          exclusions: [{ match: '02-skip', reason: 'skip in CI' }],
        },
        null,
        2,
      ),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns summary, detailed results, and report text', async () => {
    const spawnProcess: SpawnProcess = jest.fn(() => {
      const emitter = new EventEmitter();
      const child = emitter as unknown as ReturnType<SpawnProcess>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn(() => true);
      process.nextTick(() => {
        emitter.emit('close', 0, null);
      });
      return child;
    });

    const output = await runExampleValidation({
      rootDir: tempDir,
      configPath: path.join('config', 'validation.json'),
      spawnProcess,
    });

    expect(output.summary.discovered).toBe(2);
    expect(output.summary.executed).toBe(1);
    expect(output.summary.skipped).toBe(1);
    expect(output.report).toContain('Validation Passed');
  });
});
