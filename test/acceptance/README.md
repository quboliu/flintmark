# Full release acceptance

This suite preserves the functional and stress checks used during 0.33.1 local
acceptance and makes them portable to hosted runners. The historical local
results remain separate evidence. Importing the harness does not mean a hosted
platform has passed.

The matrix uses Ubuntu x64, Windows x64, Windows ARM64, and macOS ARM64. Every
platform runs VS Code, VSCodium, and Cursor independently. Antigravity is excluded
because account login is outside the agreed scope.

Each editor runs 13 stages:

- Real extension-host integration tests.
- 93 native scroll-anchor scenarios and six wheel-observer controls.
- Eight functional groups: Live Preview, Todo, external updates, themes, image
  index lifecycle, issue regressions, pane synchronization, and CRLF boundaries.
- Fourteen adversarial corpus files, with 42 exact edit/save checks. The corpus
  includes Unicode, malformed markup, long lines, nested lists, tables, code,
  images, and 1/5/12 MiB LF/CRLF files. Files beyond the Live Preview size limit
  intentionally use the source editor; their saved bytes must still match.
- A workspace with 20,000 notes and 4,200 images while an independent process
  creates and removes files every 25 ms. Editor identity, selection, autocomplete,
  writer errors, and clean shutdown are checked.

The Live Preview wheel check retains its 200 gestures, at least 180 matched
positions, at most one pixel of visible position error, and at most 500 ms of
browser progress latency. Measurements use the existing observer controls;
slow runners are not excused by silently loosening the thresholds.

## Run locally

Use an isolated development VM with a graphical session (or Xvfb on Linux).
Install dependencies with `npm ci`, build with `npm run compile` and
`npm run build:test`, then prepare a clean candidate:

```sh
mkdir -p candidate
npx @vscode/vsce package --out candidate/
node scripts/ci/candidate-manifest.mjs
export FLINTMARK_EDITOR=vscode
export VSCODE_BIN=/absolute/path/to/the/editor/executable
npm run test:acceptance
# On Linux: xvfb-run -a -s '-screen 0 1600x1200x24' npm run test:acceptance
```

`candidate-manifest.mjs` uses `unzip` while preparing the package. Hosted CI builds
it once on Linux; all other runners download that same candidate. The suite
requires the candidate source commit to match the current checkout and verifies
every installed runtime hash. Use a fresh output directory for each run; previous
results are never silently overwritten. Keep local screenshots and logs for
visual review alongside the assertions.

## Evidence and publication

Each stage preserves its complete runner log. Functional diagnostics, screenshots,
saved-file copies and hashes, native/observer results, editor download metadata,
and the installed package identity are uploaded as Actions artifacts. Corpus
final files are kept; temporary extension installations and workspaces are
excluded from uploads. Pixel-perfect screenshot baselines are environment-specific;
the suite uses DOM/geometry/content assertions and captures screenshots for review.

Every matrix member must have one successful summary for the same source and VSIX.
Missing, skipped, failed, or cancelled jobs block the aggregate gate. No test retry
is hidden. The release workflow downloads and publishes the already accepted
candidate; it never rebuilds the VSIX after the matrix passes.
