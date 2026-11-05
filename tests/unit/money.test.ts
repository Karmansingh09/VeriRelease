import { describe, it, expect } from "vitest";
import {
  SUPPORTED_CURRENCIES,
  CURRENCY_DATASET_VERSION,
  isSupportedCurrency,
  getCurrencyExponent,
  parseMajorToMinor,
  formatMinorToMajor,
  createMoney,
  addMoney,
  subtractMoney,
  sumMoney,
  supportedCurrencySchema,
  minorUnitsSchema,
  moneySchema,
  type Money,
} from "../../src/modules/common/money";
import {
  UnsupportedCurrencyError,
  InvalidMoneyError,
} from "../../src/modules/common/errors";

describe("Money Utilities & Multi-Currency System", () => {
  it("exports exact dataset version", () => {
    expect(CURRENCY_DATASET_VERSION).toBe("ISO-4217-MA-2024-01-01");
  });

  it("supports exactly 18 currencies", () => {
    expect(SUPPORTED_CURRENCIES).toHaveLength(18);
    expect(SUPPORTED_CURRENCIES).toEqual([
      "USD", "EUR", "GBP", "CAD", "AUD", "CHF", "SGD", "HKD", "NZD", "SEK", "NOK", "DKK", "PLN",
      "JPY", "KRW",
      "BHD", "KWD", "OMR",
    ]);
  });

  describe("Exponent mapping", () => {
    it("correctly identifies 2-decimal currencies", () => {
      expect(getCurrencyExponent("USD")).toBe(2);
      expect(getCurrencyExponent("EUR")).toBe(2);
      expect(getCurrencyExponent("GBP")).toBe(2);
      expect(getCurrencyExponent("CAD")).toBe(2);
    });

    it("correctly identifies 0-decimal currencies (JPY, KRW)", () => {
      expect(getCurrencyExponent("JPY")).toBe(0);
      expect(getCurrencyExponent("KRW")).toBe(0);
    });

    it("correctly identifies 3-decimal currencies (BHD, KWD, OMR)", () => {
      expect(getCurrencyExponent("BHD")).toBe(3);
      expect(getCurrencyExponent("KWD")).toBe(3);
      expect(getCurrencyExponent("OMR")).toBe(3);
    });

    it("throws UnsupportedCurrencyError for invalid currencies", () => {
      // @ts-expect-error testing invalid currency
      expect(() => getCurrencyExponent("XYZ")).toThrow(UnsupportedCurrencyError);
      // @ts-expect-error testing invalid currency
      expect(() => getCurrencyExponent("INR")).toThrow(UnsupportedCurrencyError);
    });
  });

  describe("parseMajorToMinor", () => {
    it("parses 2-decimal currencies without floating point inaccuracies", () => {
      expect(parseMajorToMinor("100.50", "USD")).toBe(10050n);
      expect(parseMajorToMinor("0.01", "USD")).toBe(1n);
      expect(parseMajorToMinor("100", "EUR")).toBe(10000n);
      expect(parseMajorToMinor("123.4", "GBP")).toBe(12340n);
      expect(parseMajorToMinor("0.1", "USD")).toBe(10n);
      expect(parseMajorToMinor("0.05", "USD")).toBe(5n);
      // Classic float bug: 0.1 + 0.2
      expect(parseMajorToMinor("0.30", "USD")).toBe(30n);
    });

    it("parses 0-decimal currencies (JPY, KRW)", () => {
      expect(parseMajorToMinor("1000", "JPY")).toBe(1000n);
      expect(parseMajorToMinor("50000", "KRW")).toBe(50000n);
      expect(parseMajorToMinor("0", "JPY")).toBe(0n);
    });

    it("rejects fractional amounts for 0-decimal currencies", () => {
      expect(() => parseMajorToMinor("1000.50", "JPY")).toThrow(InvalidMoneyError);
      expect(() => parseMajorToMinor("500.01", "KRW")).toThrow(InvalidMoneyError);
    });

    it("parses 3-decimal currencies (BHD, KWD, OMR)", () => {
      expect(parseMajorToMinor("1.500", "KWD")).toBe(1500n);
      expect(parseMajorToMinor("2.125", "BHD")).toBe(2125n);
      expect(parseMajorToMinor("0.001", "OMR")).toBe(1n);
      expect(parseMajorToMinor("10.5", "KWD")).toBe(10500n);
      expect(parseMajorToMinor("10.25", "BHD")).toBe(10250n);
    });

    it("rejects excessive decimal places beyond exponent", () => {
      expect(() => parseMajorToMinor("100.555", "USD")).toThrow(InvalidMoneyError);
      expect(() => parseMajorToMinor("1.1234", "KWD")).toThrow(InvalidMoneyError);
    });

    it("rejects negative amounts, scientific notation, and malformed strings", () => {
      expect(() => parseMajorToMinor("-50.00", "USD")).toThrow(InvalidMoneyError);
      expect(() => parseMajorToMinor("1e5", "USD")).toThrow(InvalidMoneyError);
      expect(() => parseMajorToMinor("NaN", "USD")).toThrow(InvalidMoneyError);
      expect(() => parseMajorToMinor("abc", "USD")).toThrow(InvalidMoneyError);
      expect(() => parseMajorToMinor("", "USD")).toThrow(InvalidMoneyError);
      expect(() => parseMajorToMinor(".", "USD")).toThrow(InvalidMoneyError);
    });

    it("rejects unsupported currencies", () => {
      // @ts-expect-error testing invalid currency
      expect(() => parseMajorToMinor("100.00", "ABC")).toThrow(UnsupportedCurrencyError);
    });
  });

  describe("formatMinorToMajor", () => {
    it("formats 2-decimal currencies accurately", () => {
      expect(formatMinorToMajor(10050n, "USD")).toBe("100.50");
      expect(formatMinorToMajor(1n, "USD")).toBe("0.01");
      expect(formatMinorToMajor(10n, "USD")).toBe("0.10");
      expect(formatMinorToMajor(0n, "EUR")).toBe("0.00");
      expect(formatMinorToMajor(1234567n, "GBP")).toBe("12345.67");
    });

    it("formats 0-decimal currencies accurately", () => {
      expect(formatMinorToMajor(1000n, "JPY")).toBe("1000");
      expect(formatMinorToMajor(0n, "KRW")).toBe("0");
      expect(formatMinorToMajor(54321n, "JPY")).toBe("54321");
    });

    it("formats 3-decimal currencies accurately", () => {
      expect(formatMinorToMajor(1500n, "KWD")).toBe("1.500");
      expect(formatMinorToMajor(1n, "BHD")).toBe("0.001");
      expect(formatMinorToMajor(25n, "OMR")).toBe("0.025");
      expect(formatMinorToMajor(2125n, "BHD")).toBe("2.125");
    });

    it("rejects negative minor units", () => {
      expect(() => formatMinorToMajor(-100n, "USD")).toThrow(InvalidMoneyError);
    });

    it("rejects unsupported currencies", () => {
      // @ts-expect-error testing invalid currency
      expect(() => formatMinorToMajor(100n, "XYZ")).toThrow(UnsupportedCurrencyError);
    });
  });

  describe("Currency-Aware Money Arithmetic (addMoney, subtractMoney, sumMoney)", () => {
    const mUSD100 = createMoney(10000n, "USD");
    const mUSD50 = createMoney(5000n, "USD");
    const mEUR50 = createMoney(5000n, "EUR");
    const mJPY1000 = createMoney(1000n, "JPY");

    it("creates valid Money representations", () => {
      expect(mUSD100).toEqual({ amountMinorUnits: 10000n, currency: "USD" });
      expect(() => createMoney(-1n, "USD")).toThrow(InvalidMoneyError);
      // @ts-expect-error testing invalid currency
      expect(() => createMoney(100n, "XYZ")).toThrow(UnsupportedCurrencyError);
    });

    describe("Same-currency addition", () => {
      it("adds amounts in the same currency correctly", () => {
        const sum = addMoney(mUSD100, mUSD50);
        expect(sum).toEqual({ amountMinorUnits: 15000n, currency: "USD" });
      });

      it("handles zero and large BigInt values correctly", () => {
        const zeroUSD = createMoney(0n, "USD");
        expect(addMoney(mUSD100, zeroUSD)).toEqual(mUSD100);

        const largeA = createMoney(9007199254740991000n, "USD");
        const largeB = createMoney(1000000000000000000n, "USD");
        const largeSum = addMoney(largeA, largeB);
        expect(largeSum).toEqual({
          amountMinorUnits: 10007199254740991000n,
          currency: "USD",
        });
      });
    });

    describe("Same-currency subtraction", () => {
      it("subtracts amounts in the same currency correctly", () => {
        const diff = subtractMoney(mUSD100, mUSD50);
        expect(diff).toEqual({ amountMinorUnits: 5000n, currency: "USD" });
      });

      it("allows subtraction resulting in exact zero balance", () => {
        const diff = subtractMoney(mUSD100, mUSD100);
        expect(diff).toEqual({ amountMinorUnits: 0n, currency: "USD" });
      });

      it("strictly rejects subtraction resulting in negative balance", () => {
        expect(() => subtractMoney(mUSD50, mUSD100)).toThrow(InvalidMoneyError);
      });
    });

    describe("Cross-currency arithmetic rejection", () => {
      it("rejects addition of different currencies", () => {
        expect(() => addMoney(mUSD100, mEUR50)).toThrow(InvalidMoneyError);
        expect(() => addMoney(mUSD100, mJPY1000)).toThrow(InvalidMoneyError);
      });

      it("rejects subtraction of different currencies", () => {
        expect(() => subtractMoney(mUSD100, mEUR50)).toThrow(InvalidMoneyError);
        expect(() => subtractMoney(mUSD100, mJPY1000)).toThrow(InvalidMoneyError);
      });
    });

    describe("Summation (sumMoney)", () => {
      it("sums multiple Money items in the same currency", () => {
        const items: Money[] = [
          createMoney(100n, "USD"),
          createMoney(200n, "USD"),
          createMoney(300n, "USD"),
        ];
        expect(sumMoney(items)).toEqual({ amountMinorUnits: 600n, currency: "USD" });
      });

      it("rejects summation if any item has a mismatched currency", () => {
        const mixedItems: Money[] = [
          createMoney(100n, "USD"),
          createMoney(200n, "EUR"),
          createMoney(300n, "USD"),
        ];
        expect(() => sumMoney(mixedItems)).toThrow(InvalidMoneyError);
      });

      it("sums empty array when default currency is specified", () => {
        expect(sumMoney([], "USD")).toEqual({ amountMinorUnits: 0n, currency: "USD" });
      });

      it("rejects empty array sum when no default currency is provided", () => {
        expect(() => sumMoney([])).toThrow(InvalidMoneyError);
      });
    });
  });

  describe("Zod schemas", () => {
    it("validates supported currencies", () => {
      expect(supportedCurrencySchema.parse("USD")).toBe("USD");
      expect(supportedCurrencySchema.parse("JPY")).toBe("JPY");
      expect(supportedCurrencySchema.parse("KWD")).toBe("KWD");
      expect(() => supportedCurrencySchema.parse("BTC")).toThrow();
    });

    it("validates minorUnitsSchema", () => {
      expect(minorUnitsSchema.parse(100n)).toBe(100n);
      expect(minorUnitsSchema.parse(0n)).toBe(0n);
      expect(() => minorUnitsSchema.parse(-1n)).toThrow();
    });

    it("validates moneySchema", () => {
      expect(moneySchema.parse({ amountMinorUnits: 500n, currency: "USD" })).toEqual({
        amountMinorUnits: 500n,
        currency: "USD",
      });
      expect(() => moneySchema.parse({ amountMinorUnits: -1n, currency: "USD" })).toThrow();
      expect(() => moneySchema.parse({ amountMinorUnits: 100n, currency: "XYZ" })).toThrow();
    });
  });
});
