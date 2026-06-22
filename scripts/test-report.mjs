// Consolidated, QUANTIFIED test report. Reads the per-layer metrics each runner
// emits (out/metrics/*.json), plus c8's coverage-summary.json and Stryker's
// mutation.json, and prints a single Markdown dashboard to stdout, writes it to
// out/test-report.md, and — in CI — appends it to the GitHub job summary
// ($GITHUB_STEP_SUMMARY) so every run shows: coverage %, fuzz rounds, mutation
// score (test strength), case counts, and every layer's wall time.
//
// Every input is optional: a layer not run this job simply shows "— not run".
// Run locally:  npm run test:report   (after running the layers you want shown)
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const OUT = "out";
const read = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const ms = (n) => (n == null ? "—" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const pct = (n) => (n == null ? "—" : `${n.toFixed(1)}%`);

const unit = read(`${OUT}/metrics/unit.json`);
const chaos = read(`${OUT}/metrics/chaos.json`);
const perf = read(`${OUT}/metrics/perf.json`);
const e2e = read(`${OUT}/metrics/e2e.json`);
const visual = read(`${OUT}/metrics/visual.json`);
const cov = read(`${OUT}/coverage/coverage-summary.json`);
const mut = read(`${OUT}/mutation/mutation.json`);

// --- coverage ---------------------------------------------------------------
let covLine, covStmt, covBranch, covFunc, covFiles, covZero;
if (cov && cov.total) {
  covLine = cov.total.lines.pct;
  covStmt = cov.total.statements.pct;
  covBranch = cov.total.branches.pct;
  covFunc = cov.total.functions.pct;
  const files = Object.keys(cov).filter((k) => k !== "total");
  covFiles = files.length;
  covZero = files
    .filter((k) => cov[k].lines.pct === 0)
    .map((k) => k.split("/").pop());
}

// --- mutation ---------------------------------------------------------------
let mutScore, mutKilled, mutSurvived, mutTimeout, mutNoCov, mutTotal, mutPerFile;
if (mut && mut.files) {
  mutKilled = mutSurvived = mutTimeout = mutNoCov = mutTotal = 0;
  mutPerFile = [];
  for (const [path, f] of Object.entries(mut.files)) {
    let k = 0, s = 0, t = 0, n = 0;
    for (const m of f.mutants) {
      if (m.status === "Killed") k++;
      else if (m.status === "Survived") s++;
      else if (m.status === "Timeout") t++;
      else if (m.status === "NoCoverage") n++;
    }
    mutKilled += k; mutSurvived += s; mutTimeout += t; mutNoCov += n;
    const denom = k + t + s + n;
    mutPerFile.push({ file: path.split("/").pop(), score: denom ? ((k + t) / denom) * 100 : 100, survived: s });
  }
  mutTotal = mutKilled + mutSurvived + mutTimeout + mutNoCov;
  const denom = mutTotal - mutNoCov;
  mutScore = denom ? ((mutKilled + mutTimeout) / denom) * 100 : 100;
}

// --- compose ----------------------------------------------------------------
let sha = process.env.GITHUB_SHA?.slice(0, 7);
try {
  if (!sha) sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {
  sha = "(unknown)";
}
const totalTestMs =
  (unit?.durationMs ?? 0) + (e2e?.durationMs ?? 0) + (visual?.durationMs ?? 0);

const L = [];
L.push(`# 🧪 Flintmark test report`);
L.push("");
L.push(`\`${sha}\` · node ${process.version} · ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`);
L.push("");
L.push(`| Layer | Result | Quantified | Time |`);
L.push(`| --- | --- | --- | --- |`);
L.push(
  `| **Unit (L1)** | ${unit ? (unit.failedFiles ? "❌" : "✅") : "—"} | ${unit ? `${unit.cases} cases · ${unit.testFiles} files` : "not run"} | ${ms(unit?.durationMs)} |`
);
L.push(
  `| **Chaos fuzz** | ${chaos ? (chaos.failures ? "❌" : "✅") : "—"} | ${chaos ? `${chaos.docsFuzzed.toLocaleString()} docs · ${chaos.runsPerPhase}×${chaos.phases} seeds · base ${chaos.baseSeed}` : "not run"} | ${ms(chaos?.durationMs)} |`
);
L.push(
  `| **Coverage** | ${cov ? "📊" : "—"} | ${cov ? `${pct(covLine)} lines · ${pct(covStmt)} stmts · ${covFiles} files` : "not run"} | — |`
);
L.push(
  `| **Mutation** | ${mut ? (mutScore >= 70 ? "✅" : "⚠️") : "—"} | ${mut ? `${pct(mutScore)} score · ${mutKilled}/${mutTotal} killed · ${mutSurvived} survived` : "nightly only"} | — |`
);
L.push(
  `| **Integration+E2E (L2/L3)** | ${e2e ? (e2e.failed ? "❌" : "✅") : "—"} | ${e2e ? `${e2e.tests} tests · ${e2e.passed} passed` : "not run"} | ${ms(e2e?.durationMs)} |`
);
L.push(
  `| **Visual** | ${visual ? (visual.failed ? "❌" : "✅") : "—"} | ${visual ? `${visual.snapshots} snapshots · max diff ${(visual.maxDiffRatio * 100).toFixed(2)}%` : "not run"} | ${ms(visual?.durationMs)} |`
);
L.push(
  `| **Perf** | ${perf ? "📈" : "—"} | ${perf ? `${perf.sizes.length} sizes · whole-document/fallback` : "not run"} | ${ms(perf?.durationMs)} |`
);
L.push("");
L.push(`_Total test wall time (unit + e2e + visual): **${ms(totalTestMs)}**_`);

if (cov) {
  L.push("");
  L.push(`## 📊 Coverage (c8)`);
  L.push(`statements ${pct(covStmt)} · lines ${pct(covLine)}`);
  if (covBranch > 0 || covFunc > 0) {
    L.push(`branches ${pct(covBranch)} · functions ${pct(covFunc)}`);
  } else {
    L.push(`_(branch/function % aren't reliably measurable through the esbuild bundle — mutation score is the real branch-strength signal.)_`);
  }
  if (covZero?.length) {
    L.push("");
    L.push(`<details><summary>${covZero.length} file(s) with 0% coverage (host/wiring — exercised only via L2/L3)</summary>`);
    L.push("");
    L.push(covZero.map((f) => `\`${f}\``).join(", "));
    L.push("");
    L.push(`</details>`);
  }
}

if (mut) {
  L.push("");
  L.push(`## 🧬 Mutation (Stryker) — test STRENGTH`);
  L.push(`**${pct(mutScore)}** mutation score — ${mutKilled} killed · ${mutSurvived} survived · ${mutTimeout} timeout · ${mutTotal} mutants.`);
  L.push(`> ${mutSurvived} survivors are behaviours line coverage couldn't see — the gap between "covered" and "tested".`);
  L.push("");
  L.push(`| File | Score | Survived |`);
  L.push(`| --- | --- | --- |`);
  for (const f of mutPerFile.sort((a, b) => a.score - b.score))
    L.push(`| \`${f.file}\` | ${pct(f.score)} | ${f.survived} |`);
}

if (perf) {
  L.push("");
  L.push(`## 📈 Perf — buildDecorations median`);
  L.push(`| Document | Mode | Median |`);
  L.push(`| --- | --- | --- |`);
  for (const s of perf.sizes) {
    L.push(
      `| ${s.label} (${s.docChars.toLocaleString()} chars) | ${s.previewActive === false ? "source fallback" : "whole-document preview"} | ${s.medianMs} ms |`
    );
  }
}

const report = L.join("\n") + "\n";
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/test-report.md`, report);
process.stdout.write("\n" + report + "\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  } catch {
    /* best-effort */
  }
}
