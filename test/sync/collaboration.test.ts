import assert from "node:assert/strict";
import { ChangeSet, EditorState } from "@codemirror/state";
import {
  collab,
  getSyncedVersion,
  receiveUpdates,
  sendableUpdates,
  type Update,
} from "@codemirror/collab";
import {
  CollaborationAuthority,
  decodeUpdates,
  encodeUpdates,
  extendsPendingUpdates,
} from "../../src/shared/collaboration";

function test(name: string, fn: () => void) {
  fn();
  console.log(`  ✓ ${name}`);
}
function client(text: string, id: string) {
  return EditorState.create({
    doc: text,
    extensions: [collab({ clientID: id })],
  });
}

test("stale panel edits rebase and both panels converge without losing either insertion", () => {
  const text = "# Note\n\nalpha\nbeta\ngamma\n";
  const server = new CollaborationAuthority(text, false);
  let a = client(text, "a"),
    b = client(text, "b");
  a = a.update({ changes: { from: a.doc.line(4).to, insert: "FIRST" } }).state;
  b = b.update({ changes: { from: b.doc.line(5).to, insert: "SECOND" } }).state;
  const first = server.prepare(
    0,
    decodeUpdates(encodeUpdates(sendableUpdates(a))),
  );
  server.commit(first);
  const second = server.prepare(
    0,
    decodeUpdates(encodeUpdates(sendableUpdates(b))),
  );
  server.commit(second);
  for (const updates of [first, second]) {
    a = a.update(receiveUpdates(a, updates)).state;
    b = b.update(receiveUpdates(b, updates)).state;
  }
  assert.equal(
    server.doc.toString(),
    "# Note\n\nalpha\nbetaFIRST\ngammaSECOND\n",
  );
  assert.equal(a.doc.toString(), server.doc.toString());
  assert.equal(b.doc.toString(), server.doc.toString());
  assert.equal(sendableUpdates(a).length + sendableUpdates(b).length, 0);
});

test("host undo or reload rebases a panel's unconfirmed edits", () => {
  const server = new CollaborationAuthority("alpha\nbeta\n", true);
  let a = client(server.doc.toString(), "a");
  a = a.update({ changes: { from: 10, insert: "LOCAL" } }).state;
  const outgoing = sendableUpdates(a);
  const external = [
    {
      clientID: "host",
      changes: ChangeSet.of(
        { from: 0, to: 5, insert: "HOST\nEXTRA" },
        server.doc.length,
      ),
    },
  ];
  server.commit(external);
  const rebased = server.prepare(0, outgoing);
  server.commit(rebased);
  a = a.update(receiveUpdates(a, external)).state;
  a = a.update(receiveUpdates(a, rebased)).state;
  assert.equal(a.doc.toString(), "HOST\nEXTRA\nbetaLOCAL\n");
  assert.equal(a.doc.toString(), server.doc.toString());
});

test("duplicate delivery from an old version is not applied twice", () => {
  const server = new CollaborationAuthority("ab", false);
  let a = client("ab", "a");
  a = a.update({ changes: { from: 1, insert: "X" } }).state;
  const sent = sendableUpdates(a);
  server.commit(server.prepare(0, sent));
  assert.equal(server.prepare(0, sent).length, 0);
  assert.equal(server.doc.toString(), "aXb");
  assert.throws(() => server.prepare(-1, sent), RangeError);
  assert.throws(() => server.prepare(9, sent), RangeError);
});

