/**
 * validator.ts
 *
 * Validates decoded Soroban event records against EventSchema definitions.
 * Produces structured validation results with actionable error and warning
 * messages. Never throws—unexpected inputs produce a failed result.
 */

import { DecodedValue, ParsedEventRecord } from './decoder';
import {
  DEFAULT_SCHEMA_REGISTRY,
  EventSchema,
  FieldDescriptor,
  resolveSchema,
  SchemaRegistry,
  TopicDescriptor,
} from './schema';

// ─── result types ─────────────────────────────────────────────────────────────

/** Severity level of a validation finding. */
export type FindingSeverity = 'error' | 'warning' | 'info';

/** One validation finding. */
export interface ValidationFinding {
  severity: FindingSeverity;
  field: string;
  message: string;
}

/** Outcome of validating one event record. */
export interface ValidationResult {
  /** True when there are no error-severity findings. */
  valid: boolean;
  /** Schema that was applied, or null if none matched. */
  schemaId: string | null;
  findings: ValidationFinding[];
}

// ─── individual checks ────────────────────────────────────────────────────────

function checkTopicCount(
  topics: DecodedValue[],
  schema: EventSchema,
  findings: ValidationFinding[],
): void {
  if (schema.topicCount === undefined) return;

  const actual = topics.length;
  const expected = schema.topicCount;
  const isMinimum = schema.topicCountIsMinimum ?? false;

  if (isMinimum) {
    if (actual < expected) {
      findings.push({
        severity: 'error',
        field: 'topics',
        message: `Expected at least ${expected} topic(s), found ${actual}.`,
      });
    }
  } else {
    if (actual !== expected) {
      findings.push({
        severity: 'error',
        field: 'topics',
        message: `Expected exactly ${expected} topic(s), found ${actual}.`,
      });
    }
  }
}

function checkTopicTypes(
  topics: DecodedValue[],
  descriptors: TopicDescriptor[],
  findings: ValidationFinding[],
): void {
  for (const desc of descriptors) {
    if (desc.index >= topics.length) {
      if (!desc.optional) {
        findings.push({
          severity: 'error',
          field: `topics[${desc.index}]`,
          message: `Missing required topic at index ${desc.index}${desc.label ? ` (${desc.label})` : ''}.`,
        });
      }
      continue;
    }

    const topic = topics[desc.index];
    if (topic.xdrType !== desc.xdrType) {
      const severity: FindingSeverity = desc.optional ? 'warning' : 'error';
      findings.push({
        severity,
        field: `topics[${desc.index}]`,
        message: `Expected XDR type "${desc.xdrType}"${desc.label ? ` for ${desc.label}` : ''}, found "${topic.xdrType}".`,
      });
    }

    if (!topic.decoded) {
      findings.push({
        severity: 'warning',
        field: `topics[${desc.index}]`,
        message: `Topic at index ${desc.index} could not be decoded: ${topic.error ?? 'unknown error'}.`,
      });
    }
  }
}

function checkPayloadType(
  value: DecodedValue,
  expectedType: string,
  findings: ValidationFinding[],
): void {
  if (value.xdrType !== expectedType) {
    findings.push({
      severity: 'error',
      field: 'value',
      message: `Expected payload XDR type "${expectedType}", found "${value.xdrType}".`,
    });
  }

  if (!value.decoded) {
    findings.push({
      severity: 'error',
      field: 'value',
      message: `Payload could not be decoded: ${value.error ?? 'unknown error'}.`,
    });
  }
}

function checkPayloadFields(
  value: DecodedValue,
  fields: FieldDescriptor[],
  findings: ValidationFinding[],
): void {
  if (!value.decoded || typeof value.value !== 'object' || value.value === null) {
    findings.push({
      severity: 'error',
      field: 'value',
      message: 'Payload is not a decoded map object; field-level validation skipped.',
    });
    return;
  }

  const map = value.value as Record<string, unknown>;

  for (const field of fields) {
    const present = Object.prototype.hasOwnProperty.call(map, field.name);

    if (!present) {
      if (!field.optional) {
        findings.push({
          severity: 'error',
          field: `value.${field.name}`,
          message: `Required field "${field.name}" is missing from the event payload.`,
        });
      }
      continue;
    }

    const actual = map[field.name];
    const actualType = typeof actual;

    if (field.type === 'any') continue;

    // BigInts are stringified by formatNativeValue, so the decoded value
    // arrives as a string. We accept strings for 'bigint' fields.
    if (field.type === 'bigint') {
      if (actualType !== 'string') {
        findings.push({
          severity: 'error',
          field: `value.${field.name}`,
          message: `Field "${field.name}" should be a bigint (encoded as string), found "${actualType}".`,
        });
      }
      continue;
    }

    if (field.type === 'array') {
      if (!Array.isArray(actual)) {
        findings.push({
          severity: 'error',
          field: `value.${field.name}`,
          message: `Field "${field.name}" should be an array, found "${actualType}".`,
        });
      }
      continue;
    }

    if (actualType !== field.type) {
      findings.push({
        severity: 'error',
        field: `value.${field.name}`,
        message: `Field "${field.name}" should be "${field.type}", found "${actualType}".`,
      });
    }
  }

  // Report extra fields in the payload as informational.
  for (const key of Object.keys(map)) {
    if (!fields.find((f) => f.name === key)) {
      findings.push({
        severity: 'info',
        field: `value.${key}`,
        message: `Unexpected field "${key}" in payload (not in schema).`,
      });
    }
  }
}

// ─── main validator ───────────────────────────────────────────────────────────

/**
 * Validates one parsed event record against the schemas in the registry.
 *
 * Returns a `ValidationResult` describing every finding found. The result is
 * valid when no error-severity findings are present.
 */
export function validateEvent(
  event: ParsedEventRecord,
  registry: SchemaRegistry = DEFAULT_SCHEMA_REGISTRY,
): ValidationResult {
  const findings: ValidationFinding[] = [];

  // Flag events from failed sub-calls.
  if (!event.inSuccessfulContractCall) {
    findings.push({
      severity: 'warning',
      field: 'inSuccessfulContractCall',
      message: 'This event was emitted inside a sub-call that failed.',
    });
  }

  const schema = resolveSchema(registry, event.eventName);
  if (!schema) {
    findings.push({
      severity: 'warning',
      field: 'schema',
      message: `No schema found for event "${event.eventName ?? '(unnamed)'}". Skipping structural validation.`,
    });
    return { valid: true, schemaId: null, findings };
  }

  checkTopicCount(event.topics, schema, findings);

  if (schema.topics?.length) {
    checkTopicTypes(event.topics, schema.topics, findings);
  }

  if (schema.payloadType) {
    checkPayloadType(event.value, schema.payloadType, findings);
  }

  if (schema.payloadFields?.length) {
    checkPayloadFields(event.value, schema.payloadFields, findings);
  }

  const hasErrors = findings.some((f) => f.severity === 'error');
  return {
    valid: !hasErrors,
    schemaId: schema.id,
    findings,
  };
}

// ─── batch validation ─────────────────────────────────────────────────────────

/** Combined result for one event: the parsed record and its validation outcome. */
export interface ValidatedEvent {
  event: ParsedEventRecord;
  validation: ValidationResult;
}

/**
 * Validates every event in an array and returns paired results.
 */
export function validateEvents(
  events: ParsedEventRecord[],
  registry: SchemaRegistry = DEFAULT_SCHEMA_REGISTRY,
): ValidatedEvent[] {
  return events.map((event) => ({
    event,
    validation: validateEvent(event, registry),
  }));
}
