import { createReconcileRoute } from "./route-handler";

export const runtime = "nodejs";

// GET exists so platform schedulers (e.g. Vercel Cron) can drive recovery;
// POST is the canonical invocation. Both share the same secret gate.
export const GET = createReconcileRoute();
export const POST = createReconcileRoute();
