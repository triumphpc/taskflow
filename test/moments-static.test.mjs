// Static checks of the Moments welcome and rail wiring without a DOM (no jsdom by design).
// Gestures, layout and animation are verified by hand: test/MANUAL-CHECKLIST.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

test('moments-rail: makeBall builds the number via textContent and the module stays out of data (AC-005 AC-017)', async () => {
  const src = await read('../js/moments-rail.js');
  assert.match(src, /export function makeBall\(/);
  assert.match(src, /\.textContent = String\(n\)/);
  assert.match(src, /no-num/);
  assert.doesNotMatch(src, /innerHTML|\.title|html:/);
  assert.doesNotMatch(src, /model\.js|store\.js/);
});

test('moments-intro: every ball is built by makeBall, no own .ball markup (AC-005)', async () => {
  const src = await read('../js/moments-intro.js');
  assert.match(src, /import \{[^}]*makeBall[^}]*\} from '\.\/moments-rail\.js'/);
  assert.match(src, /makeBall\(/);
  assert.doesNotMatch(src, /class: 'ball'|ball-num/);
});

test('openSheet: overlayClass adds a class to the overlay, closing only on a click on the overlay itself (AC-019)', async () => {
  const ui = await read('../js/ui.js');
  assert.match(ui, /overlayClass = ''/);
  assert.match(ui, /class: overlayClass \? `overlay \$\{overlayClass\}` : 'overlay'/);
  assert.match(ui, /overlay\.addEventListener\('mousedown', \(e\) => \{ if \(e\.target === overlay\) close\(\); \}\)/);
});

test('styles: rail above the sheet and receiving events, intro stays at z-index 70, phone sheet leaves room for the rail (AC-018 AC-019)', async () => {
  const css = await read('../styles.css');
  assert.match(css, /\n\.rail \{[^}]*pointer-events: auto/);
  assert.match(css, /\n\.rail \{[^}]*z-index: 2/);
  assert.match(css, /\n\.rail \{[^}]*height: var\(--rail-h\)/);
  assert.match(css, /\.intro \{[^}]*z-index: 70/);
  assert.match(css, /\.overlay\.overlay-rail \{[^}]*animation: none/);
  assert.match(css, /\.overlay-rail \.sheet \{[^}]*animation: none; position: relative/);
  assert.match(css, /max-height: calc\(92vh - var\(--rail-h\) - 8px\)/);
  assert.match(css, /\.overlay-rail \.sheet-foot \{ padding-bottom: 12px; \}/);
  assert.match(css, /\.moments-task\.has-ball \{[^}]*padding-right: 54px/);
  assert.match(css, /\.moments-body \{ overflow-x: hidden; \}/);
  assert.match(css, /\.moments-ghost \{[^}]*pointer-events: none/);
  assert.match(css, /\.sheet:focus \{ outline: none; \}/);
  assert.match(css, /\.sheet-head h2 \{[^}]*overflow-wrap: anywhere/);
});

test('styles: only transform and opacity animate, will-change only on .ball, reduce-motion rule is intact (AC-036)', async () => {
  const css = await read('../styles.css');
  assert.equal((css.match(/will-change:/g) ?? []).length, 1);
  assert.match(css, /\.ball \{[^}]*will-change: transform/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \* \{ animation-duration: \.001s !important; transition-duration: \.001s !important; \}\n\}/);
});

