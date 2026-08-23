import { z } from "zod";

/**
 * POR-20: the testable AI contract for the ₹199 Roast.
 *
 * The provider enforces shape (strict structured output); this module is the
 * source of truth and re-validates every response locally before anything is
 * persisted. Counts, ranges and string lengths are enforced HERE, not in the
 * provider schema, so a model that under- or over-produces fails closed.
 */

export const CRITIQUE_COUNT = 5;
export const MIN_SCORE = 0;
export const MAX_SCORE = 100;

const headline = z.string().trim().min(8).max(90);
const explanation = z.string().trim().min(20).max(600);
const evidence = z.string().trim().min(10).max(400);
const conversionImpact = z.string().trim().min(10).max(300);

export const critiqueSchema = z.object({
  headline,
  explanation,
  evidence,
  conversionImpact,
});

export const positiveObservationSchema = z.object({
  headline,
  explanation,
});

export const roastReportSchema = z.object({
  score: z.number().int().min(MIN_SCORE).max(MAX_SCORE),
  critiques: z.array(critiqueSchema).length(CRITIQUE_COUNT),
  positiveObservation: positiveObservationSchema,
});

export type RoastCritique = z.infer<typeof critiqueSchema>;
export type RoastPositiveObservation = z.infer<
  typeof positiveObservationSchema
>;
export type RoastReport = z.infer<typeof roastReportSchema>;

/** Customer-facing verdict bands. Derived deterministically from the score. */
export const VERDICT_BANDS = [
  { maxScore: 39, verdict: "Brutal" },
  { maxScore: 59, verdict: "Rough" },
  { maxScore: 74, verdict: "Fixable" },
  { maxScore: 89, verdict: "Solid" },
  { maxScore: MAX_SCORE, verdict: "Sharp" },
] as const;

export type Verdict = (typeof VERDICT_BANDS)[number]["verdict"];

export function verdictForScore(score: number): Verdict {
  for (const band of VERDICT_BANDS) {
    if (score <= band.maxScore) return band.verdict;
  }
  return VERDICT_BANDS[VERDICT_BANDS.length - 1].verdict;
}

/** The complete customer deliverable: model output + derived verdict. */
export const storedReportSchema = roastReportSchema.extend({
  verdict: z.enum(["Brutal", "Rough", "Fixable", "Solid", "Sharp"]),
});
export type StoredRoastReport = z.infer<typeof storedReportSchema>;

export function withVerdict(report: RoastReport): StoredRoastReport {
  return { ...report, verdict: verdictForScore(report.score) };
}

/**
 * Provider-side schema for OpenAI strict structured output. Intentionally
 * looser than the local schema: strict mode rejects unsupported constraints
 * (minItems/maxItems), so counts are enforced locally instead. Every property
 * is required and additionalProperties is false, as strict mode demands.
 */
export const providerReportJsonSchema = {
  type: "object",
  properties: {
    score: { type: "integer" },
    critiques: {
      type: "array",
      items: {
        type: "object",
        properties: {
          headline: { type: "string" },
          explanation: { type: "string" },
          evidence: { type: "string" },
          conversionImpact: { type: "string" },
        },
        required: ["headline", "explanation", "evidence", "conversionImpact"],
        additionalProperties: false,
      },
    },
    positiveObservation: {
      type: "object",
      properties: {
        headline: { type: "string" },
        explanation: { type: "string" },
      },
      required: ["headline", "explanation"],
      additionalProperties: false,
    },
  },
  required: ["score", "critiques", "positiveObservation"],
  additionalProperties: false,
} as const;
