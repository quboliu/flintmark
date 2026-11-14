import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mock } from 'node:test';
import { homedir } from 'node:os';
import * as host from '../fixtures/workspaceIndexVscode';
import { WorkspaceIndexDriver, type WorkspaceIndexRefreshEvent } from '../../src/extension/vault/workspaceIndexDriver';
import { VaultIndexService } from '../../src/extension/vault/vaultIndexService';
import { ImageIndexService } from '../../src/extension/vault/imageIndexService';

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
  {
    const uri = (path: string) => host.Uri.file(path);
    const root = uri('/work');
    host.reset(root, [uri('/work/assets/Logo.png'), uri('/work/assets/logo.png')], []);
    const driver = new WorkspaceIndexDriver();
    const service = new ImageIndexService(driver);
    let publications = 0;
    service.onDidChange(() => { publications++; });
    const resolved = () => service.resolveImage(uri('/work/notes/note.md'), 'Logo.png', true)?.path;
    try {
      await service.initialize();
      assert.equal(resolved(), '/work/assets/Logo.png');
      host.createLeaf('image', uri('/work/new.png'));
      const deadline = performance.now() + 2000;
      while (publications < 2 && performance.now() < deadline) await sleep(10);
      assert.ok(publications >= 2, 'unrelated image creation is applied');
      assert.equal(resolved(), '/work/assets/Logo.png', 'unrelated creation preserves exact-case candidates');
      host.deleteLeaf('image', uri('/work/assets/logo.png'));
      const deleteDeadline = performance.now() + 2000;
      while (publications < 3 && performance.now() < deleteDeadline) await sleep(10);
      assert.ok(publications >= 3, 'colliding image deletion is applied');
      assert.equal(resolved(), '/work/assets/Logo.png', 'deleting one candidate preserves the other');
      console.log('✓ image patches preserve colliding resolution candidates');
    } catch (error) {
      failures++;
      console.error('✗ image patches preserve colliding resolution candidates', error);
    } finally {
      service.dispose();
      driver.dispose();
    }
  }
  {
    const uri = (path: string) => host.Uri.from({ scheme: 'file', path });
    host.reset(uri('/work'), [uri('/work/old.png')], [uri('/work/old.md')]);
    let release!: () => void;
    host.holdScans(new Promise<void>((resolve) => { release = resolve; }));
    const driver = new WorkspaceIndexDriver();
    const events: WorkspaceIndexRefreshEvent[] = [];
    driver.onDidRefresh((event) => events.push(event));
    const handles = (['note', 'image'] as const).map((kind) => driver.registerSpec({
      kind, include: kind === 'note' ? '**/*.md' : '**/*.png', debounceMs: 1,
      notReady: (): string[] => [], build: async (_root, files) => files.map((file) => file.path),
    }));
    const initialization = driver.initialize();
    try {
      await sleep(10);
      for (let i = 0; i < 5; i++) {
        host.createDirectory(uri('/work/temp-' + i));
        host.createLeaf('note', uri('/work/new-' + i + '.md'));
        host.createLeaf('image', uri('/work/new-' + i + '.png'));
        host.deleteLeaf('note', uri('/work/old.md'));
        host.deleteLeaf('image', uri('/work/old.png'));
        await sleep(5);
      }
      assert.equal(host.scanTokens.some((token) => token.isCancellationRequested), false,
        'busy workspace events must not cancel the first scan');
      host.holdScans();
      release();
      await initialization;
      const deadline = performance.now() + 2000;
      while (events.length < 4 && performance.now() < deadline) await sleep(10);
      assert.equal(events.filter((event) => event.reason === 'initial-scan').length, 2,
        'both first builds publish');
      assert.equal(events.length, 4, 'one coalesced follow-up per kind');
      for (const handle of handles) assert.equal(handle.snapshots()[0].snapshot.length, 5);
      const scans = host.calls.noteScan + host.calls.imageScan;
      host.createLeaf('note', uri('/work/added.md'));
      const patchDeadline = performance.now() + 2000;
      while (handles[0].snapshots()[0].snapshot.length !== 6 && performance.now() < patchDeadline) await sleep(10);
      assert.equal(handles[0].snapshots()[0].snapshot.length, 6, 'created note enters the snapshot');
      assert.equal(host.calls.noteScan + host.calls.imageScan, scans, 'leaf create patches without findFiles');
      const published = events.length;
      host.createDirectory(uri('/work/empty'));
      await sleep(50);
      assert.equal(events.length, published, 'empty-directory no-op keeps existing snapshots');
      assert.equal(host.scanBases.filter((base) => (base as host.Uri).path === '/work').length, 2,
        'only the two initial searches cover the root');
      const quiet = events.length;
      for (const directory of ['.cache', 'Library', '.claude', '.codex', '.npm', '.cargo', '.rustup',
        '.local/share', '.vscode', '__pycache__', '.venv', 'dist', 'target']) {
        host.createDirectory(uri('/work/' + directory));
        host.createLeaf('note', uri('/work/' + directory + '/z.md'));
        host.createLeaf('image', uri('/work/' + directory + '/x.png'));
      }
      await sleep(50);
      assert.equal(events.length, quiet, 'default excluded events cause no refresh');
      console.log('✓ first builds survive directory and leaf event streams, then reconcile once');
    } catch (error) {
      failures++;
      console.error('✗ first builds survive directory and leaf event streams, then reconcile once', error);
    } finally {
      driver.dispose();
      host.holdScans();
      release();
      await initialization;
    }
  }
  for (const c of cases) {
    const uri = (path: string) => host.Uri.from({ scheme: c.scheme ?? 'file', path });
    host.reset(uri(c.root ?? '/C:/work'), [uri(c.scan + '/pixel.png')],
      [uri(c.note ? c.scan + '/note.md' : '/C:/work/notes/note.md')]);
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
      assert.equal(host.calls.imageScan - before.imageScan, 0, 'directory removal needs no image search');
      assert.equal(host.calls.noteScan - before.noteScan, 0, 'directory removal needs no note search');
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
  {
    const root = host.Uri.from({ scheme: 'file', path: '/rate-test' });
    host.reset(root, [], []);
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
    const driver = new WorkspaceIndexDriver();
    const handle = driver.registerSpec({ kind: 'note', include: '**/*.md', debounceMs: 1,
      notReady: () => [], build: async (_root, files) => files.map((file) => file.path) });
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
    try {
      await driver.initialize();
      for (let i = 0; i < 10; i++) handle.requestRefresh(root, 'manual', true);
      mock.timers.tick(29_999);
      await flush();
      assert.equal(host.calls.noteScan, 1, 'no full rescan before the 30 second boundary');
      mock.timers.tick(1);
      await flush();
      assert.equal(host.calls.noteScan, 2, 'one coalesced full rescan at the boundary');
      console.log('✓ full rescans are rate limited per root');
    } catch (error) {
      failures++;
      console.error('✗ full rescans are rate limited per root', error);
    } finally {
      driver.dispose();
      mock.timers.reset();
    }
  }
  {
    const root = host.Uri.from({ scheme: 'file', path: '/capped' });
    host.reset(root, [], ['one', 'two', 'three'].map((name) => host.Uri.from({ scheme: 'file', path: `/capped/${name}.md` })));
    const driver = new WorkspaceIndexDriver();
    const handle = driver.registerSpec({ kind: 'note', include: '**/*.md', maxFiles: () => 2,
      notReady: (): string[] => [], build: async (_root, files) => files.map((file) => file.path) });
    try {
      await driver.initialize();
      assert.deepEqual(handle.snapshot(root), ['/capped/one.md', '/capped/two.md'], 'partial snapshot remains usable');
      assert.equal(host.notices.length, 1, 'one notice suggests a narrower folder');
      assert.match(host.notices[0], /narrower folder/i);
      assert.equal(host.calls.noteScan, 1, 'no retry after reaching the cap');
      handle.ensureFreshForDocument(host.Uri.from({ scheme: 'file', path: '/capped/one.md' }), 'attachment-saved');
      await sleep(60);
      assert.equal(host.calls.noteScan, 1, 'document freshness never retries a capped search');
      console.log('✓ capped searches retain a usable partial index and notify once');
    } catch (error) {
      failures++;
      console.error('✗ capped searches retain a usable partial index and notify once', error);
    } finally {
      driver.dispose();
    }
  }
  {
    const root = host.Uri.file(homedir());
    host.reset(root, [], []);
    host.configuration.set('ofm.workspaceIndex.exclude', ['private/**']);
    host.configuration.set('files.watcherExclude', { '**/generated/**': true, '**/allowed/**': false });
    host.configuration.set('search.exclude', { '**/search-hidden/**': true });
    const driver = new WorkspaceIndexDriver();
    const handle = driver.registerSpec({ kind: 'note', include: '**/*.md', debounceMs: 1,
      notReady: (): string[] => [], build: async (_root, files) => files.map((file) => file.path) });
    try {
      await driver.initialize();
      assert.equal(host.notices.length, 1, 'home folders show one notice');
      for (const dir of ['private', 'generated', 'search-hidden', 'allowed', '.cache']) {
        host.createLeaf('note', host.Uri.file(homedir() + '/' + dir + '/z.md'));
      }
      await sleep(50);
      assert.deepEqual(handle.snapshot(root), [homedir() + '/allowed/z.md', homedir() + '/.cache/z.md'],
        'custom excludes replace defaults and enabled editor exclusions remain respected');
      assert.match(host.scanExcludes[0]!, /private/);
      assert.match(host.scanExcludes[0]!, /generated/);
      assert.match(host.scanExcludes[0]!, /search-hidden/);
      console.log('✓ configured scan and watcher exclusions agree, and home roots notify once');
    } catch (error) {
      failures++;
      console.error('✗ configured scan and watcher exclusions agree, and home roots notify once', error);
    } finally {
      driver.dispose();
    }
  }
  {
    const uri = (path: string) => host.Uri.from({ scheme: 'custom', path });
    const notes = Array.from({ length: 1500 }, (_, i) => uri(`/busy/Note-${i}.md`));
    host.reset(uri('/busy'), [], notes);
    const links = Array.from({ length: 150 }, (_, i) => `[[Note-${i}]]`).join(' ');
    for (const note of notes) host.noteTexts.set(note.path, '# Note\n' + links);
    const driver = new WorkspaceIndexDriver();
    const service = new VaultIndexService(driver);
    let firstPublication = false;
    service.onDidChange(() => { firstPublication = true; });
    let transient: host.Uri | undefined;
    let sequence = 0;
    const noise = setInterval(() => {
      if (transient) host.deleteLeaf('note', transient);
      transient = uri(`/busy/transient-${sequence++}.md`);
      host.createLeaf('note', transient);
    }, 5);
    try {
      const initialized = service.initialize();
      const deadline = performance.now() + 10_000;
      while (!firstPublication && performance.now() < deadline) await sleep(20);
      assert.equal(firstPublication, true, 'first note graph publishes during sustained leaf traffic');
      assert.ok(service.resolveLink('Note-1499'), 'first publication can resolve existing notes');
      await initialized;
      console.log('✓ first note graph publishes during sustained leaf traffic');
    } catch (error) {
      failures++;
      console.error('✗ first note graph publishes during sustained leaf traffic', error);
    } finally {
      clearInterval(noise);
      service.dispose();
      driver.dispose();
    }
  }
  if (failures) process.exitCode = 1;
}
main().catch((error) => { console.error('✗ directory event routing', error); process.exitCode = 1; });
