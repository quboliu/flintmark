// Opt-in diagnostics for isolated acceptance runs; disabled in normal use.
import { appendFileSync } from "node:fs";
const destination = process.env.FLINTMARK_TEST_INDEX_TRACE;
const started = performance.now();
let records = 0;
export function indexTrace(event: string, fields: Record<string, unknown> = {}): void {
  if (!destination || records++ >= 20000) return;
  try { appendFileSync(destination, JSON.stringify({event,elapsedMs:performance.now()-started,...fields}) + "\n"); }
  catch { /* Diagnostic I/O must not change indexing behavior. */ }
}
