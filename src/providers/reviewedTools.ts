import { canonicalHash, canonicalStringify, type JsonValue } from "../domain/canonical";
import type { ReviewedProviderTool, ToolManifest } from "../domain/contracts";
import { manifestIsComplete } from "../policy/toolPolicy";

export type ReviewedToolErrorCode =
  | "invalid_tool_definition"
  | "tool_name_collision"
  | "schema_hash_mismatch"
  | "unsupported_schema"
  | "invalid_tool_arguments"
  | "unadvertised_tool";

const REVIEWED_TOOL_ERROR_CODES = new Set<ReviewedToolErrorCode>([
  "invalid_tool_definition",
  "tool_name_collision",
  "schema_hash_mismatch",
  "unsupported_schema",
  "invalid_tool_arguments",
  "unadvertised_tool",
]);

export function normalizeReviewedToolErrorCode(value: unknown): ReviewedToolErrorCode | undefined {
  return typeof value === "string" && REVIEWED_TOOL_ERROR_CODES.has(value as ReviewedToolErrorCode)
    ? value as ReviewedToolErrorCode
    : undefined;
}

export class ReviewedToolError extends Error {
  readonly retryable = false;

  readonly reasonCode: ReviewedToolErrorCode;

  constructor(reasonCodeValue: ReviewedToolErrorCode) {
    const reasonCode = normalizeReviewedToolErrorCode(reasonCodeValue) ?? "invalid_tool_definition";
    super(`Reviewed provider tool validation stopped (${reasonCode}).`);
    this.name = "ReviewedToolError";
    this.reasonCode = reasonCode;
  }
}

function sanitizedReviewedToolError(
  error: unknown,
  fallback: ReviewedToolErrorCode,
): ReviewedToolError {
  try {
    if (error instanceof ReviewedToolError) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "reasonCode");
      const reason = descriptor && "value" in descriptor
        ? normalizeReviewedToolErrorCode(descriptor.value)
        : undefined;
      if (reason) return new ReviewedToolError(reason);
    }
  } catch {
    // Hostile prototypes and accessors collapse to the caller's safe fallback.
  }
  return new ReviewedToolError(fallback);
}

const SUPPORTED_SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);
const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...expected, ...optional]);
  const actual = Object.keys(value);
  return expected.every((key) => actual.includes(key)) && actual.every((key) => allowed.has(key));
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(canonicalStringify(value)) as JsonValue;
}

function primarySchemaType(value: unknown): string {
  if (typeof value === "string" && JSON_TYPES.has(value)) return value;
  if (Array.isArray(value) && value.length === 2 &&
    value.every((item) => typeof item === "string" && JSON_TYPES.has(item)) &&
    new Set(value).size === value.length && value.includes("null")) {
    return value.find((item) => item !== "null") as string;
  }
  throw new ReviewedToolError("unsupported_schema");
}

function validateFiniteBound(value: unknown, integer: boolean, nonNegative = false): void {
  if (typeof value !== "number" || !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) || (nonNegative && value < 0)) {
    throw new ReviewedToolError("unsupported_schema");
  }
}

