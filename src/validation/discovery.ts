import fs from 'fs/promises';
import path from 'path';

import { DiscoveredExample, ValidationConfig } from './types';

export async function discoverExamples(config: ValidationConfig): Promise<DiscoveredExample[]> {
  const files = await collectFiles(config.examplesDir);
  const filePattern = new RegExp(config.exampleFilePattern);

  return files
    .filter((filePath) => filePattern.test(path.basename(filePath)))
    .map((filePath) => {
      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
      return {
        name: path.basename(filePath, '.ts'),
        filePath,
        relativePath,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(entryPath);
      }
      return entry.isFile() ? [entryPath] : [];
    }),
  );

  return nested.flat();
}
