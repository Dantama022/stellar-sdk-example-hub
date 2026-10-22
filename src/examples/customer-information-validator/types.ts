export type Sep9FieldType = 'string' | 'date' | 'number' | 'binary';

export interface Sep9FieldDefinition {
  type: Sep9FieldType;
  description: string;
  formats?: readonly string[];
}

export type CustomerFieldValue = string | number;

export interface CustomerInformationPayload {
  fields: Record<string, unknown>;
}

export interface ValidationOptions {
  requiredFields?: readonly string[];
}

export interface InvalidFieldValue {
  field: string;
  rule: string;
}

export interface CustomerInformationValidationReport {
  valid: boolean;
  recognizedFields: string[];
  missingRequiredFields: string[];
  invalidValues: InvalidFieldValue[];
  unknownFields: string[];
  structureErrors: string[];
  applicableRules: string[];
  nextSteps: string[];
}

export interface PreparedSep12CustomerFields {
  values: Record<string, string | number>;
  binaryFields: Record<string, string>;
}

export interface Sep12CustomerInfoAdapter {
  submitCustomerInfo(fields: PreparedSep12CustomerFields): Promise<unknown>;
}