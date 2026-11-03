# CodeMirror scroll anchor patch

`@codemirror/view` is pinned to 6.43.1. `npm ci` applies the checked-in patch to both its ESM and CommonJS builds through `patch-package --error-on-fail`. A patch mismatch fails installation. The bundled extension includes the patched editor; dependency sources and patches are excluded from the VSIX.

The editor must keep a source position and its viewport margin across layout measurements. Computing a relative scroll delta from an earlier offset fails when browser layout has already clamped the actual scroll position. Repeatedly using rounded DOM offsets also accumulates drift for fractional geometry changes.

The patch retains the logical anchor and fractional desired position, writes an absolute bounded scroll offset, and invalidates the retained anchor on user input, explicit selection, state replacement, and disposal. Document edits map the retained source position through their changes. Native explicit scroll targets retain precedence. CSS scaling is accounted for when restoring snapshots.

`test/e2e/native-scroll-anchor.e2e.mjs` exercises the installed dependency in a real Electron renderer: early browser clamping, fractional changes, repeated layout transitions, state replacement followed immediately by editing, edits before the anchor, snapshot restoration, and explicit navigation at three CSS scales. The full Flintmark suite separately checks real Markdown layout, source identity, and selection stability.

When upgrading CodeMirror, review the upstream implementation and rerun these tests. Do not silently drop the patch or loosen the assertions to accommodate a failed upgrade.

External scroll offsets derived from bounding rectangles are already in screen coordinates. Only internal DOM offsets need the editor scale. The physical scroll conversion uses the actual scrolling container's scale (or 1 for the window), including when it differs from the editor's scale. The native regression suite also covers top/bottom clamping, unattainable reveal targets, window scrollers, and independently scaled outer containers.
