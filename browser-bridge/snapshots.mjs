import { randomUUID } from 'node:crypto';

// Reuse unchanged subtrees so one label/menu change does not resend the chat.
export class SnapshotHistory {
  constructor(limit = 8) { this.limit = limit; this.reset(); }
  reset() { this.epoch = randomUUID(); this.history = new Map(); this.styleVersions = new Map(); this.current = null; }
  record(snapshot) {
    if (!snapshot?.tree || snapshot === this.current?.source) return this.current;
    const previous = this.current?.nodes, nodes = new Map();
    function intern(record) {
      const children = record.children?.map(intern);
      const shadowChildren = record.shadow?.children.map(intern);
      const signature = JSON.stringify({ ...record, children: children?.map(node => node.id),
        ...(record.shadow ? { shadow: { ...record.shadow, children: shadowChildren.map(node => node.id) } } : {}) });
      const old = previous?.get(record.id);
      const sameChildren = (next, before) => next?.length === before?.length && (!next || next.every((node, i) => node === before[i]));
      const node = old?.signature === signature && sameChildren(children, old.node.children) && sameChildren(shadowChildren, old.node.shadow?.children)
        ? old.node : { ...record, ...(children ? { children } : {}), ...(record.shadow ? { shadow: { ...record.shadow, children: shadowChildren } } : {}) };
      nodes.set(record.id, { node, signature });
      return node;
    }
    const tree = intern(snapshot.tree);
    this.current = { source: snapshot, tree, nodes };
    this.history.set(snapshot.revision, this.current);
    if (snapshot.styleChunks) this.styleVersions.set(snapshot.cssRevision, snapshot.styleChunks);
    while (this.history.size > this.limit) this.history.delete(this.history.keys().next().value);
    while (this.styleVersions.size > this.limit) this.styleVersions.delete(this.styleVersions.keys().next().value);
    return this.current;
  }
  response(snapshot, view = {}) {
    const current = this.record(snapshot);
    if (!current) return snapshot;
    const metadata = { ...snapshot, tree: undefined, styleChunks: undefined, epoch: this.epoch,
      ...(snapshot.cssRevision === view.cssRevision ? { css: undefined } : {}) };
    if (snapshot.styleChunks) {
      metadata.css = undefined;
      if (snapshot.cssRevision !== view.cssRevision) {
        const old = this.styleVersions.get(view.cssRevision), known = new Set(old?.map(sheet => sheet.id));
        metadata.styles = { ...(old ? { baseRevision: view.cssRevision } : {}), order: snapshot.styleChunks.map(sheet => sheet.id), sheets: snapshot.styleChunks.filter(sheet => !known.has(sheet.id)) };
      }
    }
    const previous = view.epoch === this.epoch ? this.history.get(Number(view.revision)) : null;
    if (previous === current) return { revision: snapshot.revision, epoch: this.epoch };
    if (!previous) return { ...metadata, tree: current.tree };
    function encode(node) {
      if (previous.nodes.get(node.id)?.node === node) return { id: node.id, ref: true };
      return { ...node, ...(node.children ? { children: node.children.map(encode) } : {}),
        ...(node.shadow ? { shadow: { ...node.shadow, children: node.shadow.children.map(encode) } } : {}) };
    }
    return { ...metadata, tree: encode(current.tree), baseRevision: Number(view.revision),
      removed: [...previous.nodes.keys()].filter(id => !current.nodes.has(id)) };
  }
}
