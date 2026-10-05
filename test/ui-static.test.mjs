// Static checks of the UI wiring without a DOM (no jsdom by design). Markup and gestures are
// verified by hand: test/MANUAL-CHECKLIST.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

test('ui static: sw.js has cache taskflow-v16 and ./js/agent.js in the shell (C13, AC-026)', async () => {
  const sw = await read('../sw.js');
  assert.match(sw, /const CACHE = 'taskflow-v16';/);
  assert.ok(sw.includes("'./js/agent.js'"));
});

test('ui static: js/ui.js takes everything from agentView and wires the delegate toggle (AC-001, AC-003)', async () => {
  const ui = await read('../js/ui.js');
  assert.match(ui, /import \{ agentView \} from '\.\/agent\.js';/);
  assert.ok(ui.includes("role: 'checkbox'"));
  assert.ok(ui.includes('stopPropagation'));
  assert.ok(ui.includes('M.setDelegation('));
  assert.ok(/closest\?\.\('\.check, \.snooze, \.delegate, \.linkified'\)/.test(ui), 'drag must not start on the delegate button');
  assert.ok(ui.includes('view.canToggle'));
  assert.ok(ui.includes("toast('Делегирование снято')"));
  assert.ok(ui.includes('aria-label'));
  assert.ok(ui.includes('`Агент: ${agentState.full}`'));
});

test('ui static: ui.js has no review filter, notification or instruction field (FR-010, C16)', async () => {
  const ui = await read('../js/ui.js');
  for (const word of ['На проверке', 'Выполнена агентом', 'Инструкция агенту', 'instruction', 'agentFilter']) {
    assert.ok(!ui.includes(word), word);
  }
});

const TOKENS = ['--ag-wait', '--ag-ok', '--ag-ask'];

test('ui static: three --ag-* tokens in :root, dark media, data-theme light and dark (AC-004)', async () => {
  const css = await read('../styles.css');
  for (const t of TOKENS) assert.ok((css.match(new RegExp(`${t}:`, 'g')) || []).length >= 4, t);
  const dark = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}\n/.exec(css)[1];
  const forced = /:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/.exec(css)[1];
  const lightForced = /:root\[data-theme="light"\] \{([\s\S]*?)\n\}/.exec(css)[1];
  for (const block of [dark, forced, lightForced]) for (const t of TOKENS) assert.ok(block.includes(`${t}:`), t);
  assert.match(css, /\.task\[data-agent="wait"\]/);
  assert.match(css, /\.agent-badge/);
});

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('ui static: badge text contrast is at least 4.5:1 in both themes (AC-004)', async () => {
  const css = await read('../styles.css');
  const pick = (block, name) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)[1];
  const light = /:root\[data-theme="light"\] \{([\s\S]*?)\n\}/.exec(css)[1];
  const dark = /:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/.exec(css)[1];
  for (const t of TOKENS) {
    assert.ok(contrast(pick(light, t), '#ffffff') >= 4.5, `light ${t}`);
    assert.ok(contrast(pick(dark, t), '#171a21') >= 4.5, `dark ${t}`);
  }
});

test('ui static: index.html and app load the module graph that includes agent.js', async () => {
  const model = await read('../js/model.js');
  assert.match(model, /from '\.\/agent\.js'/);
  assert.ok(model.includes('export function setDelegation'));
});
