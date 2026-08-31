import {
  parseContractSpec,
  ParsedContractSpec,
  SpecFunction,
  SpecStruct,
  SpecEnum,
} from './193-soroban-contract-interface';

export type CompatibilityLevel = 'compatible' | 'potentially-breaking' | 'breaking';

export interface CompatibilityChange {
  category: 'function' | 'parameter' | 'return-type' | 'struct' | 'enum' | 'type';
  action: 'added' | 'removed' | 'modified';
  target: string;
  details: string;
  level: CompatibilityLevel;
}

export interface CompatibilityReport {
  isCompatible: boolean;
  totalChanges: number;
  breakingChangesCount: number;
  potentiallyBreakingChangesCount: number;
  compatibleChangesCount: number;
  changes: CompatibilityChange[];
}

export interface CompatibilityCheckerParams {
  previousSpec?: any[];
  newSpec?: any[];
  strictMode?: boolean;
  jsonOutput?: boolean;
}

/**
 * Classifies a specific interface change based on compatibility rules.
 */
export function classifyChange(
  category: string,
  action: 'added' | 'removed' | 'modified',
  strictMode = false,
): CompatibilityLevel {
  if (action === 'removed') {
    return 'breaking';
  }

  if (action === 'modified') {
    if (category === 'parameter' || category === 'return-type') {
      return 'breaking';
    }
    return strictMode ? 'potentially-breaking' : 'compatible';
  }

  if (action === 'added') {
    if (category === 'parameter') {
      return strictMode ? 'breaking' : 'potentially-breaking';
    }
    return 'compatible';
  }

  return 'compatible';
}

/**
 * Compares functions exported by two specifications.
 */
export function compareFunctions(
  prevFuncs: SpecFunction[],
  newFuncs: SpecFunction[],
  strictMode = false,
): CompatibilityChange[] {
  const changes: CompatibilityChange[] = [];
  const prevMap = new Map(prevFuncs.map((f) => [f.name, f]));
  const newMap = new Map(newFuncs.map((f) => [f.name, f]));

  // Check removed functions
  prevMap.forEach((prevFn, name) => {
    if (!newMap.has(name)) {
      changes.push({
        category: 'function',
        action: 'removed',
        target: `function ${name}`,
        details: `Exported function '${name}' was removed from the contract interface.`,
        level: classifyChange('function', 'removed', strictMode),
      });
    }
  });

  // Check added or modified functions
  newMap.forEach((newFn, name) => {
    const prevFn = prevMap.get(name);
    if (!prevFn) {
      changes.push({
        category: 'function',
        action: 'added',
        target: `function ${name}`,
        details: `New function '${name}' was added.`,
        level: classifyChange('function', 'added', strictMode),
      });
      return;
    }

    // Compare parameters
    const prevInputs = prevFn.inputs || [];
    const newInputs = newFn.inputs || [];

    if (newInputs.length < prevInputs.length) {
      changes.push({
        category: 'parameter',
        action: 'removed',
        target: `function ${name}`,
        details: `Parameters count reduced from ${prevInputs.length} to ${newInputs.length}.`,
        level: classifyChange('parameter', 'removed', strictMode),
      });
    } else if (newInputs.length > prevInputs.length) {
      changes.push({
        category: 'parameter',
        action: 'added',
        target: `function ${name}`,
        details: `New parameter(s) added to function '${name}'.`,
        level: classifyChange('parameter', 'added', strictMode),
      });
    }

    // Compare argument types
    for (let i = 0; i < Math.min(prevInputs.length, newInputs.length); i++) {
      if (prevInputs[i].type !== newInputs[i].type) {
        changes.push({
          category: 'parameter',
          action: 'modified',
          target: `function ${name}.${newInputs[i].name}`,
          details: `Parameter '${newInputs[i].name}' type changed from ${prevInputs[i].type} to ${newInputs[i].type}.`,
          level: classifyChange('parameter', 'modified', strictMode),
        });
      }
    }

    // Compare return types
    const prevOut = prevFn.outputs.join(', ');
    const newOut = newFn.outputs.join(', ');
    if (prevOut !== newOut) {
      changes.push({
        category: 'return-type',
        action: 'modified',
        target: `function ${name}`,
        details: `Return type changed from '${prevOut}' to '${newOut}'.`,
        level: classifyChange('return-type', 'modified', strictMode),
      });
    }
  });

  return changes;
}