function validateSchemaNode(value: unknown, depth: number): void {
  if (depth > 64 || !plainRecord(value)) throw new ReviewedToolError("unsupported_schema");
  if (Object.keys(value).some((key) => !SUPPORTED_SCHEMA_KEYS.has(key))) {
    throw new ReviewedToolError("unsupported_schema");
  }
  const type = primarySchemaType(value.type);
  if (value.description !== undefined && (
    typeof value.description !== "string" ||
    new TextEncoder().encode(value.description).byteLength > 1024
  )) throw new ReviewedToolError("unsupported_schema");
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) {
      throw new ReviewedToolError("unsupported_schema");
    }
    for (const item of value.enum) canonicalStringify(item);
  }
  if (value.const !== undefined) canonicalStringify(value.const);

  if (type === "object") {
    if (!plainRecord(value.properties) || !Array.isArray(value.required) ||
      value.additionalProperties !== false || value.items !== undefined ||
      value.minLength !== undefined || value.maxLength !== undefined ||
      value.minimum !== undefined || value.maximum !== undefined ||
      value.minItems !== undefined || value.maxItems !== undefined) {
      throw new ReviewedToolError("unsupported_schema");
    }
    const propertyNames = Object.keys(value.properties).sort();
    if (!value.required.every((item) => typeof item === "string") ||
      new Set(value.required).size !== value.required.length ||
      canonicalStringify([...value.required].sort()) !== canonicalStringify(propertyNames)) {
      throw new ReviewedToolError("unsupported_schema");
    }
    for (const property of Object.values(value.properties)) validateSchemaNode(property, depth + 1);
  } else if (type === "array") {
    if (value.items === undefined || value.properties !== undefined ||
      value.required !== undefined || value.additionalProperties !== undefined ||
      value.minLength !== undefined || value.maxLength !== undefined ||
      value.minimum !== undefined || value.maximum !== undefined) {
      throw new ReviewedToolError("unsupported_schema");
    }
    validateSchemaNode(value.items, depth + 1);
    if (value.minItems !== undefined) validateFiniteBound(value.minItems, true, true);
    if (value.maxItems !== undefined) validateFiniteBound(value.maxItems, true, true);
    if (typeof value.minItems === "number" && typeof value.maxItems === "number" &&
      value.minItems > value.maxItems) throw new ReviewedToolError("unsupported_schema");
  } else {
    if (value.properties !== undefined || value.required !== undefined ||
      value.additionalProperties !== undefined || value.items !== undefined ||
      value.minItems !== undefined || value.maxItems !== undefined) {
      throw new ReviewedToolError("unsupported_schema");
    }
    if ((type === "string") && value.minLength !== undefined) {
      validateFiniteBound(value.minLength, true, true);
    }
    if ((type === "string") && value.maxLength !== undefined) {
      validateFiniteBound(value.maxLength, true, true);
    }
    if (type !== "string" && (value.minLength !== undefined || value.maxLength !== undefined)) {
      throw new ReviewedToolError("unsupported_schema");
    }
    if (typeof value.minLength === "number" && typeof value.maxLength === "number" &&
      value.minLength > value.maxLength) throw new ReviewedToolError("unsupported_schema");
    if ((type === "number" || type === "integer") && value.minimum !== undefined) {
      validateFiniteBound(value.minimum, false);
    }
    if ((type === "number" || type === "integer") && value.maximum !== undefined) {
      validateFiniteBound(value.maximum, false);
    }
    if (type !== "number" && type !== "integer" &&
      (value.minimum !== undefined || value.maximum !== undefined)) {
      throw new ReviewedToolError("unsupported_schema");
    }
    if (typeof value.minimum === "number" && typeof value.maximum === "number" &&
      value.minimum > value.maximum) throw new ReviewedToolError("unsupported_schema");
  }
  try {
    if (value.enum !== undefined) {
      for (const candidate of value.enum as JsonValue[]) {
        validateValue(candidate, value, depth);
      }
    }
    if (value.const !== undefined) {
      validateValue(value.const as JsonValue, value, depth);
      if (value.enum !== undefined && !(value.enum as JsonValue[]).some(
        (candidate) => canonicalStringify(candidate) === canonicalStringify(value.const),
      )) throw new Error("const not in enum");
    }
  } catch {
    throw new ReviewedToolError("unsupported_schema");
  }
}

function cloneManifest(manifest: ToolManifest): ToolManifest {
  return deepFreeze({
    ...manifest,
    dataScope: [...manifest.dataScope],
    networkScope: [...manifest.networkScope],
  });
}

