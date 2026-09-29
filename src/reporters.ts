import { AnalysisResult } from './analyzer';

export function outputJson(result: AnalysisResult, diff?: boolean): void {
  console.log(JSON.stringify(result, null, 2));
}

export function outputCsv(result: AnalysisResult, diff?: boolean): void {
  const headers = [
    'Function Index',
    'Function Name',
    'Block Index',
    'Reachable',
    'Reason',
    'Start Instruction',
    'End Instruction'
  ];

  const rows: string[] = [headers.join(',')];

  result.functions.forEach(func => {
    func.unreachableRegions.forEach(region => {
      rows.push([
        func.index,
        func.name,
        region.start,
        'false',
        region.reason,
        region.start,
        region.end
      ].join(','));
    });

    func.blocks.forEach(block => {
      if (!block.reachable) {
        rows.push([
          func.index,
          func.name,
          block.index,
          'false',
          block.reason || 'unknown',
          0,
          block.instructions.length - 1
        ].join(','));
      }
    });
  });

  console.log(rows.join('\n'));
}