test("three fast editors converge under delayed, interleaved delivery (2,000 edits)", () => {
  const server = new CollaborationAuthority("\n", false);
  const clients = [0, 1, 2].map((i) => ({
    state: client("\n", String(i)),
    inbox: [] as (readonly Update[])[],
    busy: false,
  }));
  let seed = 20261031,
    count = 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  function send(i: number) {
    const c = clients[i];
    const updates = sendableUpdates(c.state);
    if (c.busy || !updates.length) return;
    c.busy = true;
    const accepted = server.prepare(
      getSyncedVersion(c.state),
      decodeUpdates(encodeUpdates(updates)),
    );
    server.commit(accepted);
    for (const other of clients) other.inbox.push(accepted);
  }
  function receive(i: number) {
    const c = clients[i],
      updates = c.inbox.shift();
    if (!updates) return;
    c.state = c.state.update(receiveUpdates(c.state, updates)).state;
    if (updates.some((u) => u.clientID === String(i))) c.busy = false;
  }
  for (let step = 0; step < 10000; step++) {
    const i = random() % 3,
      action = random() % 4;
    if (action === 0 && count < 2000) {
      const c = clients[i],
        from = random() % (c.state.doc.length + 1);
      c.state = c.state.update({
        changes: { from, insert: String.fromCharCode(0xe000 + count++) },
      }).state;
    } else if (action === 1) send(i);
    else receive(i);
  }
  while (count < 2000) {
    const c = clients[count % 3];
    c.state = c.state.update({
      changes: { from: 0, insert: String.fromCharCode(0xe000 + count++) },
    }).state;
  }
  for (let rounds = 0; rounds < 10000; rounds++) {
    clients.forEach((_c, i) => {
      receive(i);
      send(i);
    });
    if (
      clients.every(
        (c) => !c.inbox.length && !c.busy && !sendableUpdates(c.state).length,
      )
    )
      break;
  }
  for (const c of clients) {
    assert.equal(c.state.doc.toString(), server.doc.toString());
    assert.equal(sendableUpdates(c.state).length, 0);
  }
  const chars = [...server.doc.toString()].filter((c) => c !== "\n");
  assert.equal(chars.length, 2000);
  assert.equal(new Set(chars).size, 2000);
});

test("eager overlapping batches survive panel closure without duplicated edits", () => {
  const server = new CollaborationAuthority("start\n", false);
  let a = client("start\n", "a"),
    b = client("start\n", "b");
  const messages: { version: number; updates: Update[] }[] = [];
  for (let i = 0; i < 40; i++) {
    a = a.update({ changes: { from: a.doc.length, insert: `A${i} ` } }).state;
    b = b.update({ changes: { from: b.doc.length, insert: `B${i} ` } }).state;
    messages.push({
      version: 0,
      updates: decodeUpdates(encodeUpdates(sendableUpdates(a))),
    });
    messages.push({
      version: 0,
      updates: decodeUpdates(encodeUpdates(sendableUpdates(b))),
    });
  }
  // The frames can now close: the authority already has every queued message.
  for (const msg of messages)
    server.commit(server.prepare(msg.version, msg.updates));
  for (let i = 0; i < 40; i++)
    for (const c of ["A", "B"])
      assert.equal(server.doc.toString().split(`${c}${i} `).length - 1, 1);
  a = a.update(receiveUpdates(a, server.updates)).state;
  b = b.update(receiveUpdates(b, server.updates)).state;
  assert.equal(a.doc.toString(), server.doc.toString());
  assert.equal(b.doc.toString(), server.doc.toString());
});

test("pending batches only coalesce an exact cumulative prefix at the same base", () => {
  const first={clientID:"a",changes:[1,[0,"x"],1]};
  const second={clientID:"a",changes:[2,[0,"y"],1]};
  const previous={syncVersion:4,updates:[first]};
  const next={syncVersion:4,updates:[first,second]};
  assert.equal(extendsPendingUpdates(previous,next),true);
  assert.equal(extendsPendingUpdates(previous,{...next,syncVersion:5}),false);
  assert.equal(extendsPendingUpdates(previous,{...next,updates:[{...first,clientID:"b"},second]}),false);
  assert.equal(extendsPendingUpdates(previous,{...next,updates:[{...first,changes:[1,[0,"z"],1]},second]}),false);
  assert.equal(extendsPendingUpdates(previous,previous),false);
  assert.equal(extendsPendingUpdates(next,previous),false);
  assert.equal(extendsPendingUpdates({syncVersion:4,updates:[]},next),false);
});
