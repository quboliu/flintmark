import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension/activate.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  outfile: 'out/extension.js',
};

const webviewConfig = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  outfile: 'out/webview.js',
  // KaTeX CSS is imported in main.ts → emits out/webview.css; its fonts are
  // copied to out/ (the "file" loader) and the url()s are rewritten to relative
  // paths that resolve under the extension's webview resource root.
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
};

// Mermaid is large (~3MB minified) and lazily loaded only when a mermaid block
// is present, so it is its own bundle (not part of the main webview bundle).
const mermaidConfig = {
  entryPoints: ['src/webview/mermaid/mermaid-entry.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  outfile: 'out/mermaid.js',
  minify: true,
};

if (isWatch) {
  const extCtx = await esbuild.context(extensionConfig);
  const webCtx = await esbuild.context(webviewConfig);
  const merCtx = await esbuild.context(mermaidConfig);
  await extCtx.watch();
  await webCtx.watch();
  await merCtx.watch();
  console.log('[esbuild] watching for changes...');
} else {
  await esbuild.build(extensionConfig);
  await esbuild.build(webviewConfig);
  await esbuild.build(mermaidConfig);
  console.log('[esbuild] build complete');
}
