'use strict';

const { createCardImageSandbox, readSource } = require('../harness');
const { FakeCard, FakeImage } = require('../dom');

/**
 * Paging showed the previous page at the bottom of the grid.
 *
 * The grid reuses card elements across pages, so a card that held post A is handed post B and
 * only the fields that differ are patched. Assigning a new `src` to the existing `<img>` is not
 * enough: the browser keeps painting A's picture until B's has loaded, and with `loading="lazy"`
 * that load can be deferred indefinitely — the element is already in the layout, so it never
 * leaves and re-enters the viewport to re-trigger it. The result was a grid whose top rows were
 * page 2 and whose bottom rows were still page 1, permanently.
 *
 * The invariant is therefore about the **element**, not the attribute: a card being recycled for
 * a different post gets a *new* image element, which can only ever paint blank or correct.
 */
function sandbox() {
  const created = [];
  const { syncCardImage, imageAltText } = createCardImageSandbox({
    createElement: () => {
      const img = new FakeImage();
      created.push(img);
      return img;
    },
  });
  return { syncCardImage, imageAltText, created };
}

module.exports = {
  name: 'card image — a recycled card never keeps the old picture',
  run(t) {
    t.group('first paint of a fresh card');
    let { syncCardImage, created } = sandbox();
    let card = new FakeCard();
    const original = card.img;
    let img = syncCardImage(card, 'a.jpg', 'prompt a');
    t.ok('the skeleton image is used as-is', img === original);
    t.ok('nothing is allocated', created.length === 0, created.length);
    t.equal('it points at the thumbnail', img.getAttribute('src'), 'a.jpg');
    t.equal('and stays lazy — this is the case lazy loading is for', img.loading, 'lazy');
    t.equal('alt carries the prompt', img.alt, 'prompt a');

    t.group('re-rendering the same post');
    ({ syncCardImage, created } = sandbox());
    card = new FakeCard('a.jpg');
    const kept = card.img;
    img = syncCardImage(card, 'a.jpg', 'prompt a');
    t.ok('the element survives', img === kept && card.img === kept);
    t.ok('and nothing is allocated', created.length === 0, created.length);

    t.group('recycling the card for a different post');
    ({ syncCardImage, created } = sandbox());
    card = new FakeCard('a.jpg');
    const stale = card.img;
    stale.className = 'thumb';
    img = syncCardImage(card, 'b.jpg', 'prompt b');
    t.ok('the image element is replaced, not re-pointed', img !== stale);
    t.ok('and it is the card’s image now', card.img === img);
    t.ok('the old element is detached', stale.card === null);
    // The whole point: a fresh element has no decoded picture, so it cannot paint post A.
    t.equal('the new one points at the new thumbnail', img.getAttribute('src'), 'b.jpg');
    t.equal('it loads eagerly — paging is a request to see this page', img.loading, 'eager');
    t.equal('alt is the new prompt', img.alt, 'prompt b');

    t.group('the replacement keeps the skeleton’s box');
    t.equal('inline style is copied, not restated', img.style.cssText, stale.style.cssText);
    t.equal('and so is the class', img.className, 'thumb');

    t.group('paging back and forth');
    ({ syncCardImage, created } = sandbox());
    card = new FakeCard('a.jpg');
    syncCardImage(card, 'b.jpg', 'b');
    syncCardImage(card, 'a.jpg', 'a');
    syncCardImage(card, 'c.jpg', 'c');
    t.equal('every change swaps the element', created.length, 3);
    t.equal('and the last one wins', card.img.getAttribute('src'), 'c.jpg');
    t.ok('with only the live element attached', card.img.card === card
      && created.slice(0, 2).every(i => i.card === null));

    t.group('a row with no thumbnail');
    ({ syncCardImage, created } = sandbox());
    card = new FakeCard('a.jpg');
    img = syncCardImage(card, '', 'no media');
    t.ok('still replaces, so the old picture cannot linger', img !== null && card.img !== null);
    t.equal('and carries no src at all', img.getAttribute('src'), null);

    t.group('a card with no image at all');
    ({ syncCardImage } = sandbox());
    const empty = { querySelector: () => null };
    t.equal('returns null rather than throwing', syncCardImage(empty, 'a.jpg', 'p'), null);

    // A broken <img> is not replaced content: the browser lays out the alt text and grows the box
    // to fit, ignoring aspect-ratio. Measured against the shipped stylesheet, a card holding a
    // 2,524-character prompt whose media 404s was 1,746px tall instead of 246px.
    t.group('alt text cannot carry a whole prompt');
    let imageAltText;
    ({ imageAltText } = sandbox());
    const long = 'a fine art oil illustration with luxurious textured brushwork. '.repeat(50);
    t.ok('a long prompt is capped', imageAltText(long).length <= 140, imageAltText(long).length);
    t.ok('and marked as truncated', imageAltText(long).endsWith('…'), imageAltText(long).slice(-10));
    t.ok('the start is preserved', imageAltText(long).startsWith('a fine art oil illustration'));
    t.equal('a short prompt is left alone', imageAltText('a cat'), 'a cat');
    t.equal('whitespace is collapsed', imageAltText('  a   cat\non a mat  '), 'a cat on a mat');
    t.equal('an empty prompt still describes the image', imageAltText(''), 'Grok Imagine result');
    t.equal('and so does a missing one', imageAltText(null), 'Grok Imagine result');
    t.ok('a prompt exactly at the cap is not truncated',
      imageAltText('x'.repeat(140)) === 'x'.repeat(140));

    t.group('the card gets the capped alt, not the prompt');
    let created2;
    ({ syncCardImage, imageAltText, created: created2 } = sandbox());
    card = new FakeCard();
    syncCardImage(card, 'a.jpg', long);
    t.ok('on first paint', card.img.alt.length <= 140, card.img.alt.length);
    t.equal('matching imageAltText', card.img.alt, imageAltText(long));
    syncCardImage(card, 'b.jpg', long);
    t.ok('and on a recycled card too', card.img.alt.length <= 140, card.img.alt.length);
    t.ok('which really was recycled', created2.length === 1, created2.length);

    t.group('the stylesheet bounds the box regardless of the alt');
    const src = readSource();
    // The cap is a second line of defence; this is the first, and it holds while the image is
    // still loading as well as when it has failed.
    t.ok('the card thumbnail is size-contained',
      /\.grok-result-card > img \{[^}]*contain: size/.test(src), 'contain: size missing');
    t.ok('scoped to the direct child, so compact strip thumbnails are untouched',
      !/\.grok-result-card img \{[^}]*contain: size/.test(src));
    t.ok('the lightbox image uses the capped alt too',
      /grok-lightbox-media[^`]*alt="\$\{escapeHtml\(imageAltText\(post\.prompt\)\)\}"/.test(src),
      'lightbox alt not capped');
    t.ok('and the lightbox prompt cannot grow without limit',
      /\.grok-lightbox-prompt \{[^}]*max-height:[^}]*overflow-y: auto/.test(src),
      'lightbox prompt unbounded');
  },
};
