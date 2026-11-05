import { describe, it, expect } from "vitest";
import {
  canonicalizeJson,
  escapeJsonString,
  sha256Hex,
  hashCanonicalJson,
} from "../../src/modules/common/canonical-json";
import { DomainValidationError } from "../../src/modules/common/errors";

describe("RFC 8785 JSON Canonicalization Scheme (JCS) & SHA-256", () => {
  describe("canonicalizeJson - Structure & Determinism", () => {
    it("sorts object keys strictly by UTF-16 code units", () => {
      // "10" (0x31 0x30) comes before "2" (0x32) in UTF-16 code unit order
      const obj = { "2": "two", "10": "ten", "a": "alpha" };
      expect(canonicalizeJson(obj)).toBe('{"10":"ten","2":"two","a":"alpha"}');

      // Unicode keys: "a" (0x61), "b" (0x62), "\u20ac" (0x20ac), "\ufffd" (0xfffd)
      const unicodeKeys = { "\u20ac": "euro", "b": 2, "a": 1, "\ufffd": "replacement" };
      expect(canonicalizeJson(unicodeKeys)).toBe('{"a":1,"b":2,"\u20ac":"euro","\ufffd":"replacement"}');
    });

    it("sorts nested object keys recursively", () => {
      const obj = {
        z: { y: 2, x: 1 },
        a: { c: 4, b: 3 },
      };
      expect(canonicalizeJson(obj)).toBe('{"a":{"b":3,"c":4},"z":{"x":1,"y":2}}');
    });

    it("preserves array element ordering", () => {
      const arr = [3, 1, 2];
      expect(canonicalizeJson(arr)).toBe("[3,1,2]");
    });

    it("handles primitives correctly", () => {
      expect(canonicalizeJson(null)).toBe("null");
      expect(canonicalizeJson(true)).toBe("true");
      expect(canonicalizeJson(false)).toBe("false");
      expect(canonicalizeJson("hello")).toBe('"hello"');
      expect(canonicalizeJson(123)).toBe("123");
    });
  });

  describe("RFC 8785 String Escaping & Unicode Validation", () => {
    it("escapes required characters strictly per RFC 8785 section 3.2.2.2", () => {
      expect(canonicalizeJson('quotation: "')).toBe('"quotation: \\""');
      expect(canonicalizeJson("backslash: \\")).toBe('"backslash: \\\\"');
      expect(canonicalizeJson("backspace: \b")).toBe('"backspace: \\b"');
      expect(canonicalizeJson("formfeed: \f")).toBe('"formfeed: \\f"');
      expect(canonicalizeJson("newline: \n")).toBe('"newline: \\n"');
      expect(canonicalizeJson("carriage return: \r")).toBe('"carriage return: \\r"');
      expect(canonicalizeJson("tab: \t")).toBe('"tab: \\t"');
      expect(canonicalizeJson("null byte: \x00")).toBe('"null byte: \\u0000"');
      expect(canonicalizeJson("unit separator: \x1f")).toBe('"unit separator: \\u001f"');
    });

    it("does NOT escape forward slashes or characters >= U+0020", () => {
      expect(canonicalizeJson("https://api.example.com/v1/payout")).toBe('"https://api.example.com/v1/payout"');
      expect(canonicalizeJson("Euro symbol: €")).toBe('"Euro symbol: €"');
      expect(canonicalizeJson("Japanese: 日本語")).toBe('"Japanese: 日本語"');
    });

    it("handles valid surrogate pairs correctly (e.g. Emoji, supplementary code points)", () => {
      // Grinning face: U+1F600 (\uD83D\uDE00)
      const emojiString = "Grinning face: 😀";
      expect(canonicalizeJson(emojiString)).toBe('"Grinning face: 😀"');

      // Musical symbol G clef: U+1D11E (\uD834\uDD1E)
      const musicalSymbol = "\uD834\uDD1E";
      expect(canonicalizeJson(musicalSymbol)).toBe('"\uD834\uDD1E"');
    });

    it("strictly rejects lone UTF-16 surrogates per RFC 8785 Section 3.2.2.2", () => {
      // Lone high surrogate at end
      expect(() => canonicalizeJson("\uD800")).toThrow(DomainValidationError);
      expect(() => canonicalizeJson("prefix \uD800")).toThrow(DomainValidationError);

      // Lone high surrogate followed by non-low-surrogate character
      expect(() => canonicalizeJson("\uD800abc")).toThrow(DomainValidationError);
      expect(() => canonicalizeJson("\uD800\uD800")).toThrow(DomainValidationError);

      // Lone low surrogate
      expect(() => canonicalizeJson("\uDC00")).toThrow(DomainValidationError);
      expect(() => canonicalizeJson("prefix \uDC00 suffix")).toThrow(DomainValidationError);

      // Reversed surrogate pair (low surrogate before high surrogate)
      expect(() => canonicalizeJson("\uDE00\uD83D")).toThrow(DomainValidationError);

      // Lone surrogate in object key
      expect(() => canonicalizeJson({ ["\uD800"]: "invalid" })).toThrow(DomainValidationError);
    });
  });

  describe("RFC 8785 Number Serialization (ECMA-262 7.1.12.1)", () => {
    it("normalizes -0 to 0", () => {
      expect(canonicalizeJson(-0)).toBe("0");
      expect(canonicalizeJson(0)).toBe("0");
    });

    it("serializes integers and floating point values according to ECMAScript standard", () => {
      expect(canonicalizeJson(1)).toBe("1");
      expect(canonicalizeJson(-1)).toBe("-1");
      expect(canonicalizeJson(1.5)).toBe("1.5");
      expect(canonicalizeJson(-1.5)).toBe("-1.5");
      expect(canonicalizeJson(0.000001)).toBe("0.000001");
      // Values requiring scientific notation in ECMAScript
      expect(canonicalizeJson(1e21)).toBe("1e+21");
      expect(canonicalizeJson(1e-7)).toBe("1e-7");
      expect(canonicalizeJson(1.23456789e-10)).toBe("1.23456789e-10");
    });

    it("strictly rejects non-finite numbers (NaN, Infinity, -Infinity)", () => {
      expect(() => canonicalizeJson(NaN)).toThrow(DomainValidationError);
      expect(() => canonicalizeJson(Infinity)).toThrow(DomainValidationError);
      expect(() => canonicalizeJson(-Infinity)).toThrow(DomainValidationError);
      expect(() => canonicalizeJson({ val: NaN })).toThrow(DomainValidationError);
      expect(() => canonicalizeJson([1, Infinity, 3])).toThrow(DomainValidationError);
    });
  });

  describe("Strict Rejection of Non-JSON Types & Prevention of Silent Omission/Conversion", () => {
    it("rejects undefined as root or nested value (prohibits silent omission)", () => {
      expect(() => canonicalizeJson(undefined)).toThrow(DomainValidationError);
      expect(() => canonicalizeJson({ a: 1, b: undefined })).toThrow(DomainValidationError);
    });

    it("rejects undefined in arrays (prohibits silent null conversion)", () => {
      expect(() => canonicalizeJson([1, undefined, 3])).toThrow(DomainValidationError);
    });

    it("rejects functions", () => {
      expect(() => canonicalizeJson(() => {})).toThrow(DomainValidationError);
      expect(() => canonicalizeJson({ fn: () => {} })).toThrow(DomainValidationError);
      expect(() => canonicalizeJson([() => {}])).toThrow(DomainValidationError);
    });

    it("rejects symbols", () => {
      const sym = Symbol("test");
      expect(() => canonicalizeJson(sym)).toThrow(DomainValidationError);
      expect(() => canonicalizeJson({ s: sym })).toThrow(DomainValidationError);
      expect(() => canonicalizeJson([sym])).toThrow(DomainValidationError);
    });

    it("rejects BigInt values (must be formatted as string or number prior to canonicalization)", () => {
      expect(() => canonicalizeJson(100n)).toThrow(DomainValidationError);
      expect(() => canonicalizeJson({ amount: 100n })).toThrow(DomainValidationError);
      expect(() => canonicalizeJson([100n])).toThrow(DomainValidationError);
    });

    it("rejects non-plain objects (Date, RegExp, Map, Set, Error)", () => {
      expect(() => canonicalizeJson(new Date())).toThrow(DomainValidationError);
      expect(() => canonicalizeJson({ date: new Date() })).toThrow(DomainValidationError);
      expect(() => canonicalizeJson(new RegExp("abc"))).toThrow(DomainValidationError);
      expect(() => canonicalizeJson(new Map())).toThrow(DomainValidationError);
      expect(() => canonicalizeJson(new Set())).toThrow(DomainValidationError);
      expect(() => canonicalizeJson(new Error("oops"))).toThrow(DomainValidationError);
    });

    it("rejects circular references", () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      expect(() => canonicalizeJson(circular)).toThrow(DomainValidationError);

      const circularArr: unknown[] = [];
      circularArr.push(circularArr);
      expect(() => canonicalizeJson(circularArr)).toThrow(DomainValidationError);
    });
  });

  describe("sha256Hex & hashCanonicalJson", () => {
    it("computes standard SHA-256 hex digest", () => {
      expect(sha256Hex("")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    });

    it("produces identical SHA-256 for identical canonicalized structures regardless of initial property order", () => {
      const objA = { title: "Test", amount: "100", active: true };
      const objB = { active: true, title: "Test", amount: "100" };

      const hashA = hashCanonicalJson(objA);
      const hashB = hashCanonicalJson(objB);

      expect(hashA).toBe(hashB);
      expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces different hash when any value changes", () => {
      const objA = { title: "Test", amount: "100" };
      const objB = { title: "Test", amount: "101" };

      expect(hashCanonicalJson(objA)).not.toBe(hashCanonicalJson(objB));
    });
  });
});
