/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) Implementation & SHA-256 Hashing
 *
 * Implements deterministic serialization of JSON data strictly according to RFC 8785:
 * - Deterministic UTF-16 code unit key sorting
 * - Elimination of all insignificant whitespace
 * - Standardized string escaping (only quotes, backslashes, and control characters U+0000..U+001F)
 * - Strict rejection of invalid Unicode (lone UTF-16 surrogates)
 * - Normalization of numbers (including -0 -> "0") per ECMAScript / RFC 8785 Section 3.2.2.3
 * - Strict rejection of non-JSON types (undefined, functions, symbols, BigInt, Date objects)
 * - No silent omission of unsupported object properties or conversion of array elements to null
 * - Deterministic SHA-256 digest computation
 */

import { createHash } from "node:crypto";
import { DomainValidationError } from "./errors";

/**
 * Escapes a string strictly adhering to RFC 8785 section 3.2.2.2.
 * Validates Unicode: lone UTF-16 surrogates are strictly rejected.
 * Only quotes, backslashes, and control characters (U+0000..U+001F) are escaped.
 * Forward slashes and Unicode characters >= U+0020 are NOT escaped.
 */
export function escapeJsonString(str: string): string {
  let result = '"';
  const len = str.length;

  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);

    // RFC 8785 Section 3.2.2.2: Reject lone surrogates
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: MUST be immediately followed by a low surrogate (0xdc00..0xdfff)
      if (i + 1 < len) {
        const nextCode = str.charCodeAt(i + 1);
        if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          // Valid surrogate pair
          result += str[i]! + str[i + 1]!;
          i++; // Skip the paired low surrogate
          continue;
        }
      }
      throw new DomainValidationError(
        `Invalid Unicode: lone high surrogate U+${code.toString(16).toUpperCase().padStart(4, "0")} at position ${i}`
      );
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Unpaired low surrogate
      throw new DomainValidationError(
        `Invalid Unicode: lone low surrogate U+${code.toString(16).toUpperCase().padStart(4, "0")} at position ${i}`
      );
    }

    switch (code) {
      case 0x22: // "
        result += '\\"';
        break;
      case 0x5c: // \
        result += "\\\\";
        break;
      case 0x08: // \b
        result += "\\b";
        break;
      case 0x09: // \t
        result += "\\t";
        break;
      case 0x0a: // \n
        result += "\\n";
        break;
      case 0x0c: // \f
        result += "\\f";
        break;
      case 0x0d: // \r
        result += "\\r";
        break;
      default:
        if (code < 0x20) {
          result += "\\u00" + code.toString(16).padStart(2, "0");
        } else {
          result += str[i]!;
        }
        break;
    }
  }

  result += '"';
  return result;
}

/**
 * Serializes a number strictly adhering to RFC 8785 section 3.2.2.3 and ECMA-262 7.1.12.1.
 * Prohibits NaN and Infinity. Normalizes -0 to 0.
 */
function serializeNumber(num: number): string {
  if (!Number.isFinite(num)) {
    throw new DomainValidationError(`Cannot canonicalize non-finite number: ${num}`);
  }
  // RFC 8785 section 3.2.2.3: -0 MUST be serialized as "0"
  if (Object.is(num, -0)) {
    return "0";
  }
  return num.toString();
}

function serializeValue(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return serializeNumber(value);
  }

  if (typeof value === "string") {
    return escapeJsonString(value);
  }

  // Strict rejection of non-JSON primitive types
  if (value === undefined) {
    throw new DomainValidationError(`Unsupported non-JSON value 'undefined' at ${path}`);
  }

  if (typeof value === "function") {
    throw new DomainValidationError(`Unsupported non-JSON value of type 'function' at ${path}`);
  }

  if (typeof value === "symbol") {
    throw new DomainValidationError(`Unsupported non-JSON value of type 'symbol' at ${path}`);
  }

  if (typeof value === "bigint") {
    throw new DomainValidationError(
      `Unsupported non-JSON value of type 'bigint' (${value}n) at ${path}. BigInt values must be explicitly converted to strings or numbers before JSON canonicalization.`
    );
  }

  if (typeof value === "object") {
    // Rejection of non-JSON object types
    if (value instanceof Date) {
      throw new DomainValidationError(`Unsupported non-JSON value Date instance at ${path}`);
    }
    if (value instanceof RegExp) {
      throw new DomainValidationError(`Unsupported non-JSON value RegExp instance at ${path}`);
    }
    if (value instanceof Map || value instanceof Set) {
      throw new DomainValidationError(`Unsupported non-JSON collection (Map/Set) at ${path}`);
    }
    if (value instanceof Error) {
      throw new DomainValidationError(`Unsupported non-JSON Error instance at ${path}`);
    }

    if (seen.has(value)) {
      throw new DomainValidationError(`Circular reference detected at ${path}`);
    }
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        const elements: string[] = [];
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (
            item === undefined ||
            typeof item === "function" ||
            typeof item === "symbol" ||
            typeof item === "bigint"
          ) {
            throw new DomainValidationError(
              `Array at ${path}[${i}] contains unsupported non-JSON value of type '${typeof item}'. Silent null conversion is prohibited.`
            );
          }
          elements.push(serializeValue(item, seen, `${path}[${i}]`));
        }
        return `[${elements.join(",")}]`;
      }

      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) {
        throw new DomainValidationError(
          `Custom class instance or unsupported object prototype at ${path}`
        );
      }

      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);

      // Validate all property values first (reject unsupported properties; no silent omission)
      for (const key of keys) {
        const v = obj[key];
        if (
          v === undefined ||
          typeof v === "function" ||
          typeof v === "symbol" ||
          typeof v === "bigint"
        ) {
          throw new DomainValidationError(
            `Object property '${key}' at ${path}.${key} contains unsupported non-JSON value of type '${typeof v}'. Silent omission is prohibited.`
          );
        }
      }

      // RFC 8785 Section 3.2.3: Keys MUST be sorted by UTF-16 code units
      keys.sort((a, b) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      });

      const pairs: string[] = [];
      for (const key of keys) {
        const escapedKey = escapeJsonString(key);
        const serializedVal = serializeValue(obj[key], seen, `${path}.${key}`);
        pairs.push(`${escapedKey}:${serializedVal}`);
      }

      return `{${pairs.join(",")}}`;
    } finally {
      seen.delete(value);
    }
  }

  throw new DomainValidationError(`Unsupported data type for JSON canonicalization: ${typeof value} at ${path}`);
}

/**
 * Pure RFC 8785 JSON Canonicalization Scheme (JCS) serializer.
 * Recursively canonicalizes any JSON-compatible data structure.
 */
export function canonicalizeJson(value: unknown): string {
  const seen = new Set<object>();
  return serializeValue(value, seen, "$");
}

/**
 * Computes a SHA-256 hash of UTF-8 data, returning a 64-character lowercase hex string.
 */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Canonicalizes data using RFC 8785 and computes its SHA-256 hex digest.
 */
export function hashCanonicalJson(data: unknown): string {
  const canonical = canonicalizeJson(data);
  return sha256Hex(canonical);
}
