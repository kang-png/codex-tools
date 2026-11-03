import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotHistory } from '../snapshots.mjs';

const text = (id, value) => ({ id, tag: '#text', text: value });
const element = (id, children = [], attrs = {}) => ({ id, tag: 'div', ns: 'http://www.w3.org/1999/xhtml', attrs, children });
const snapshot = (revision, tree) => ({ revision, tree, css: 'body{}', cssRevision: 'css', htmlAttrs: {}, layers: {} });
function flatten(tree, records = new Map()) { records.set(tree.id, tree); for (const child of tree.children || []) flatten(child, records); for (const child of tree.shadow?.children || []) flatten(child, records); return records; }
function expand(tree, base) {
  if (tree.ref) { assert.ok(base.has(tree.id)); return base.get(tree.id); }
  return { ...tree, ...(tree.children ? { children: tree.children.map(node => expand(node, base)) } : {}),
    ...(tree.shadow ? { shadow: { ...tree.shadow, children: tree.shadow.children.map(node => expand(node, base)) } } : {}) };
}

test('incremental snapshots preserve unchanged subtrees, moves, deletion and shadow styles', () => {
  const history = new SnapshotHistory();
  const initial = element('1', [element('2', [text('3', 'unchanged')]), element('4', [text('5', 'before')]), element('6')]);
  initial.children[2].shadow = { css: 'code{color:red}', children: [element('7', [text('8', 'old code')])] };
  const first = history.response(snapshot(1, initial));
  const next = structuredClone(initial);
  next.children = [next.children[2], next.children[0]];
  next.children[0].shadow.css = 'code{color:blue}'; next.children[0].shadow.children[0].children[0].text = 'new code';
  const delta = history.response(snapshot(2, next), { revision: 1, epoch: first.epoch, cssRevision: first.cssRevision });
  assert.equal(delta.baseRevision, 1); assert.equal(delta.css, undefined);
  assert.deepEqual(delta.removed.sort(), ['4', '5']);
  assert.deepEqual(delta.tree.children[1], { id: '2', ref: true });
  assert.deepEqual(expand(delta.tree, flatten(initial)), next);
});

test('missing history, reconnects and server restarts safely send a full snapshot', () => {
  const history = new SnapshotHistory(2), tree = element('1', [text('2', 'one')]);
  const first = history.response(snapshot(1, tree));
  const second = history.response(snapshot(2, element('1', [text('2', 'two')])));
  history.response(snapshot(3, element('1', [text('2', 'three')])));
  assert.equal(history.response(history.current.source, { revision: 1, epoch: first.epoch }).baseRevision, undefined);
  assert.equal(history.response(history.current.source, { revision: 2, epoch: 'old-server' }).baseRevision, undefined);
  assert.deepEqual(history.response(history.current.source, { revision: 3, epoch: second.epoch }), { revision: 3, epoch: second.epoch });
  history.reset();
  const reset = history.response(snapshot(1, tree), { revision: 3, epoch: first.epoch });
  assert.notEqual(reset.epoch, first.epoch); assert.equal(reset.baseRevision, undefined); assert.deepEqual(reset.tree, tree);
});

test('one control update does not resend a large unchanged transcript', () => {
  const history = new SnapshotHistory();
  const tree = element('1', [element('2', Array.from({ length: 2000 }, (_, index) => text(String(index + 10), 'unchanged transcript '.repeat(20)))), element('3', [text('4', 'closed')])]);
  const first = history.response(snapshot(1, tree));
  const next = structuredClone(tree); next.children[1].children[0].text = 'open';
  const delta = history.response(snapshot(2, next), { revision: 1, epoch: first.epoch, cssRevision: first.cssRevision });
  assert.ok(JSON.stringify(delta).length < JSON.stringify(first).length / 100);
  assert.deepEqual(expand(delta.tree, flatten(tree)), next);
});

test('dynamic style updates reuse the large base sheet and preserve stylesheet order', () => {
  const history = new SnapshotHistory(), tree = element('1');
  const large = { id: 'base-0', css: '/* qa-large-style */' + '/* unchanged */'.repeat(20000) };
  const initial = { ...snapshot(1, tree), styleChunks: [large, { id: 'red-0', css: 'p{color:red}' }], cssRevision: 'red' };
  const first = history.response(initial);
  assert.equal(first.css, undefined); assert.equal(first.styleChunks, undefined); assert.equal(first.styles.sheets.length, 2);
  const next = { ...snapshot(2, tree), styleChunks: [large, { id: 'blue-0', css: 'p{color:blue}' }], cssRevision: 'blue' };
  const delta = history.response(next, { revision: 1, epoch: first.epoch, cssRevision: 'red' });
  assert.deepEqual(delta.styles, { baseRevision: 'red', order: ['base-0', 'blue-0'], sheets: [{ id: 'blue-0', css: 'p{color:blue}' }] });
  assert.ok(JSON.stringify(delta).length < 1000);
  const reordered = history.response({ ...next, revision: 3, styleChunks: [...next.styleChunks].reverse(), cssRevision: 'reordered' }, { revision: 2, epoch: first.epoch, cssRevision: 'blue' });
  assert.deepEqual(reordered.styles.order, ['blue-0', 'base-0']); assert.equal(reordered.styles.sheets.length, 0);
});
