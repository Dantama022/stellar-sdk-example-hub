import { Horizon } from '@stellar/stellar-sdk';

export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Horizon Pagination and Record Traversal Example...');

  const MAX_RECORDS = 15; // Configurable maximum record count
  const PAGE_LIMIT = 5; // Records per page request

  let totalProcessed = 0;
  let pageCount = 0;

  console.log(`Goal: Traverse up to ${MAX_RECORDS} transactions, fetching ${PAGE_LIMIT} per page.`);

  // 1. Fetch the first page of records
  console.log('\nFetching Page 1...');
  let page = await server.transactions().limit(PAGE_LIMIT).order('desc').call();

  // 2. Process records across multiple pages using pagination links
  while (page.records.length > 0 && totalProcessed < MAX_RECORDS) {
    pageCount++;
    console.log(`\n--- Processing Page ${pageCount} ---`);

    for (const record of page.records) {
      if (totalProcessed >= MAX_RECORDS) {
        console.log(
          `\nReached configured maximum limit of ${MAX_RECORDS} records. Stopping traversal.`,
        );
        break;
      }

      console.log(`[Record ${totalProcessed + 1}] Transaction Hash: ${record.hash}`);
      totalProcessed++;
    }

    if (totalProcessed >= MAX_RECORDS) {
      break;
    }

    // 3. Demonstrate following the next page via the embedded 'next' helper
    console.log(`Following next pagination link...`);
    page = await page.next();
  }

  // 4. Display Statistics
  console.log('\n--- Traversal Complete ---');
  console.log(`Total Pages Requested: ${pageCount}`);
  console.log(`Total Records Processed: ${totalProcessed}`);
}
