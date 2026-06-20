# Chaos regression corpus

Every `*.md` file in this directory is replayed verbatim by the chaos suite
(`test/chaos/fuzz.test.ts`) on every run, BEFORE the random sweep. This is the
durable "capture every error" net: once a fuzz run finds an input that breaks an
invariant, promote that input here and it is checked forever — independent of
later changes to the generator or the token palette.

## Workflow

1. A chaos run fails. It saves the offending input to `out/chaos-crashes/<replay>.md`
   and prints a `REPLAY:` line (e.g. `FUZZ_SEED=439041101 FUZZ_ITER=837 (soup)`).
2. Reproduce it deterministically: `FUZZ_SEED=<base> FUZZ_ITER=<i> node test/run-unit.mjs test/chaos`.
3. Fix the bug.
4. Promote the saved crash input into this folder so it is a permanent regression:
   `mv out/chaos-crashes/<file>.md test/chaos/corpus/<short-name>.md`

The leading `<!-- chaos crash ... -->` comment in a saved crash file is harmless
to the parser and records where it came from; you may keep or trim it.
