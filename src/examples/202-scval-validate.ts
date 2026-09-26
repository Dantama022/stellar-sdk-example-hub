export async function run(params: { input?: string; expectedType?: string } = {}) {
  const inputStr = params.input || process.argv[3];
  const typeStr = params.expectedType || process.argv[4];
  if (!inputStr || !typeStr) throw new Error('Missing input or expectedType.');

  let input: any;
  try {
    input = JSON.parse(inputStr);
  } catch {
    input = inputStr; // Handle bare strings
  }

  console.log(`=== ScVal Type Compatibility Validator ===`);
  console.log(`Input:`, input);
  console.log(`Expected Type: ${typeStr}`);

  let isValid = true;
  let mismatch = '';

  const expectedLower = typeStr.toLowerCase();

  if (expectedLower === 'boolean' || expectedLower === 'bool') {
    if (typeof input !== 'boolean') {
      isValid = false;
      mismatch = 'Expected boolean';
    }
  } else if (expectedLower === 'number' || expectedLower === 'u32' || expectedLower === 'i32') {
    if (typeof input !== 'number') {
      isValid = false;
      mismatch = 'Expected number';
    }
  } else if (expectedLower === 'string' || expectedLower === 'symbol') {
    if (typeof input !== 'string') {
      isValid = false;
      mismatch = 'Expected string';
    }
  } else if (expectedLower === 'address') {
    if (
      typeof input !== 'string' ||
      (!input.startsWith('G') && !input.startsWith('C')) ||
      input.length !== 56
    ) {
      isValid = false;
      mismatch = 'Expected a valid Stellar 56-character address';
    }
  } else if (expectedLower === 'vector' || expectedLower === 'array') {
    if (!Array.isArray(input)) {
      isValid = false;
      mismatch = 'Expected array/vector';
    }
  }

  if (isValid) {
    console.log(`\n[Valid] The input structurally matches the expected type.`);
  } else {
    console.log(`\n[Invalid] Type mismatch detected: ${mismatch}`);
  }
}
