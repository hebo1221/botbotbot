import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function normalize(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(path, "numbers must be finite");
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => normalize(item, `${path}[${index}]`));
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(path, "only plain objects are accepted");
    }

    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) {
        throw new CanonicalizationError(`${path}.${key}`, "undefined is not accepted");
      }
      result[key] = normalize(item, `${path}.${key}`);
    }
    return result;
  }

  throw new CanonicalizationError(path, `unsupported value type: ${typeof value}`);
}

export class CanonicalizationError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Cannot canonicalize ${path}: ${reason}`);
    this.name = "CanonicalizationError";
  }
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalize(value, "$"));
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}
