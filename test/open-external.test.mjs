// Links open in a separate tab and never navigate the app window itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openExternal, isWebUrl } from '../js/dom.js';

function fakeDoc() {
  const clicks = [];
  const body = { kids: [], append(el) { this.kids.push(el); el.parent = this; } };
  return {
    clicks,
    body,
    createElement: () => ({
      style: {},
      click() { clicks.push({ href: this.href, target: this.target, rel: this.rel }); },
      remove() { body.kids = body.kids.filter((k) => k !== this); },
    }),
  };
}

test('openExternal clicks a detached _blank anchor and cleans up', () => {
  const doc = fakeDoc();
  assert.equal(openExternal('https://example.com/a?b=1', doc), true);
  assert.deepEqual(doc.clicks, [{ href: 'https://example.com/a?b=1', target: '_blank', rel: 'noopener noreferrer' }]);
  assert.equal(doc.body.kids.length, 0);
});

test('openExternal refuses non-web schemes', () => {
  const doc = fakeDoc();
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '', null, 'ftp://x']) {
    assert.equal(openExternal(bad, doc), false, String(bad));
  }
  assert.equal(doc.clicks.length, 0);
  assert.equal(isWebUrl('HTTP://x.ru'), true);
});

test('link code never falls back to navigating the app window', async () => {
  const src = (await readFile(new URL('../js/dom.js', import.meta.url), 'utf8'))
    .replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/location\.href\s*=/.test(src), 'no location.href assignment');
  assert.ok(!/window\.open\(/.test(src), 'no window.open: returns null in iOS PWA');
});
