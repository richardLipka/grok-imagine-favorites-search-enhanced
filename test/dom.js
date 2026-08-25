'use strict';

/**
 * The smallest element model that renderResultCards() actually touches: ordered children,
 * sibling traversal, insertBefore, remove, and a dataset. Enough to assert ordering and node
 * reuse without pulling in a DOM library.
 */
class FakeElement {
  constructor(id) {
    this.dataset = {};
    if (id !== undefined) this.dataset.id = id;
    this.parent = null;
    this.kids = [];
  }

  get children() {
    return this.kids.slice();
  }

  get firstElementChild() {
    return this.kids[0] || null;
  }

  get nextElementSibling() {
    if (!this.parent) return null;
    const i = this.parent.kids.indexOf(this);
    return i < 0 ? null : this.parent.kids[i + 1] || null;
  }

  insertBefore(node, ref) {
    if (node.parent) node.parent.kids.splice(node.parent.kids.indexOf(node), 1);
    node.parent = this;
    const at = ref ? this.kids.indexOf(ref) : this.kids.length;
    this.kids.splice(at < 0 ? this.kids.length : at, 0, node);
    return node;
  }

  remove() {
    if (!this.parent) return;
    this.parent.kids.splice(this.parent.kids.indexOf(this), 1);
    this.parent = null;
  }
}

/** Container pre-filled with cards carrying the given ids. */
function containerWith(ids = []) {
  const container = new FakeElement();
  for (const id of ids) container.insertBefore(new FakeElement(id), null);
  return container;
}

const idsOf = container => container.kids.map(k => k.dataset.id);

/**
 * Attributes + inline style, which is all the native-visibility code touches. Kept separate
 * from FakeElement so the grid reconciler's model stays as small as it was.
 */
class FakeNode {
  constructor(name = 'div') {
    this.name = name;
    this.attrs = new Map();
    this.dataset = {};
    const props = new Map();
    this.styleProps = props;
    this.style = {
      setProperty(k, v) { props.set(k, v); },
      removeProperty(k) { props.delete(k); },
      getPropertyValue(k) { return props.get(k) ?? ''; },
    };
  }

  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }

  /** True when nothing is forcing this node out of the layout. */
  get visible() {
    return this.styleProps.get('display') !== 'none'
      && this.styleProps.get('visibility') !== 'hidden';
  }
}

/** Just enough document for `document.querySelectorAll('[attr]')`. */
function fakeDocument(nodes) {
  return {
    nodes,
    querySelectorAll(selector) {
      const m = /^\[([^\]=]+)\]$/.exec(selector);
      if (!m) throw new Error(`fakeDocument: unsupported selector ${selector}`);
      return nodes.filter(n => n.hasAttribute(m[1]));
    },
    getElementById() { return null; },
  };
}

module.exports = { FakeElement, FakeNode, fakeDocument, containerWith, idsOf };
