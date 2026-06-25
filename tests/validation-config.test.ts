import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { isExampleExcluded, loadValidationConfig } from '../src/validation/config';

describe('Validation config', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validation-config-'));
    await fs.mkdir(path.join(tempDir, 'config'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('loads config and resolves relative examples directory from root', async () => {
    const configPath = path.join(tempDir, 'config', 'validation.json');
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          examplesDir: 'src/examples',
          exampleFilePattern: '^\\d{2}-.+\\.ts$',
          timeoutMs: 3000,
          exclusions: [{ match: '18-*', reason: 'Needs soroban RPC' }],
        },
        null,
        2,
      ),
    );

    const loaded = await loadValidationConfig(tempDir, path.join('config', 'validation.json'));

    expect(loaded.examplesDir).toBe(path.join(tempDir, 'src', 'examples'));
    expect(loaded.timeoutMs).toBe(3000);
    expect(loaded.exclusions).toHaveLength(1);
  });

  it('supports wildcard exclusion matching', () => {
    const exclusions = [{ match: '1*-*', reason: 'Network only' }];
    const matched = isExampleExcluded('17-offline-signing', exclusions);
    const notMatched = isExampleExcluded('02-payment', exclusions);

    expect(matched?.reason).toBe('Network only');
    expect(notMatched).toBeUndefined();
  });
});
