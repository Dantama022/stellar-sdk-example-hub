import fs from 'fs';
import path from 'path';

import { examples } from '../src/runner/catalog';

interface ExpectedExample {
  name: string;
  descriptionText: string;
  parameterNames: string[];
}

const expectedExamples: ExpectedExample[] = [
  {
    name: '62-payment-history',
    descriptionText: 'payment',
    parameterNames: ['accountId', 'limit'],
  },
  {
    name: '63-asset-discovery',
    descriptionText: 'asset',
    parameterNames: ['assetCode', 'limit'],
  },
  {
    name: '64-liquidity-pool-inspection',
    descriptionText: 'liquidity',
    parameterNames: ['poolId', 'limit'],
  },
  {
    name: '65-offer-book-inspection',
    descriptionText: 'offer',
    parameterNames: ['sellingAsset', 'buyingAsset', 'limit'],
  },
];

describe('Horizon inspection example registration', () => {
  test.each(expectedExamples)(
    'registers $name in the interactive runner',
    ({ name, descriptionText, parameterNames }) => {
      const example = examples[name];

      expect(example).toBeDefined();
      expect(example.name).toBe(name);
      expect(example.description.toLowerCase()).toContain(descriptionText);
      expect(typeof example.run).toBe('function');

      expect(example.params?.map((parameter) => parameter.name)).toEqual(parameterNames);
    },
  );

  test.each(expectedExamples)(
    'documents $name in the README catalog and run instructions',
    ({ name }) => {
      const readmePath = path.join(process.cwd(), 'README.md');

      const readme = fs.readFileSync(readmePath, 'utf8');

      expect(readme).toContain(`**\`${name}\`**`);
      expect(readme).toContain(`npm run run-example ${name}`);
    },
  );

  it('documents the required Horizon inspection concepts', () => {
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

    expect(readme).toContain('payment records rather than generic operations');

    expect(readme).toContain('identified by both code and issuer');

    expect(readme).toContain('Liquidity pool IDs are deterministic identifiers');

    expect(readme).toContain('offers are open seller-owned intentions');
  });
});