/**
 * Compares user-defined types (structs & enums) between two specifications.
 */
export function compareTypes(
  prevSpec: ParsedContractSpec,
  newSpec: ParsedContractSpec,
  strictMode = false,
): CompatibilityChange[] {
  const changes: CompatibilityChange[] = [];

  // Compare Structs
  const prevStructMap = new Map(prevSpec.structs.map((s) => [s.name, s]));
  const newStructMap = new Map(newSpec.structs.map((s) => [s.name, s]));

  prevStructMap.forEach((_, name) => {
    if (!newStructMap.has(name)) {
      changes.push({
        category: 'struct',
        action: 'removed',
        target: `struct ${name}`,
        details: `Struct '${name}' was removed.`,
        level: classifyChange('struct', 'removed', strictMode),
      });
    }
  });

  newStructMap.forEach((newSt, name) => {
    const prevSt = prevStructMap.get(name);
    if (!prevSt) {
      changes.push({
        category: 'struct',
        action: 'added',
        target: `struct ${name}`,
        details: `New struct '${name}' was added.`,
        level: classifyChange('struct', 'added', strictMode),
      });
      return;
    }

    const prevFields = new Map(prevSt.fields.map((f) => [f.name, f.type]));
    newSt.fields.forEach((f) => {
      if (!prevFields.has(f.name)) {
        changes.push({
          category: 'struct',
          action: 'added',
          target: `struct ${name}.${f.name}`,
          details: `Field '${f.name}' was added to struct '${name}'.`,
          level: classifyChange('struct', 'added', strictMode),
        });
      } else if (prevFields.get(f.name) !== f.type) {
        changes.push({
          category: 'struct',
          action: 'modified',
          target: `struct ${name}.${f.name}`,
          details: `Field '${f.name}' type changed from ${prevFields.get(f.name)} to ${f.type}.`,
          level: classifyChange('struct', 'modified', strictMode),
        });
      }
    });
  });

  // Compare Enums
  const prevEnumMap = new Map(prevSpec.enums.map((e) => [e.name, e]));
  const newEnumMap = new Map(newSpec.enums.map((e) => [e.name, e]));

  prevEnumMap.forEach((prevEn, name) => {
    const newEn = newEnumMap.get(name);
    if (!newEn) {
      changes.push({
        category: 'enum',
        action: 'removed',
        target: `enum ${name}`,
        details: `Enum '${name}' was removed.`,
        level: classifyChange('enum', 'removed', strictMode),
      });
      return;
    }

    const newCases = new Set(newEn.cases.map((c) => c.name));
    prevEn.cases.forEach((c) => {
      if (!newCases.has(c.name)) {
        changes.push({
          category: 'enum',
          action: 'removed',
          target: `enum ${name}.${c.name}`,
          details: `Enum variant '${c.name}' was removed from enum '${name}'.`,
          level: classifyChange('enum', 'removed', strictMode),
        });
      }
    });
  });

  return changes;
}

/**
 * Checks overall compatibility between two contract specifications.
 */
export function checkInterfaceCompatibility(
  prevSpecEntries: any[],
  newSpecEntries: any[],
  strictMode = false,
): CompatibilityReport {
  const prevParsed = parseContractSpec(prevSpecEntries);
  const newParsed = parseContractSpec(newSpecEntries);

  const fnChanges = compareFunctions(prevParsed.functions, newParsed.functions, strictMode);
  const typeChanges = compareTypes(prevParsed, newParsed, strictMode);
  const changes = [...fnChanges, ...typeChanges];

  const breakingChangesCount = changes.filter((c) => c.level === 'breaking').length;
  const potentiallyBreakingChangesCount = changes.filter(
    (c) => c.level === 'potentially-breaking',
  ).length;
  const compatibleChangesCount = changes.filter((c) => c.level === 'compatible').length;

  return {
    isCompatible: breakingChangesCount === 0,
    totalChanges: changes.length,
    breakingChangesCount,
    potentiallyBreakingChangesCount,
    compatibleChangesCount,
    changes,
  };
}

