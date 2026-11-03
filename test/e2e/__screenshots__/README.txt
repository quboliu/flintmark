Visual snapshot environment (2026-11-01)

These four element screenshots are the local visual gate for the maintained Talos environment: Debian 13.7 ARM64, VSCodium 1.143.17232, default Xvfb display, DejaVu Sans/DejaVu Sans Mono. They are environment-specific, as documented in visual.e2e.mjs. The pixelmatch threshold remains 0.1 and the differing-pixel budget remains 1%.

Before this refresh, all four committed images failed on the current environment. We rebuilt their original source commit 3390cbe, a Find-only control at 9bdcbf0, and release candidate bba26f8. The original source produced the same current heading, callout title, and table images. Its checkbox differed from the candidate in one antialiased edge pixel, with zero differences under the existing pixelmatch threshold. Candidate and Find-only control images were byte-identical across two runs for all four targets. No rendering code or thresholds were changed for this refresh.

Visual inspection confirmed an unclipped heading, readable warning title and accent, aligned table headers/cells, and an intact unchecked checkbox. Coverage is limited to these four elements; the callout screenshot covers its title, not the full body. The source and original images remain in Git history.

Reproduce with the maintained editor binary:
  VSCODE_BIN=/mnt/ironfleet/flintmark/.cache/vscodium/app/codium TMPDIR=/var/tmp/flintmark-gui npm run test:visual

Full local evidence is retained under /workspace/artifacts/flintmark/release-0.33.1/final-candidate/: visual-candidate, visual-baseline-control, visual-original, visual-control-repeat, visual-candidate-repeat, and visual-provenance. Evidence includes failed logs, source patches, bundle hashes, current fonts/runtime versions, and screenshot hashes.
