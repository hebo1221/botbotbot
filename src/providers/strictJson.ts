import { canonicalStringify, type JsonValue } from "../domain/canonical";

export type StrictJsonErrorCode =
  | "malformed_json"
  | "duplicate_json_key"
  | "json_depth_exceeded"
  | "json_not_canonical"
  | "json_too_large"
  | "invalid_utf8"
  | "utf8_bom_forbidden";

export class StrictJsonError extends Error {
  constructor(readonly reasonCode: StrictJsonErrorCode) {
    super(`Strict JSON validation failed (${reasonCode}).`);
    this.name = "StrictJsonError";
  }
}

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

class JsonStructureParser {
  #index = 0;

  constructor(
    private readonly source: string,
    private readonly maxDepth: number,
  ) {}

  parse(): void {
    this.skipWhitespace();
    this.parseValue(0);
    this.skipWhitespace();
    if (this.#index !== this.source.length) this.malformed();
  }

  private parseValue(depth: number): void {
    const character = this.source[this.#index];
    if (character === "{") return this.parseObject(depth + 1);
    if (character === "[") return this.parseArray(depth + 1);
    if (character === "\"") {
      this.parseString();
      return;
    }
    if (character === "t") return this.literal("true");
    if (character === "f") return this.literal("false");
    if (character === "n") return this.literal("null");
    if (character === "-" || (character >= "0" && character <= "9")) {
      this.parseNumber();
      return;
    }
    this.malformed();
  }

  private parseObject(depth: number): void {
    this.assertDepth(depth);
    this.#index += 1;
    this.skipWhitespace();
    if (this.source[this.#index] === "}") {
      this.#index += 1;
      return;
    }
    const keys = new Set<string>();
    for (;;) {
      if (this.source[this.#index] !== "\"") this.malformed();
      const key = this.parseString();
      if (keys.has(key)) throw new StrictJsonError("duplicate_json_key");
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.#index] !== ":") this.malformed();
      this.#index += 1;
      this.skipWhitespace();
      this.parseValue(depth);
      this.skipWhitespace();
      const character = this.source[this.#index];
      if (character === "}") {
        this.#index += 1;
        return;
      }
      if (character !== ",") this.malformed();
      this.#index += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): void {
    this.assertDepth(depth);
    this.#index += 1;
    this.skipWhitespace();
    if (this.source[this.#index] === "]") {
      this.#index += 1;
      return;
    }
    for (;;) {
      this.parseValue(depth);
      this.skipWhitespace();
      const character = this.source[this.#index];
      if (character === "]") {
        this.#index += 1;
        return;
      }
      if (character !== ",") this.malformed();
      this.#index += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.#index;
    this.#index += 1;
    for (;;) {
      if (this.#index >= this.source.length) this.malformed();
      const character = this.source[this.#index];
      const code = this.source.charCodeAt(this.#index);
      if (code <= 0x1f) this.malformed();
      if (character === "\"") {
        this.#index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.#index)) as string;
        } catch {
          this.malformed();
        }
      }
      if (character === "\\") {
        this.#index += 1;
        const escape = this.source[this.#index];
        if (escape === "u") {
          const hex = this.source.slice(this.#index + 1, this.#index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.malformed();
          this.#index += 5;
          continue;
        }
        if (!escape || !"\"\\/bfnrt".includes(escape)) this.malformed();
      }
      this.#index += 1;
    }
  }

  private parseNumber(): void {
    const remainder = this.source.slice(this.#index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remainder);
    if (!match) this.malformed();
    this.#index += match[0].length;
    const next = this.source[this.#index];
    if (next && !JSON_WHITESPACE.has(next) && next !== "," && next !== "]" && next !== "}") {
      this.malformed();
    }
  }

  private literal(value: "true" | "false" | "null"): void {
    if (!this.source.startsWith(value, this.#index)) this.malformed();
    this.#index += value.length;
  }

  private assertDepth(depth: number): void {
    if (depth > this.maxDepth) throw new StrictJsonError("json_depth_exceeded");
  }

  private skipWhitespace(): void {
    while (JSON_WHITESPACE.has(this.source[this.#index])) this.#index += 1;
  }

  private malformed(): never {
    throw new StrictJsonError("malformed_json");
  }
}

export function parseStrictJson(text: unknown, maxDepth = 64): JsonValue {
  if (typeof text !== "string" || !Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 64) {
    throw new StrictJsonError("malformed_json");
  }
  if (text.startsWith("\uFEFF")) throw new StrictJsonError("utf8_bom_forbidden");
  new JsonStructureParser(text, maxDepth).parse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    canonicalStringify(parsed);
  } catch (error) {
    if (error instanceof StrictJsonError) throw error;
    throw new StrictJsonError("malformed_json");
  }
  return parsed as JsonValue;
}

export function decodeStrictUtf8(bytes: unknown): string {
  if (!(bytes instanceof Uint8Array)) throw new StrictJsonError("invalid_utf8");
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new StrictJsonError("utf8_bom_forbidden");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new StrictJsonError("invalid_utf8");
  }
}

export function canonicalJsonBytes(value: unknown, maxBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new StrictJsonError("json_too_large");
  let text: string;
  try {
    text = canonicalStringify(value);
  } catch {
    throw new StrictJsonError("malformed_json");
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) throw new StrictJsonError("json_too_large");
  parseStrictJson(text);
  return bytes;
}

export function validateCanonicalJsonBytes(bytes: unknown, maxBytes: number): JsonValue {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new StrictJsonError("malformed_json");
  }
  if (bytes.byteLength > maxBytes) throw new StrictJsonError("json_too_large");
  const text = decodeStrictUtf8(bytes);
  const parsed = parseStrictJson(text);
  if (canonicalStringify(parsed) !== text) throw new StrictJsonError("json_not_canonical");
  return parsed;
}
