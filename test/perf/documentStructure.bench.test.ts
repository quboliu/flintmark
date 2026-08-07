// Active-document structure benchmark. This is intentionally excluded from the
// normal unit suite and run by `npm run test:perf`. The generous guard catches
// accidental quadratic scans without making ordinary CI load a source of flakes.
import assert from "node:assert";
import { parseDocumentStructure } from "../../src/extension/documentStructureParser";

const CATASTROPHIC_MS = 1500;

function makeDocument(lines: number): string {
  const palette = [
    "# Heading",
    "plain text with **formatting**",
    "- [ ] pending task",
    "  - [/] nested task",
    "```md\n- [ ] fenced fake\n```",
    "> - [x] quoted done task",
  ];
  const output: string[] = [];
  for (let index = 0; index < lines; index++) {
    output.push(palette[index % palette.length]);
  }
  return output.join("\n");
}

for (const lines of [100, 1_000, 10_000]) {
  const text = makeDocument(lines);
  for (let warmup = 0; warmup < 2; warmup++) parseDocumentStructure(text);
  const samples: number[] = [];
  for (let run = 0; run < 9; run++) {
    const started = process.hrtime.bigint();
    parseDocumentStructure(text);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(
    `  structure ${String(lines).padStart(6)} lines / ${String(text.length).padStart(7)} chars: ${median.toFixed(2)} ms median`
  );
  assert.ok(
    median < CATASTROPHIC_MS,
    `${lines} lines took ${median.toFixed(0)}ms (guard ${CATASTROPHIC_MS}ms)`
  );
}

console.log("document structure benchmark complete");
