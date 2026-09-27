import chalk from 'chalk';

import { WasmElementSegmentInfo, analyzeElements, compareElementReports } from '../utils/wasm-static-analysis';

function printReport(report: ReturnType<typeof analyzeElements>): void {
  console.log(chalk.bold('\n=== WASM Element Section Analysis ==='));
  console.log(`${chalk.bold('File:')} ${report.file}`);
  console.log(`${chalk.bold('Element Segments:')} ${report.statistics.totalSegmentCount}`);
  console.log(
    `${chalk.bold('Active:')} ${report.statistics.activeSegmentCount}  ${chalk.bold('Passive:')} ${report.statistics.passiveSegmentCount}  ${chalk.bold('Declarative:')} ${report.statistics.declarativeSegmentCount}`,
  );
  console.log(`${chalk.bold('Total Elements:')} ${report.statistics.totalElementCount}`);
  console.log(`${chalk.bold('Average Segment Size:')} ${report.statistics.averageSegmentSize.toFixed(2)}`);
  if (report.statistics.largestSegment) {
    console.log(
      `${chalk.bold('Largest Segment:')} [${report.statistics.largestSegment.index}] ${report.statistics.largestSegment.elementCount} elements`,
    );
  }
  console.log(`${chalk.bold('Segments by Element Type:')}`);
  Object.entries(report.statistics.segmentsByElementType).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });

  report.segments.forEach((segment) => {
    printSegment(segment);
  });
}

function printSegment(segment: WasmElementSegmentInfo): void {
  const modeColor = segment.mode === 'active' ? chalk.green : segment.mode === 'passive' ? chalk.yellow : chalk.blue;
  console.log(
    `  [${segment.index}] ${modeColor(segment.mode.toUpperCase())} type=${segment.elementType} count=${segment.elementCount}`,
  );
  if (segment.tableIndex !== null) {
    console.log(`    table=${segment.tableIndex} offset=${segment.offsetExpression}`);
  }
  console.log(`    elements: [${segment.elements.slice(0, 10).join(', ')}${segment.elements.length > 10 ? ', ...' : ''}]`);
  console.log(`    contentHash: ${segment.elementContentHash}`);
}

export async function run(
  params: { wasmFile?: string; compareFile?: string; json?: boolean } = {},
): Promise<void> {
  if (!params.wasmFile)
    throw new Error('Usage: stellar-api-inspector wasm-elements <wasmFile> [compareFile] [--json]');
  const json = params.json === true || process.env.JSON_OUTPUT === 'true';
  const output = params.compareFile
    ? compareElementReports(params.wasmFile, params.compareFile)
    : analyzeElements(params.wasmFile);
  if (json) console.log(JSON.stringify(output, null, 2));
  else if ('comparison' in output) {
    printReport(output.before);
    printReport(output.after);
    console.log(chalk.bold('\n--- Comparison ---'));
    console.log(
      `Added/removed/changed/unchanged: ${output.comparison.added.length}/${output.comparison.removed.length}/${output.comparison.changed.length}/${output.comparison.unchanged.length}`,
    );
    output.comparison.added.forEach((segment) => {
      console.log(chalk.green(`  + [${segment.index}] ${segment.mode} ${segment.elementType} count=${segment.elementCount} hash=${segment.elementContentHash}`));
    });
    output.comparison.removed.forEach((segment) => {
      console.log(chalk.red(`  - [${segment.index}] ${segment.mode} ${segment.elementType} count=${segment.elementCount} hash=${segment.elementContentHash}`));
    });
    output.comparison.changed.forEach(({ before, after, changes }) => {
      console.log(chalk.yellow(`  ~ [${before.index}] ${before.mode} ${before.elementType} -> ${after.mode} ${after.elementType} (${changes.join(', ')})`));
    });
  } else printReport(output);
}