/**
 * Formats a CompatibilityReport into a readable text summary.
 */
export function formatCompatibilityReport(report: CompatibilityReport): string {
  const lines: string[] = [];

  lines.push('=== Soroban Contract Interface Compatibility Report ===');
  lines.push(
    `Overall Status: ${report.isCompatible ? 'COMPATIBLE (No Breaking Changes)' : 'INCOMPATIBLE (Breaking Changes Detected)'}`,
  );
  lines.push(`Total Changes Detected: ${report.totalChanges}`);
  lines.push(`  - Breaking Changes:             ${report.breakingChangesCount}`);
  lines.push(`  - Potentially Breaking Changes: ${report.potentiallyBreakingChangesCount}`);
  lines.push(`  - Compatible Changes:           ${report.compatibleChangesCount}`);

  lines.push('\nDetailed Differences:');
  if (report.changes.length === 0) {
    lines.push('  No interface changes detected.');
  } else {
    report.changes.forEach((c, idx) => {
      lines.push(
        `  ${idx + 1}. [${c.level.toUpperCase()}] ${c.action.toUpperCase()} ${c.target} — ${c.details}`,
      );
    });
  }

  return lines.join('\n');
}

/**
 * Returns a sample V1 and V2 specification for demonstration.
 */
export function getSampleV1V2Specs(): { v1: any[]; v2: any[] } {
  const v1 = [
    {
      arm: () => 'functionV0',
      functionV0: () => ({
        name: () => 'hello',
        doc: () => 'V1 greeting method',
        inputs: () => [{ name: () => 'to', typeDef: () => ({ switch: () => 'scSpecTypeString' }) }],
        outputs: () => [{ switch: () => 'scSpecTypeString' }],
      }),
    },
    {
      arm: () => 'functionV0',
      functionV0: () => ({
        name: () => 'old_fn',
        doc: () => 'Legacy function to be removed',
        inputs: () => [],
        outputs: () => [{ switch: () => 'scSpecTypeVoid' }],
      }),
    },
  ];

  const v2 = [
    {
      arm: () => 'functionV0',
      functionV0: () => ({
        name: () => 'hello',
        doc: () => 'V2 greeting method with modified return type',
        inputs: () => [{ name: () => 'to', typeDef: () => ({ switch: () => 'scSpecTypeString' }) }],
        outputs: () => [{ switch: () => 'scSpecTypeVec' }],
      }),
    },
    {
      arm: () => 'functionV0',
      functionV0: () => ({
        name: () => 'new_feature',
        doc: () => 'Newly added feature function',
        inputs: () => [],
        outputs: () => [{ switch: () => 'scSpecTypeU32' }],
      }),
    },
  ];

  return { v1, v2 };
}

/**
 * Runs the Soroban contract interface compatibility checker example.
 */
export async function run(params: CompatibilityCheckerParams = {}): Promise<void> {
  const strictMode = params.strictMode ?? false;

  console.log('Starting Soroban Contract Interface Compatibility Checker Example...');
  console.log(`Strict Mode: ${strictMode ? 'ENABLED' : 'DISABLED'}`);

  let prevEntries = params.previousSpec;
  let newEntries = params.newSpec;

  if (!prevEntries || !newEntries) {
    console.log('Using sample V1 vs V2 specifications for compatibility comparison...');
    const samples = getSampleV1V2Specs();
    prevEntries = samples.v1;
    newEntries = samples.v2;
  }

  const report = checkInterfaceCompatibility(prevEntries, newEntries, strictMode);

  if (params.jsonOutput || process.env.JSON_OUTPUT === 'true') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n' + formatCompatibilityReport(report));
  }

  console.log('\nContract interface compatibility check completed successfully.');
}
