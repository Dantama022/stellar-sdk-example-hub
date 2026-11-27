/**
 * schema.ts
 *
 * Defines reusable TypeScript schemas for expected Soroban contract event
 * structures and exports several built-in schemas for common token-contract
 * and administrative events.
 *
 * A schema describes:
 * - Which event name it matches (first symbol topic).
 * - How many topics are expected and what XDR types they should carry.
 * - What XDR type the event data payload should carry.
 * - Which data fields (when the payload is a map) are required or optional.
 */

// ─── field descriptor ─────────────────────────────────────────────────────────

/** Allowed TypeScript value types for a decoded event field. */
export type FieldType =
  | 'string'
  | 'number'
  | 'bigint'      // represented as a stringified bigint after JSON-safe formatting
  | 'boolean'
  | 'object'
  | 'array'
  | 'any';

/** Descriptor for one field inside a map-typed event payload. */
export interface FieldDescriptor {
  /** Field name as it appears in the decoded map. */
  name: string;
  /** Expected TypeScript type of the decoded value. */
  type: FieldType;
  /** When false (default), validation errors if the field is absent. */
  optional?: boolean;
}

// ─── topic descriptor ─────────────────────────────────────────────────────────

/** Descriptor for one topic slot in an event. */
export interface TopicDescriptor {
  /** Position (0-indexed) of the topic. */
  index: number;
  /** Expected XDR discriminant name, e.g. "scvSymbol", "scvAddress". */
  xdrType: string;
  /** Human-readable label for error messages. */
  label?: string;
  /** When true, a mismatch is a warning rather than an error. */
  optional?: boolean;
}

// ─── event schema ─────────────────────────────────────────────────────────────

/** Full schema definition for one Soroban contract event type. */
export interface EventSchema {
  /**
   * Unique identifier for this schema (used in validation reports).
   * Typically the event name, e.g. "transfer".
   */
  id: string;
  /**
   * Human-readable description shown in reports.
   */
  description: string;
  /**
   * Event name that this schema matches, taken from the first symbol topic.
   * Use "*" to match any event (wildcard / fallback schema).
   */
  eventName: string;
  /**
   * Expected total number of topics. Validation fails if the event carries
   * a different count and `topicCountIsMinimum` is not set.
   */
  topicCount?: number;
  /**
   * When true, `topicCount` is treated as a minimum rather than an exact count.
   */
  topicCountIsMinimum?: boolean;
  /** Per-slot topic expectations. */
  topics?: TopicDescriptor[];
  /**
   * Expected XDR type of the event data payload.
   * Leave undefined to skip payload-type validation.
   */
  payloadType?: string;
  /**
   * When `payloadType` is "scvMap", specifies expected fields.
   */
  payloadFields?: FieldDescriptor[];
}

// ─── schema registry ─────────────────────────────────────────────────────────

/**
 * A registry holds a list of schemas and resolves which one to apply to any
 * given event name.
 */
export interface SchemaRegistry {
  schemas: EventSchema[];
}

/**
 * Resolves the first schema whose `eventName` matches the given name.
 * Falls back to a schema with `eventName === "*"` if no exact match is found.
 * Returns null when no applicable schema exists.
 */
export function resolveSchema(
  registry: SchemaRegistry,
  eventName: string | null,
): EventSchema | null {
  if (eventName) {
    const exact = registry.schemas.find((s) => s.eventName === eventName);
    if (exact) return exact;
  }
  return registry.schemas.find((s) => s.eventName === '*') ?? null;
}

// ─── built-in schemas ─────────────────────────────────────────────────────────

/**
 * Schema for the SEP-41 / SAC `transfer` event.
 *
 * Topics: [ Symbol("transfer"), Address(from), Address(to) ]
 * Data:   i128 (amount)
 */
export const TRANSFER_SCHEMA: EventSchema = {
  id: 'transfer',
  description: 'Token transfer event (SEP-41 / SAC)',
  eventName: 'transfer',
  topicCount: 3,
  topics: [
    { index: 0, xdrType: 'scvSymbol', label: 'event name' },
    { index: 1, xdrType: 'scvAddress', label: 'from address' },
    { index: 2, xdrType: 'scvAddress', label: 'to address' },
  ],
  payloadType: 'scvI128',
};

/**
 * Schema for the SEP-41 / SAC `mint` event.
 *
 * Topics: [ Symbol("mint"), Address(admin), Address(to) ]
 * Data:   i128 (amount)
 */
export const MINT_SCHEMA: EventSchema = {
  id: 'mint',
  description: 'Token mint event (SEP-41 / SAC)',
  eventName: 'mint',
  topicCount: 3,
  topics: [
    { index: 0, xdrType: 'scvSymbol', label: 'event name' },
    { index: 1, xdrType: 'scvAddress', label: 'admin address' },
    { index: 2, xdrType: 'scvAddress', label: 'to address' },
  ],
  payloadType: 'scvI128',
};

/**
 * Schema for the SEP-41 / SAC `burn` event.
 *
 * Topics: [ Symbol("burn"), Address(from) ]
 * Data:   i128 (amount)
 */
export const BURN_SCHEMA: EventSchema = {
  id: 'burn',
  description: 'Token burn event (SEP-41 / SAC)',
  eventName: 'burn',
  topicCount: 2,
  topics: [
    { index: 0, xdrType: 'scvSymbol', label: 'event name' },
    { index: 1, xdrType: 'scvAddress', label: 'from address' },
  ],
  payloadType: 'scvI128',
};

/**
 * Schema for the SEP-41 / SAC `clawback` event.
 *
 * Topics: [ Symbol("clawback"), Address(admin), Address(from) ]
 * Data:   i128 (amount)
 */
export const CLAWBACK_SCHEMA: EventSchema = {
  id: 'clawback',
  description: 'Token clawback event (SEP-41 / SAC)',
  eventName: 'clawback',
  topicCount: 3,
  topics: [
    { index: 0, xdrType: 'scvSymbol', label: 'event name' },
    { index: 1, xdrType: 'scvAddress', label: 'admin address' },
    { index: 2, xdrType: 'scvAddress', label: 'from address' },
  ],
  payloadType: 'scvI128',
};

/**
 * Wildcard / fallback schema that matches any event not covered by a more
 * specific schema. Only checks that there is at least one topic.
 */
export const UNKNOWN_EVENT_SCHEMA: EventSchema = {
  id: '*',
  description: 'Fallback schema for unrecognised events',
  eventName: '*',
  topicCount: 1,
  topicCountIsMinimum: true,
};

/** Default registry used by the validator when no custom registry is supplied. */
export const DEFAULT_SCHEMA_REGISTRY: SchemaRegistry = {
  schemas: [
    TRANSFER_SCHEMA,
    MINT_SCHEMA,
    BURN_SCHEMA,
    CLAWBACK_SCHEMA,
    UNKNOWN_EVENT_SCHEMA,
  ],
};