test('moments-rail: createRailView uses the pure rail helpers, imports only rail.js and dom.js (AC-014 AC-016 AC-017)', async () => {
  const src = await read('../js/moments-rail.js');
  const imports = [...src.matchAll(/^import [^;]*from '([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./dom.js', './rail.js']);
  assert.match(src, /export function createRailView\(/);
  for (const fn of ['railState(', 'railDiff(', 'flightDelta(', 'showsNumber(']) assert.ok(src.includes(fn), fn);
  assert.match(src, /class: 'rail-more'/);
  assert.match(src, /class: 'rail'/);
  assert.doesNotMatch(src, /\bawait\b|\.finished/);
  assert.doesNotMatch(src, /innerHTML|\.title|html:|model\.js|store\.js/);
  assert.match(src, /\.textContent = `\+\$\{/);
});

test('moments-rail: the rail view neither swallows events nor closes anything, settle and destroy are idempotent (AC-019)', async () => {
  const src = await read('../js/moments-rail.js');
  assert.doesNotMatch(src, /stopPropagation|addEventListener|onclick/);
  assert.match(src, /if \(settled\) return/);
  assert.match(src, /if \(destroyed\) return/);
  assert.match(src, /try \{ a\.cancel\(\); \} catch/);
  assert.match(src, /node\.remove\(\)/);
  assert.match(src, /leaving\?\.remove\(\)/);
});

test('moments-rail: only transform and opacity are animated, rail ball lands at the target scale (AC-017 AC-022)', async () => {
  const src = await read('../js/moments-rail.js');
  const frames = [...src.matchAll(/\{ (transform|opacity)[^}]*\}/g)].map((m) => m[1]);
  assert.ok(frames.length > 0);
  assert.doesNotMatch(src, /\b(left|top|width|height|margin)\s*:\s*`/);
  assert.match(src, /scale\(\$\{f\.scale\}\)/);
  assert.match(src, /rotate\(360deg\)/);
});

const queueSrc = async () => {
  const src = await read('../js/moments.js');
  return src.slice(src.indexOf('function openQueue'));
};

test('moments: title and the progress line come from one frozen queue and one date (AC-002 AC-013 AC-029)', async () => {
  const src = await read('../js/moments.js');
  const q = await queueSrc();
  assert.match(src, /const title = sheetTitle\(now, queue\.length\)/);
  assert.match(src, /const greeting = greetingParts\(now, queue\.length\)/);
  assert.match(q, /title,\n/);
  assert.match(q, /`\$\{index \+ 1\} из \$\{queue\.length\}`/);
  assert.doesNotMatch(q, /momentsCandidates|new Date/);
  assert.doesNotMatch(src, /Moments · планирование дня/);
});

test('moments: step() scrolls the sheet body to the top and moves focus to the sheet, tabindex -1 (AC-030)', async () => {
  const q = await queueSrc();
  assert.match(q, /'tabindex': '-1'|tabindex: '-1'|setAttribute\('tabindex', '-1'\)/);
  assert.match(q, /body\.scrollTop = 0/);
  assert.match(q, /sheet\.focus\(\{ preventScroll: true \}\)/);
  assert.match(q, /classList\.add\('moments-body'\)/);
});

test('moments: the model is called exactly as before, once per answer (AC-024 AC-032)', async () => {
  const src = await read('../js/moments.js');
  for (const call of ['M.updateTask(task.id, patch)', 'M.toggleDone(task.id)', 'M.deleteTask(task.id)', 'M.getTask(task.id)']) {
    assert.equal(src.split(call).length - 1, 1, call);
  }
  for (const f of ['model.js', 'store.js', 'sync.js', 'agent.js']) {
    const text = await read(`../js/${f}`);
    assert.doesNotMatch(text, /moments-flow|intro-scene|moments-rail|from '\.\/rail\.js'/, f);
  }
});

test('moments: five answers go through gate.lock, the picker change and the editor through gate.ifIdle (AC-021 AC-025)', async () => {
  const q = await queueSrc();
  assert.match(q, /const gate = createGate\(\)/);
  assert.match(q, /const answer = \(act\) => \{\s*if \(index >= queue\.length\) return false;[^\n]*\n\s*return gate\.lock\(\(\) => \{\s*act\(\);\s*go\(/);
  assert.equal((q.match(/\banswer\(/g) ?? []).length, 5, 'five answer paths');
  assert.match(q, /onDone: \(\) => answer\(\(\) => \{\s*stats\.planned\+\+/);
  assert.match(q, /answer\(\(\) => \{\s*const res = M\.toggleDone\(task\.id\);\s*stats\.done\+\+/);
  assert.match(q, /answer\(\(\) => \{\s*M\.deleteTask\(task\.id\);\s*stats\.deleted\+\+/);
  assert.equal((q.match(/answer\(\(\) => \{ stats\.skipped\+\+; \}\)/g) ?? []).length, 2, 'inbox skip and footer skip');
  assert.match(q, /onChange: \(v\) => gate\.ifIdle\(\(\) => \{/);
  assert.match(q, /gate\.ifIdle\(\(\) => \{ sheetRef\.close\(\); openEditor\(task\.id\); \}\)/);
});

test('moments: M.toggleDone and M.deleteTask are called only inside answer(), data is written before go() (AC-024 AC-025)', async () => {
  const q = await queueSrc();
  for (const call of ['M.toggleDone(', 'M.deleteTask(']) {
    const at = q.indexOf(call);
    assert.ok(at > 0, call);
    assert.ok(q.slice(Math.max(0, at - 80), at).includes('answer(() => {'), `${call} sits right inside answer()`);
  }
  assert.doesNotMatch(q, /\bnext\(\)/);
  assert.doesNotMatch(q, /onclick: \(\) => \{[^}]*(stats\.|M\.)/);
  assert.match(q, /const go = \(kind\) => \{/);
});

test('moments: closing is not guarded, onClose closes the gate and releases the session (AC-025 AC-026)', async () => {
  const q = await queueSrc();
  const onClose = q.slice(q.indexOf('function onClose()'), q.indexOf('\n  }\n', q.indexOf('function onClose()')));
  assert.match(onClose, /gate\.close\(\)/);
  assert.match(onClose, /active = false/);
  assert.match(onClose, /ctx\.refresh\(\)/);
  assert.doesNotMatch(onClose, /gate\.(lock|ifIdle)/);
  const ui = await read('../js/ui.js');
  const openSheetSrc = ui.slice(ui.indexOf('export function openSheet'), ui.indexOf('export function confirmSheet'));
  assert.doesNotMatch(openSheetSrc, /gate/);
});

// ---- T15: tray, badge, first ball, skipped intro

test('moments: motion mode opens the sheet with overlay-rail and one rail; colors are frozen once at entry (AC-014 AC-020)', async () => {
  const q = await queueSrc();
  assert.match(q, /const motion = entry !== 'static'/);
  assert.equal((q.match(/queue\.map\(\(t\) => ballColorVar\(t\.priority\)\)/g) ?? []).length, 1);
  assert.match(q, /overlayClass: motion \? 'overlay-rail' : undefined/);
  assert.equal((q.match(/createRailView\(/g) ?? []).length, 1);
  assert.match(q, /if \(motion\) \{[^}]*rail = createRailView\(\{ overlay: sheetRef\.overlay, colors, total: queue\.length, viewW: window\.innerWidth \}\)/);
  assert.match(q, /rail\.show\(entry === 'done' \? -1 : 0\)/);
});

test('moments: static mode has no tray, no badge, no overlay-rail, no transition (AC-012)', async () => {
  const q = await queueSrc();
  const stat = q.slice(q.indexOf('const go = (kind)'), q.indexOf('const answer'));
  assert.match(stat, /if \(!motion\) \{\s*step\(\);\s*gate\.unlock\(\);\s*return;\s*\}/);
  assert.doesNotMatch(q.slice(0, q.indexOf('const motion')), /createRailView|makeBall|overlay-rail/);
  assert.match(q, /badge = motion \? makeBall\(/);
  assert.match(q, /class: motion \? 'moments-task has-ball' : 'moments-task'/);
});

test('moments: the badge shows the queue number, always with its number, only the badge is recolored by the picker (AC-017 AC-020)', async () => {
  const q = await queueSrc();
  assert.match(q, /makeBall\(\{ n: index \+ 1, colorVar: colors\[index\], d: 44, showNum: true \}\)/);
  assert.match(q, /classList\.add\('moments-ball'\)/);
  assert.match(q, /if \(v\.priority !== null\) badge\?\.style\.setProperty\('--c', `var\(\$\{ballColorVar\(v\.priority\)\}\)`\)/);
  assert.doesNotMatch(q, /rail\.[a-z]*\([^)]*priority/);
  assert.match(await read('../js/moments.js'), /import \{ ballColorVar \} from '\.\/pyramid\.js'/);
  assert.match(await read('../js/moments.js'), /import \{ makeBall, createRailView \} from '\.\/moments-rail\.js'/);
});

test('moments: after the timer the first ball rolls out under the gate, after a skip it is already on the card (AC-008 AC-009)', async () => {
  const q = await queueSrc();
  assert.match(q, /else if \(entry === 'done'\) gate\.lock\(\(\) => runFirst\(\)\)/);
  assert.match(q, /function runFirst\(\)/);
  const first = q.slice(q.indexOf('function runFirst()'), q.indexOf('function runTransition'));
  assert.match(first, /transitionPlan\('first'\)/);
  assert.match(first, /rail\.advance\(-1, 0, \{ target, plan \}\)/);
  assert.ok(first.indexOf('discOf(') < first.indexOf('enterSheet()'), 'the target is measured before the sheet entry animation');
  assert.match(q, /else \{\s*step\(\);\s*rail\.show\(0\);\s*enterSheet\(\);\s*\}/);
  assert.match(q, /sheetRef\.sheet\.animate\(/);
});

test('moments: a locked gate puts inert on the new slide and the footer button, as a second line only (AC-025)', async () => {
  const q = await queueSrc();
  assert.match(q, /slide\.inert = on/);
  assert.match(q, /skipBtn\.inert = on/);
  assert.match(q, /setInert\(true\)/);
  assert.match(q, /setInert\(false\)/);
  assert.match(q, /const skipBtn = h\('button'/);
});

test('moments: no await before .finished, only allSettled and a watchdog (AC-027)', async () => {
  const src = await read('../js/moments.js');
  assert.doesNotMatch(src, /\bawait\b/);
  assert.match(src, /Promise\.allSettled\(list\.map\(\(a\) => a\.finished\)\)\.then\(settle\)/);
  assert.match(src, /setTimeout\(settle, ms \+ 300\)/);
});

// ---- T16: transition between cards

test('moments: every path goes through one runTransition built on transitionPlan (AC-021 AC-023)', async () => {
  const q = await queueSrc();
  assert.match(q, /const go = \(kind\) => \{\s*const from = index;\s*index\+\+;/);
  assert.match(q, /runTransition\(from, kind\)/);
  assert.equal((q.match(/function runTransition\(/g) ?? []).length, 1);
  const run = q.slice(q.indexOf('function runTransition'));
  assert.match(run, /const plan = transitionPlan\(kind\)/);
  for (const k of ['plan.exit', 'plan.ghostBall', 'plan.enter']) assert.ok(run.includes(k), k);
  assert.doesNotMatch(run.slice(0, run.indexOf('\n  }\n')), /duration: \d{2,}|delay: \d{2,}/, 'no magic durations');
  assert.match(q, /rail\.advance\(from, index, \{ target, plan \}\)/);
});

test('moments: the ghost is a handlerless clone, aria-hidden and inert, removed on settle (AC-022)', async () => {
  const q = await queueSrc();
  assert.match(q, /oldSlide\.cloneNode\(true\)/);
  assert.match(q, /class: 'moments-ghost'/);
  assert.match(q, /'aria-hidden': 'true'/);
  assert.match(q, /ghost\.inert = true/);
  assert.match(q, /ghost\.remove\(\)/);
  assert.match(q, /visibility = 'hidden'/);
  assert.match(q, /visibility = ''/);
  assert.match(q, /translateY\(24px\)/);
  assert.match(q, /fill: 'backwards'/);
});

test('moments: settle starts with the closed check and is idempotent (AC-027)', async () => {
  const q = await queueSrc();
  assert.match(q, /const settle = \(\) => \{\s*if \(gate\.state === 'closed'\) return;\s*if \(settled\) return;/);
  assert.match(q, /const watchdog = setTimeout\(settle, ms \+ 300\)|watchdog = setTimeout\(settle, ms \+ 300\)/);
});

test('moments: after the last answer the ghost leaves and the summary shows, the rail is not advanced (AC-028)', async () => {
  const q = await queueSrc();
  assert.match(q, /kind !== 'last'/);
  assert.match(q, /День распланирован/);
  assert.match(q, /if \(kind !== 'last'\) \{[\s\S]*?rail\.advance/);
});

// ---- T17: closing and failures

test('moments: onClose is complete and safe to call twice (AC-027)', async () => {
  const q = await queueSrc();
  const i = q.indexOf('function onClose()');
  const onClose = q.slice(i, q.indexOf('\n  }\n', i));
  for (const part of ['gate.close()', 'clearTimeout(watchdog)', 'try { a.cancel(); } catch', 'rail?.destroy()', 'active = false', 'ctx.refresh()']) {
    assert.ok(onClose.includes(part), part);
  }
  assert.match(onClose, /for \(const a of anims\)/);
  assert.ok(onClose.indexOf('gate.close()') < onClose.indexOf('ctx.refresh()'));
});

test('moments: runTransition and runFirst fall back to an instant card change on a failure (AC-027)', async () => {
  const q = await queueSrc();
  for (const name of ['function runFirst()', 'function runTransition(']) {
    const i = q.indexOf(name);
    const body = q.slice(i, i + 3200);
    assert.match(body, /try \{/, name);
    assert.match(body, /catch \{\s*recover\(/, name);
  }
  const rec = q.slice(q.indexOf('function recover('));
  assert.match(rec, /a\.cancel\(\)/);
  assert.match(rec, /gate\.unlock\(\)/);
  assert.match(rec, /step\(\)/);
});

test('moments: the editor link and closing never go through the transition guard (AC-026 AC-027)', async () => {
  const q = await queueSrc();
  assert.match(q, /gate\.ifIdle\(\(\) => \{ sheetRef\.close\(\); openEditor\(task\.id\); \}\)/);
  assert.doesNotMatch(q, /onClose: \(\) => gate/);
});

// ---- review iteration 1

test('moments-rail: advance tracks animations at once and resyncs the tray on a failure (AC-027)', async () => {
  const src = await read('../js/moments-rail.js');
  assert.match(src, /const track = \(a\) => \{ anims\.push\(a\); return a; \}/);
  assert.doesNotMatch(src, /anims\.push\(\.\.\.fresh\)/);
  assert.match(src, /state = next;/);
  assert.match(src, /catch \(e\) \{\s*show\(to\);[^\n]*\n\s*throw e;/);
  assert.match(src, /while \(node\.firstChild\) node\.firstChild\.remove\(\)/);
});

test('moments: recover resyncs the tray, settle always releases the gate, ghost ignores the border (AC-027)', async () => {
  const q = await queueSrc();
  const rec = q.slice(q.indexOf('function recover('), q.indexOf('function runFirst'));
  assert.match(rec, /rail\?\.show\(Math\.min\(index, queue\.length\)\)/);
  assert.match(q, /try \{ done\(\); \} finally \{\s*setInert\(false\);\s*gate\.unlock\(\);/);
  assert.match(q, /sheetBox\.left - sheetRef\.sheet\.clientLeft/);
  assert.match(q, /sheetBox\.top - sheetRef\.sheet\.clientTop/);
});

test('moments: the summary ends the session of answers, skip is hidden there (AC-028)', async () => {
  const q = await queueSrc();
  assert.match(q, /if \(index >= queue\.length\) return false;/);
  assert.match(q, /skipBtn\.style\.display = 'none'/);
});

test('styles: the +K chip is placed by one rule in the intro and 8px lower in the tray (AC-009)', async () => {
  const css = await read('../styles.css');
  assert.match(css, /\.rail-more \{[^}]*left: 0; top: 0;/);
  assert.match(css, /\.rail \.ball, \.rail \.rail-more \{ top: 8px; \}/);
});
