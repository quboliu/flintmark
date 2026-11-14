// Real VS Code searches/watchers under sustained directory + leaf traffic.
// The temporary probe wraps only the VS Code boundary to count root searches;
// it bundles the production driver and both production index services.
import { _electron as electron } from "playwright";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const work = mkdtempSync(join(tmpdir(), "ofm-index-busy-"));
const root = join(work, "workspace");
const probe = join(work, "probe");
const result = join(work, "result.json");
const gate = join(work, "build.gate");
const notes = Number(process.env.FLINTMARK_STRESS_FILES) || 2000;
const images = Number(process.env.FLINTMARK_STRESS_IMAGES) || 400;
for (const dir of [root, probe, join(work, "profile", "User"), join(root, "assets")]) mkdirSync(dir, { recursive: true });
for (let i = 0; i < notes; i++) writeFileSync(join(root, `Note-${i}.md`), `# Note ${i}\n\n[[Note-0]] #tag\n`);
for (let i = 0; i < images; i++) writeFileSync(join(root, "assets", `image-${i}.png`), "image path fixture");
writeFileSync(gate, "held");
writeFileSync(join(work, "profile", "User", "settings.json"), JSON.stringify({
  "security.workspace.trust.enabled": false, "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off", "update.mode": "none",
  "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false,
}));
writeFileSync(join(probe, "package.json"), JSON.stringify({
  name: "workspace-index-probe", publisher: "flintmark-tests", version: "1.0.0",
  engines: { vscode: "^1.89.0" }, main: "./probe.cjs", activationEvents: ["*"],
}));
const stats = join(probe, "stats.ts");
writeFileSync(stats, "export const counts = {rootSearches: 0, subtreeSearches: 0, cancellations: 0};\n");
const boundary = join(probe, "host.ts");
writeFileSync(boundary, `
import * as real from 'vscode';
export * from 'vscode';
import { counts } from './stats';
export const workspace = Object.create(real.workspace, { findFiles: { value(include, exclude, cap, token) {
  if (include.baseUri.fsPath === ${JSON.stringify(root)}) counts.rootSearches++;
  else counts.subtreeSearches++;
  token?.onCancellationRequested(() => counts.cancellations++);
  return real.workspace.findFiles(include, exclude, cap, token);
} } });
`);
writeFileSync(join(probe, "entry.ts"), `
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { counts } from './stats';
import { WorkspaceIndexDriver } from ${JSON.stringify(resolve("src/extension/vault/workspaceIndexDriver.ts"))};
import { VaultIndexService } from ${JSON.stringify(resolve("src/extension/vault/vaultIndexService.ts"))};
import { ImageIndexService } from ${JSON.stringify(resolve("src/extension/vault/imageIndexService.ts"))};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 30000;
  while (!check() && Date.now() < deadline) await sleep(50);
  assert.ok(check(), 'live path change must reach the production index');
}
export function activate() { void run(); }
async function run() {
  const driver = new WorkspaceIndexDriver();
  const vault = new VaultIndexService(driver);
  const image = new ImageIndexService(driver);
  try {
    await Promise.all([vault.initialize(), image.initialize()]);
    assert.ok(vault.resolveLink('Note-0'), 'first note graph is usable during noise');
    const document = vscode.Uri.file(${JSON.stringify(join(root, "Note-0.md"))});
    assert.ok(image.resolveImage(document, 'image-0.png', true), 'first image snapshot is usable');
    const note = vscode.Uri.file(${JSON.stringify(join(root, "Live Target.md"))});
    const picture = vscode.Uri.file(${JSON.stringify(join(root, "live.png"))});
    await vscode.workspace.fs.writeFile(note, Buffer.from('# Live Target'));
    await vscode.workspace.fs.writeFile(picture, Buffer.from('image path fixture'));
    await until(() => vault.resolveLink('Live Target') && image.resolveImage(document, 'live.png', true));
    await vscode.workspace.fs.delete(note);
    await vscode.workspace.fs.delete(picture);
    await until(() => !vault.resolveLink('Live Target') && !image.resolveImage(document, 'live.png', true));
    await sleep(5000);
    assert.equal(counts.rootSearches, 2, 'only the first search for each indexed kind covers the root');
    assert.equal(counts.cancellations, 0, 'no event cancels a full search');
    writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ok: true, ...counts }));
  } catch (error) {
    writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ok: false, error: String(error.stack), ...counts }));
  } finally { vault.dispose(); image.dispose(); driver.dispose(); }
}
`);
await build({
  entryPoints: [join(probe, "entry.ts")], outfile: join(probe, "probe.cjs"),
  platform: "node", format: "cjs", bundle: true,
  plugins: [{ name: "real-host-counts", setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, (args) => args.importer === boundary
      ? { path: "vscode", external: true } : { path: boundary });
  } }],
});

let noiseEvents = 0;
const transientDirs = [];
const noise = setInterval(() => {
  const dir = join(root, `transient-${noiseEvents++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "noise.md"), "# Transient");
  writeFileSync(join(dir, "noise.png"), "image path fixture");
  transientDirs.push(dir);
  if (transientDirs.length > 40) rmSync(transientDirs.shift(), { recursive: true, force: true });
}, 25);
let app;
let passed = false;
try {
  app = await electron.launch({
    executablePath: process.env.VSCODE_BIN || "/usr/share/codium/codium",
    env: { ...process.env, FLINTMARK_TEST_VAULT_BUILD_GATE: gate },
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      `--user-data-dir=${join(work, "profile")}`, `--extensions-dir=${join(work, "extensions")}`,
      `--extensionDevelopmentPath=${probe}`, root],
  });
  await app.firstWindow();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  unlinkSync(gate);
  const deadline = Date.now() + 120000;
  while (!existsSync(result) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(existsSync(result), "production indexes must finish under sustained traffic");
  const report = JSON.parse(readFileSync(result, "utf8"));
  assert.ok(report.ok, JSON.stringify(report));
  assert.ok(noiseEvents >= 100, "sustained directory and leaf events must overlap the builds");
  console.log("  ✓ busy workspace settles:", JSON.stringify({ notes, images, noiseEvents, ...report }));
  passed = true;
} catch (error) {
  console.error('Busy workspace check failed:', error);
  throw error;
} finally {
  clearInterval(noise);
  if (!passed) {
    const logs = join(work, "profile", "logs");
    if (existsSync(logs)) for (const file of readdirSync(logs, { recursive: true })) {
      if (/exthost\.log$|renderer\.log$|sharedprocess\.log$/.test(String(file))) console.error(readFileSync(join(logs, file), "utf8"));
    }
  }
  if (app) {
    const exitTimer = setTimeout(() => app.process()?.kill("SIGTERM"), 5000);
    try { await app.close(); } finally { clearTimeout(exitTimer); }
  }
  rmSync(work, { recursive: true, force: true });
}
