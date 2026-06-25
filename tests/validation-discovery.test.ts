import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { discoverExamples } from '../src/validation/discovery';
import { ValidationConfig } from '../src/validation/types';

describe('Example discovery', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'example-discovery-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('discovers matching examples recursively and sorts them by name', async () => {
    const examplesDir = path.join(tempDir, 'src', 'examples');
    await fs.mkdir(path.join(examplesDir, 'nested'), { recursive: true });

    await fs.writeFile(path.join(examplesDir, '02-payment.ts'), 'export async function run() {}');
    await fs.writeFile(
      path.join(examplesDir, '01-create-account.ts'),
      'export async function run() {}',
    );
    await fs.writeFile(path.join(examplesDir, 'README.md'), '# not executable');
    await fs.writeFile(
      path.join(examplesDir, 'nested', '03-create-trustline.ts'),
      'export async function run() {}',
    );

    const config: ValidationConfig = {
      examplesDir,
      exampleFilePattern: '^\\d{2}-.+\\.ts$',
      timeoutMs: 1000,
      exclusions: [],
    };

    const discovered = await discoverExamples(config);

    expect(discovered.map((example) => example.name)).toEqual([
      '01-create-account',
      '02-payment',
      '03-create-trustline',
    ]);
  });
});
