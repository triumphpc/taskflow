// Static checks of the UI wiring without a DOM (no jsdom by design). Markup and gestures are
// verified by hand: test/MANUAL-CHECKLIST.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

test('ui static: sw.js has cache taskflow-v17 and ./js/agent.js in the shell (C13, AC-026)', async () => {
  const sw = await read('../sw.js');
  assert.match(sw, /const CACHE = 'taskflow-v17';/);
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

const fnBody = (src, re) => {
  const i = src.search(re);
  assert.ok(i >= 0, `not found: ${re}`);
  return src.slice(i, i + 900);
};

test('ui static: scheduler asks for time only when needsTimeStep, in render and setDate (AC-005 AC-006 AC-007 AC-008 AC-009 AC-010 AC-011)', async () => {
  const src = await read('../js/scheduler.js');
  assert.match(src, /import \{[^}]*needsTimeStep[^}]*\} from '\.\/core\.js'/);
  assert.match(src, /shows\('time'\) && prioReady && dateAnswered && needsTimeStep\(date\)/);
  const setDate = fnBody(src, /function setDate\(/);
  assert.match(setDate, /needsTimeStep\(next\)/);
  assert.match(setDate, /emit\('date', !askTime\)/);
  assert.doesNotMatch(src, /dateAnswered && date\) \{/);
});

test('ui static: only setDate resets the time, set() from quick input keeps it (AC-012 AC-013)', async () => {
  const src = await read('../js/scheduler.js');
  assert.match(fnBody(src, /function setDate\(/), /time = timeAfterDayPick\(next, time\)/);
  const setFn = src.slice(src.indexOf('set(next = {}'), src.indexOf('Мигнуть шагом'));
  assert.ok(setFn.length > 50);
  assert.doesNotMatch(setFn, /timeAfterDayPick|time = null/);
});

test('ui static: composer submit closes the window and shows the Open toast, no form reset left (AC-001 AC-002 AC-003 AC-004)', async () => {
  const src = await read('../js/ui.js');
  const i = src.indexOf('const submit = () => {');
  assert.ok(i > 0);
  const submit = src.slice(i, src.indexOf('// Enter добавляет задачу', i));
  assert.match(submit, /M\.createTask\(/);
  assert.ok(submit.indexOf('picker.nudge(pending); return;') > 0 && submit.indexOf('picker.nudge(pending)') < submit.indexOf('M.createTask('), 'unready form returns before create and close (AC-002)');
  assert.match(submit, /ui\.close\(\)/);
  assert.match(submit, /toast\('Задача добавлена', \{ actionLabel: 'Открыть'/);
  assert.ok(submit.indexOf('ui.close()') > submit.indexOf('M.createTask('));
  assert.doesNotMatch(submit, /input\.value = ''|picker\.set\(|syncFoot\(\)|input\.focus\(\);\s*toast/);
  assert.doesNotMatch(src, /Окно не закрывается после Enter/);
  assert.match(src, /когда выбрано «Сегодня»\./);
  assert.doesNotMatch(src, /когда в Moments выбрано/);
});

test('ui static: --ball-none is defined in every theme block that defines --p1..--p4, ball styles exist (AC-019)', async () => {
  const css = await read('../styles.css');
  const withP4 = (css.match(/--p4:/g) ?? []).length;
  const withNone = (css.match(/--ball-none:/g) ?? []).length;
  assert.equal(withP4, 4);
  assert.equal(withNone, withP4);
  for (const sel of ['.intro', '.ball', '.ball-num', '.intro-rack']) assert.ok(css.includes(`${sel} {`), sel);
  assert.match(css, /\.intro \{[^}]*z-index: 70/);
  assert.match(css, /\.ball-num \{[^}]*background: #fff/);
});

test('ui static: moments-intro reads matchMedia per call, skips on click and capture keydown, builds numbers via textContent (AC-016 AC-017 AC-020)', async () => {
  const src = await read('../js/moments-intro.js');
  const fn = src.slice(src.indexOf('export function introAllowed'), src.indexOf('export function playIntro'));
  assert.match(fn, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(fn, /Element\.prototype\.animate/);
  const top = src.replace(fn, '');
  assert.doesNotMatch(top, /matchMedia/);
  assert.match(src, /addEventListener\('click'/);
  assert.doesNotMatch(src, /pointerdown/);
  assert.match(src, /addEventListener\('keydown', onKey, true\)/);
  assert.match(src, /removeEventListener\('keydown', onKey, true\)/);
  assert.match(src, /e\.preventDefault\(\)/);
  assert.match(src, /e\.stopPropagation\(\)/);
  assert.match(src, /e\.repeat/);
  assert.match(src, /\.textContent = String\(b\.n\)/);
  assert.doesNotMatch(src, /\.title|innerHTML|html:/);
  assert.doesNotMatch(src, /model\.js|store\.js/);
  assert.match(src, /if \(current\) return current/);
  assert.match(src, /if \(finished\) return/);
  assert.match(src, /setTimeout\(\(\) => finish\('done'\), intro\.total\)/);
});

test('ui static: sw.js is taskflow-v17 and the shell lists pyramid.js and moments-intro.js, which exist (AC-023)', async () => {
  const sw = await read('../sw.js');
  assert.match(sw, /const CACHE = 'taskflow-v17';/);
  assert.doesNotMatch(sw, /taskflow-v16/);
  for (const f of ['./js/pyramid.js', './js/moments-intro.js']) {
    assert.ok(sw.includes(`'${f}'`), f);
    assert.ok((await read(f.replace('./', '../'))).length > 100, `${f} exists`);
  }
});

test('ui static: openMoments counts the queue once, branches empty / reduced / animated, guards with busy (AC-014 AC-018 AC-020)', async () => {
  const src = await read('../js/moments.js');
  const start = src.indexOf('export function openMoments');
  const body = src.slice(start, src.indexOf('function openEmpty'));
  assert.match(src, /let busy = false/);
  assert.match(body, /if \(busy\) return/);
  assert.equal((src.match(/momentsCandidates\(/g) ?? []).length, 1);
  assert.ok(body.indexOf('openEmpty()') < body.indexOf('introAllowed()'), 'empty queue is handled before the animation');
  assert.match(body, /if \(!introAllowed\(\)\) return openQueue\(queue\)/);
  assert.match(body, /playIntro\(queue\)\.finally\(\(\) => \{ busy = false; openQueue\(queue\); \}\)/);
  assert.match(src, /import \{ introAllowed, playIntro \} from '\.\/moments-intro\.js'/);
  assert.match(src, /onClose: \(\) => ctx\.refresh\(\)/);
});