export function prepareReviewedTools(value: unknown): readonly ReviewedProviderTool[] {
  try {
    if (!Array.isArray(value) || value.length > 128) {
      throw new ReviewedToolError("invalid_tool_definition");
    }
    const tools: ReviewedProviderTool[] = [];
    const wireNames = new Set<string>();
    const toolIds = new Set<string>();
    for (const item of value) {
      if (!plainRecord(item) || !exactKeys(item, [
        "toolId",
        "wireName",
        "description",
        "inputSchema",
        "schemaHash",
        "manifest",
      ])) throw new ReviewedToolError("invalid_tool_definition");
      if (typeof item.toolId !== "string" || !item.toolId || toolIds.has(item.toolId) ||
        typeof item.wireName !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.wireName) ||
        typeof item.description !== "string" || item.description.length === 0 ||
        new TextEncoder().encode(item.description).byteLength > 1024 ||
        typeof item.schemaHash !== "string" || !/^[a-f0-9]{64}$/.test(item.schemaHash) ||
        !plainRecord(item.manifest)) {
        throw new ReviewedToolError("invalid_tool_definition");
      }
      const normalizedName = item.wireName.toLowerCase();
      if (wireNames.has(normalizedName)) throw new ReviewedToolError("tool_name_collision");
      validateSchemaNode(item.inputSchema, 1);
      if (!plainRecord(item.inputSchema) || item.inputSchema.type !== "object") {
        throw new ReviewedToolError("unsupported_schema");
      }
      if (!exactKeys(item.manifest, [
        "toolId",
        "version",
        "schemaHash",
        "effect",
        "dataScope",
        "networkScope",
        "idempotency",
      ], ["allowPureComputation"])) {
        throw new ReviewedToolError("invalid_tool_definition");
      }
      const schema = cloneJson(item.inputSchema as JsonValue);
      const schemaHash = canonicalHash(schema);
      if (schemaHash !== item.schemaHash || item.manifest.schemaHash !== schemaHash) {
        throw new ReviewedToolError("schema_hash_mismatch");
      }
      const manifest = cloneManifest(item.manifest as unknown as ToolManifest);
      if (!manifestIsComplete(manifest) || manifest.toolId !== item.toolId) {
        throw new ReviewedToolError("invalid_tool_definition");
      }
      wireNames.add(normalizedName);
      toolIds.add(item.toolId);
      tools.push(deepFreeze({
        toolId: item.toolId,
        wireName: item.wireName,
        description: item.description,
        inputSchema: schema,
        schemaHash,
        manifest,
      } as ReviewedProviderTool));
    }
    return deepFreeze(tools);
  } catch (error) {
    throw sanitizedReviewedToolError(error, "invalid_tool_definition");
  }
}

function valueMatchesType(value: JsonValue, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return plainRecord(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return false;
}

function validateValue(value: JsonValue, schema: Record<string, unknown>, depth: number): void {
  if (depth > 64) throw new ReviewedToolError("invalid_tool_arguments");
  const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
  if (!types.some((type) => valueMatchesType(value, type))) {
    throw new ReviewedToolError("invalid_tool_arguments");
  }
  if (schema.enum !== undefined && !(schema.enum as unknown[]).some(
    (candidate) => canonicalStringify(candidate) === canonicalStringify(value),
  )) throw new ReviewedToolError("invalid_tool_arguments");
  if (schema.const !== undefined && canonicalStringify(schema.const) !== canonicalStringify(value)) {
    throw new ReviewedToolError("invalid_tool_arguments");
  }
  if (value === null) return;
  const type = types.find((candidate) => candidate !== "null") ?? "null";
  if (type === "object") {
    if (!plainRecord(value)) throw new ReviewedToolError("invalid_tool_arguments");
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const keys = Object.keys(value).sort();
    if (canonicalStringify(keys) !== canonicalStringify(Object.keys(properties).sort())) {
      throw new ReviewedToolError("invalid_tool_arguments");
    }
    for (const [key, child] of Object.entries(properties)) {
      validateValue(value[key] as JsonValue, child, depth + 1);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) throw new ReviewedToolError("invalid_tool_arguments");
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      throw new ReviewedToolError("invalid_tool_arguments");
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      throw new ReviewedToolError("invalid_tool_arguments");
    }
    for (const child of value) validateValue(child, schema.items as Record<string, unknown>, depth + 1);
  } else if (type === "string") {
    if (typeof value !== "string") throw new ReviewedToolError("invalid_tool_arguments");
    const codePoints = [...value].length;
    if (typeof schema.minLength === "number" && codePoints < schema.minLength) {
      throw new ReviewedToolError("invalid_tool_arguments");
    }
    if (typeof schema.maxLength === "number" && codePoints > schema.maxLength) {
      throw new ReviewedToolError("invalid_tool_arguments");
    }
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number") throw new ReviewedToolError("invalid_tool_arguments");
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      throw new ReviewedToolError("invalid_tool_arguments");
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      throw new ReviewedToolError("invalid_tool_arguments");
    }
  }
}

export function validateToolArguments(tool: ReviewedProviderTool, value: JsonValue): JsonValue {
  try {
    validateValue(value, tool.inputSchema as Record<string, unknown>, 1);
    return cloneJson(value);
  } catch (error) {
    throw sanitizedReviewedToolError(error, "invalid_tool_arguments");
  }
}

export function findReviewedTool(
  tools: readonly ReviewedProviderTool[],
  wireName: unknown,
): ReviewedProviderTool {
  if (typeof wireName !== "string") throw new ReviewedToolError("unadvertised_tool");
  const tool = tools.find((candidate) => candidate.wireName === wireName);
  if (!tool) throw new ReviewedToolError("unadvertised_tool");
  return tool;
}
