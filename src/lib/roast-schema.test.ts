import { describe, expect, it } from "vitest";

import {
  roastReportSchema,
  storedReportSchema,
  verdictForScore,
  withVerdict,
  providerReportJsonSchema,
  CRITIQUE_COUNT,
} from "./roast-schema";

function validReport() {
  return {
    score: 47,
    critiques: Array.from({ length: CRITIQUE_COUNT }, (_, i) => ({
      headline: `Hero section buries the offer ${i + 1}`,
      explanation:
        "The primary value proposition sits below two screens of scroll, so paid visitors never read it.",
      evidence: "Above-the-fold area shows only a logo and a newsletter field.",
      conversionImpact: "Paid traffic bounces before understanding the offer.",
    })),
    positiveObservation: {
      headline: "Contrast on the primary button is strong",
      explanation:
        "The call-to-action uses a high-contrast palette that remains legible against the background.",
    },
  };
}

describe("POR-20 CRO rubric contract", () => {
  it("accepts a well-formed five-critique report and derives the verdict", () => {
    const parsed = roastReportSchema.parse(validReport());
    const stored = withVerdict(parsed);
    expect(stored.verdict).toBe("Rough");
    expect(storedReportSchema.safeParse(stored).success).toBe(true);
  });

  it("rejects any critique count other than exactly five", () => {
    const base = validReport();
    for (const count of [0, 1, 4, 6]) {
      const report = {
        ...base,
        critiques:
          count <= base.critiques.length
            ? base.critiques.slice(0, count)
            : [
                ...base.critiques,
                {
                  ...base.critiques[0],
                  headline: "Extra critique beyond five",
                },
              ],
      };
      expect(roastReportSchema.safeParse(report).success).toBe(false);
    }
  });

  it("bounds the score to the integer range 0-100", () => {
    for (const score of [-1, 101, 47.5]) {
      expect(
        roastReportSchema.safeParse({ ...validReport(), score }).success,
      ).toBe(false);
    }
    expect(
      roastReportSchema.safeParse({ ...validReport(), score: 0 }).success,
    ).toBe(true);
    expect(
      roastReportSchema.safeParse({ ...validReport(), score: 100 }).success,
    ).toBe(true);
  });

  it("requires every critique field with minimum substance", () => {
    const report = validReport();
    (report.critiques[0] as { headline: string }).headline = "short";
    expect(roastReportSchema.safeParse(report).success).toBe(false);
  });

  it("maps score bands to verdicts deterministically", () => {
    expect(verdictForScore(0)).toBe("Brutal");
    expect(verdictForScore(39)).toBe("Brutal");
    expect(verdictForScore(40)).toBe("Rough");
    expect(verdictForScore(60)).toBe("Fixable");
    expect(verdictForScore(74)).toBe("Fixable");
    expect(verdictForScore(75)).toBe("Solid");
    expect(verdictForScore(90)).toBe("Sharp");
    expect(verdictForScore(100)).toBe("Sharp");
  });

  it("keeps the provider schema strict-mode compatible", () => {
    expect(providerReportJsonSchema.additionalProperties).toBe(false);
    expect(providerReportJsonSchema.required).toEqual([
      "score",
      "critiques",
      "positiveObservation",
    ]);
    // Strict mode cannot enforce array bounds; counts are local-only rules.
    expect(providerReportJsonSchema.properties.critiques).not.toHaveProperty(
      "minItems",
    );
  });
});
