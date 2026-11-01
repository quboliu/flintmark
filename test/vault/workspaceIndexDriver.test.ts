import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as host from '../fixtures/workspaceIndexVscode';
import { WorkspaceIndexDriver, type WorkspaceIndexRefreshEvent } from '../../src/extension/vault/workspaceIndexDriver';

// Real driver, fake host events: no direct calls to private routing helpers.
// We intentionally emit only the directory hint, so duplicate leaf events or
// freshness checks cannot conceal a missed invalidation.
const cases = [
  { name: 'same-case directory', scan: '/C:/work/assets', event: '/C:/work/assets', image: true },
  { name: 'lowercase scan and uppercase deletion', scan: '/c:/work/assets', event: '/C:/work/assets', image: true },
  { name: 'uppercase scan and lowercase deletion', scan: '/C:/work/assets', event: '/c:/work/assets', image: true },
  { name: 'ancestor deletion', scan: '/c:/work/assets/nested', event: '/C:/work/assets', image: true },
  { name: 'unrelated deletion', scan: '/c:/work/assets', event: '/C:/work/other', image: false },
  { name: 'path segment boundary', scan: '/c:/work/assets-extra', event: '/C:/work/assets', image: false },
  { name: 'directory with note suffix', scan: '/c:/work/docs.md', event: '/C:/work/docs.md', image: true, note: true },
  { name: 'directory case is preserved', scan: '/C:/work/Assets', event: '/c:/work/assets', image: false },
  { name: 'custom provider matching case', scheme: 'custom', root: '/', scan: '/C:/work/assets', event: '/C:/work/assets', image: true },
  { name: 'custom provider drive case is preserved', scheme: 'custom', root: '/', scan: '/C:/work/assets', event: '/c:/work/assets', image: false },
  { name: 'rename invalidates old directory', scan: '/c:/work/assets', event: '/C:/work/assets', image: true, rename: true },
];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  let failures = 0;
  for (const c of cases) {
    const uri = (path: string) => host.Uri.from({ scheme: c.scheme ?? 'file', path });
    host.reset(uri(c.root ?? '/C:/work'), [uri(c.scan + '/pixel.png')], [uri('/C:/work/notes/note.md')]);
    const driver = new WorkspaceIndexDriver();
    const events: WorkspaceIndexRefreshEvent[] = [];
    driver.onDidRefresh((event) => events.push(event));
    const image = driver.registerSpec({ kind: 'image', include: '**/*.png', debounceMs: 1,
      notReady: () => [], build: async (_root, files) => files.map((f) => f.path) });
    const note = driver.registerSpec({ kind: 'note', include: '**/*.md', debounceMs: 1,
      notReady: () => [], build: async (_root, files) => files.map((f) => f.path) });
    try {
      await driver.initialize();
      assert.equal(events.length, 2, 'both initial scans complete');
      events.length = 0;
      const before = { ...host.calls };
      host.removeFiles();
      if (c.rename) {
        // Moving outside the root isolates the old-directory invalidation.
        host.renameDirectory(uri(c.event), uri('/elsewhere/moved'));
      } else {
        host.deleteDirectory(uri(c.event));
      }
      assert.equal(host.calls.delivered, before.delivered + 1, 'host event delivered');
      assert.ok(host.calls.matchedFolder > before.matchedFolder, 'event reached routing with a matching root');
      if (c.image || c.note) {
        const deadline = performance.now() + 2000;
        while (performance.now() < deadline &&
          (c.image && !events.some((e) => e.kind === 'image') ||
           c.note && !events.some((e) => e.kind === 'note'))) await sleep(10);
      } else {
        // A delivered negative hint must stay quiet through four tree-debounce windows.
        await sleep(200);
      }
      assert.equal(host.calls.imageScan - before.imageScan, c.image ? 1 : 0, 'image rescan count');
      assert.equal(host.calls.noteScan - before.noteScan, c.note ? 1 : 0, 'note rescan count');
      assert.equal(events.some((e) => e.kind === 'image'), c.image, 'image invalidation');
      assert.equal(events.some((e) => e.kind === 'note'), c.note ?? false, 'note invalidation');
      assert.equal(image.snapshots()[0].snapshot.length, c.image ? 0 : 1, 'snapshot reconciled only for affected directories');
      assert.equal(note.snapshots()[0].snapshot.length, c.note ? 0 : 1, 'note snapshot reconciliation');
      console.log(`✓ ${c.name}`);
    } catch (error) {
      failures++;
      console.error(`✗ ${c.name}`, error);
    } finally {
      driver.dispose();
    }
  }
  if (failures) process.exitCode = 1;
}
main().catch((error) => { console.error('✗ directory event routing', error); process.exitCode = 1; });
