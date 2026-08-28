import { xdr } from '@stellar/stellar-sdk';

import {
  formatContractSpecReport,
  ParsedContractSpec,
  resolveTypeName,
  selectFunction,
} from '../src/utils/spec-parser';

describe('spec-parser', () => {
  it('resolves primitive and composite ScSpec type names', () => {
    expect(resolveTypeName(xdr.ScSpecTypeDef.scSpecTypeU32())).toBe('u32');
    expect(resolveTypeName(xdr.ScSpecTypeDef.scSpecTypeBool())).toBe('bool');
    expect(resolveTypeName(xdr.ScSpecTypeDef.scSpecTypeString())).toBe('string');
    expect(resolveTypeName(xdr.ScSpecTypeDef.scSpecTypeVoid())).toBe('void');
    expect(resolveTypeName(xdr.ScSpecTypeDef.scSpecTypeAddress())).toBe('address');
    expect(
      resolveTypeName(
        xdr.ScSpecTypeDef.scSpecTypeOption(
          new xdr.ScSpecTypeOption({ valueType: xdr.ScSpecTypeDef.scSpecTypeU32() }),
        ),
      ),
    ).toBe('Option<u32>');
    expect(
      resolveTypeName(
        xdr.ScSpecTypeDef.scSpecTypeVec(
          new xdr.ScSpecTypeVec({ elementType: xdr.ScSpecTypeDef.scSpecTypeI32() }),
        ),
      ),
    ).toBe('Vec<i32>');
    expect(
      resolveTypeName(
        xdr.ScSpecTypeDef.scSpecTypeMap(
          new xdr.ScSpecTypeMap({
            keyType: xdr.ScSpecTypeDef.scSpecTypeSymbol(),
            valueType: xdr.ScSpecTypeDef.scSpecTypeU32(),
          }),
        ),
      ),
    ).toBe('Map<symbol, u32>');
    expect(
      resolveTypeName(
        xdr.ScSpecTypeDef.scSpecTypeResult(
          new xdr.ScSpecTypeResult({
            okType: xdr.ScSpecTypeDef.scSpecTypeU32(),
            errorType: xdr.ScSpecTypeDef.scSpecTypeError(),
          }),
        ),
      ),
    ).toBe('Result<u32, error>');
    expect(
      resolveTypeName(
        xdr.ScSpecTypeDef.scSpecTypeTuple(
          new xdr.ScSpecTypeTuple({
            valueTypes: [xdr.ScSpecTypeDef.scSpecTypeU32(), xdr.ScSpecTypeDef.scSpecTypeBool()],
          }),
        ),
      ),
    ).toBe('Tuple<u32, bool>');
    expect(
      resolveTypeName(xdr.ScSpecTypeDef.scSpecTypeBytesN(new xdr.ScSpecTypeBytesN({ n: 32 }))),
    ).toBe('BytesN<32>');
  });

  it('selects functions and formats parsed contract specs', () => {
    const parsed: ParsedContractSpec = {
      contractName: 'demo',
      rawEntryCount: 2,
      functions: [
        {
          name: 'add',
          documentation: 'Adds values',
          inputs: [{ name: 'a', type: 'u32' }],
          outputs: ['u32'],
        },
        {
          name: '__constructor',
          documentation: '',
          inputs: [],
          outputs: [],
        },
      ],
      structs: [
        {
          name: 'Point',
          documentation: '',
          fields: [{ name: 'x', type: 'u32' }],
        },
      ],
      enums: [
        {
          name: 'Color',
          documentation: '',
          cases: [{ name: 'Red', value: 0 }],
        },
      ],
      unions: [
        {
          name: 'Shape',
          documentation: '',
          cases: [{ name: 'Circle', payloadTypes: [] }],
        },
      ],
      errorEnums: [
        {
          name: 'Error',
          documentation: '',
          cases: [{ name: 'Invalid', value: 1, documentation: 'bad input' }],
        },
      ],
    };

    expect(selectFunction(parsed)?.name).toBe('add');
    expect(selectFunction(parsed, 'add')?.inputs[0].type).toBe('u32');
    expect(selectFunction(parsed, 'missing')).toBeNull();

    const report = formatContractSpecReport(parsed, 'C123');
    expect(report).toContain('Contract ID : C123');
    expect(report).toContain('add(a: u32) -> u32');
    expect(report).toContain('Point');
    expect(report).toContain('Color');
    expect(report).toContain('Shape');
    expect(report).toContain('Error');
  });
});
