// Contract of the existing MCP tools: the output on a fixture without an `agent` block is compared
// byte for byte with test/golden/<tool>.txt (NFR-007, AC-027). Isolated store in a temp dir.
process.env.TZ = 'Europe/Moscow';
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeStore, installFetch } from './helpers/inproc.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = JSON.parse(await readFile(join(here, 'fixtures/legacy-tasks.json'), 'utf8'));
const NOW = new Date(2026, 9, 4, 9, 0, 0).getTime();
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const ID = (n) => `a${String(n).padStart(7, '0')}-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const T = { 1: 'a1000001', 2: 'a1000002', 3: 'a1000003', 4: 'a1000004', 5: 'a1000005', 6: 'a1000006', 7: 'a1000007', 8: 'a1000008', 9: 'a1000009' };

process.env.TASKFLOW_API = 'http://127.0.0.1:1';
const { TOOLS } = await import('../mcp.mjs');

const CASES = {
  tasks_list: [{}, { section: 'today', verbose: true }, { section: 'tomorrow' }, { section: 'upcoming' }, { section: 'all' },
    { section: 'done' }, { section: 'overdue' }, { section: 'nope' }],
  task_get: [{ task: T[3] }, { task: 'врачу' }, { task: 'Купить' }, { task: 'нет такой' }, { task: '' }],
  task_add: [
    { title: 'Новая задача', due: 'завтра 18:30', priority: 2 },
    { title: 'С подзадачами', due: '+3', subtasks: ['один', 'два'], repeat: 'weekly', every: 2 },
    { title: 'Без даты' },
    { title: '   ' },
    { title: 'Повтор без даты', repeat: 'daily' },
    { title: 'Плохая дата', due: '2026-02-31' },
    { title: 'Непонятный срок', due: 'когда-нибудь' },
  ],
  task_edit: [
    { task: T[1], title: 'Купить кефир' }, { task: T[1], due: 'послезавтра 10:00', priority: 1 }, { task: T[2], clear_due: true },
    { task: T[3], repeat: 'daily', every: 3 }, { task: T[4], repeat: 'none' }, { task: T[1], title: '  ' }, { task: T[7], notes: 'новые заметки' },
  ],
  task_snooze: [{ task: T[1], due: 'завтра' }, { task: T[3], due: '2026-10-09' }, { task: T[9], due: '+2 07:45' }, { task: T[2], due: '' }],
  task_done: [{ task: T[1] }, { task: T[1], undo: true }, { task: T[1], undo: true }, { task: T[4] }, { task: T[9] }, { task: T[5] }, { task: T[2] }],
  subtask_add: [{ task: T[2], title: 'Первая' }, { task: T[2], title: ' ' }],
  subtask_toggle: [{ task: T[3], subtask: 'Записаться' }, { task: T[3], subtask: 'Найти', done: false }, { task: T[3], subtask: 'нет' }],
  task_delete: [{ task: T[8] }, { task: T[8], confirm: true }],
  inbox_list: [{}, { verbose: true }],
  inbox_add: [
    { title: 'Новое письмо', summary: 'Краткая выжимка', source_kind: 'gmail', source_url: 'https://mail.example/2', source_title: 'Тема', source_ref: 'ref-2' },
    { title: 'Обновлённое письмо', summary: 'Ещё выжимка', source_ref: 'ref-2' },
    { title: 'Без источника' }, { title: ' ' },
  ],
  task_comment: [{ task: T[1], text: 'Проверил цену' }, { task: T[1], text: ' ' }],
};

let restoreFetch;
before(() => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  let n = 0;
  mock.method(globalThis.crypto, 'randomUUID', () => `c${String(++n).padStart(7, '0')}-0000-4000-8000-000000000000`);
});
after(() => { mock.timers.reset(); mock.restoreAll(); restoreFetch?.(); });

// The nine-plus original tools in their original order; new tools are only ever appended (NFR-007).
const EXISTING = ['tasks_list', 'task_get', 'task_add', 'task_edit', 'task_snooze', 'task_done', 'subtask_add',
  'subtask_toggle', 'task_delete', 'inbox_list', 'inbox_add', 'task_comment'];

for (const tool of TOOLS.filter((t) => EXISTING.includes(t.name))) {
  test(`golden ${tool.name}`, async () => {
    const cases = CASES[tool.name];
    assert.ok(cases, `no cases for ${tool.name}`);
    const { store, cleanup } = await makeStore({ tasks: structuredClone(fixture.tasks), deleted: [] });
    restoreFetch?.();
    restoreFetch = installFetch(store);
    let out = '';
    try {
      for (const args of cases) {
        let text;
        try { text = await tool.run(structuredClone(args)); } catch (err) { text = `ERROR: ${err.message}`; }
        out += `### ${JSON.stringify(args)}\n${text}\n\n`;
      }
    } finally { await cleanup(); }
    const file = join(here, 'golden', `${tool.name}.txt`);
    if (UPDATE) { await writeFile(file, out); return; }
    assert.equal(out, await readFile(file, 'utf8'));
  });
}

test('every existing tool has a golden case set; existing order is unchanged, new tools come last (AC-027)', () => {
  assert.deepEqual(TOOLS.slice(0, EXISTING.length).map((t) => t.name), EXISTING);
  assert.deepEqual(EXISTING.filter((n) => !CASES[n]), []);
});
