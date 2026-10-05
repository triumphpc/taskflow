import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeTask as clientNormalize } from '../js/store.js';
import { normalizeTask as mcpNormalize } from '../mcp.mjs';

const read = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const NOW = 1_800_000_000_000;
before(() => mock.timers.enable({ apis: ['Date'], now: NOW }));
after(() => mock.timers.reset());

const FORMS = [
  { id: 'a', title: 'minimal' },                                                                           // no kind, source, agentNotes
  { id: 'b', title: 'old inbox', source: { kind: 'gmail', at: 5 }, agentNotes: [{ at: 1, text: 'n' }] },
  { id: 'c', title: 'with block', due: '2026-10-04', agent: { status: 'review', claimedAt: 1, finishedAt: 2, claimToken: null, at: 3 } },
  { id: 'd', title: 'garbage', due: '2026-10-04', agent: { status: 'weird', at: 'x', claimToken: 7 } },
  { id: 'e', title: 'null block', agent: null },
  { id: 'f', title: 'string block', agent: 'delegated' },
  { id: 'g', title: 'cleared', due: '2026-10-04', agent: { status: null, at: 9 } },
  { id: 'h', title: 'repeat', due: '2026-10-04', repeat: { freq: 'daily' }, done: false, subtasks: [{ id: 's1', title: 's' }] },
];

test('parity: client and MCP normalizeTask give identical JSON on all historical forms (AC-024)', () => {
  for (const f of FORMS) assert.equal(JSON.stringify(clientNormalize(f)), JSON.stringify(mcpNormalize(f)), f.id);
});

test('parity: tasks without a block get no agent key (AC-023)', () => {
  for (const f of FORMS.filter((x) => !x.agent || typeof x.agent !== 'object')) {
    assert.ok(!('agent' in clientNormalize(f)), f.id);
    assert.ok(!('agent' in mcpNormalize(f)), f.id);
  }
});

test('parity: garbage in agent becomes status null at 0; valid block is kept', () => {
  assert.deepEqual(clientNormalize(FORMS[3]).agent, { status: null, claimedAt: null, finishedAt: null, claimToken: null, at: 0 });
  assert.equal(clientNormalize(FORMS[2]).agent.status, 'review');
});

test('parity: normalization is idempotent', () => {
  for (const f of FORMS) {
    const once = clientNormalize(f);
    assert.equal(JSON.stringify(clientNormalize(once)), JSON.stringify(once));
  }
});

test('parity: SCHEMA stays 1 in js/store.js, sync.mjs, serve.mjs', async () => {
  assert.match(await read('../js/store.js'), /const SCHEMA = 1;/);
  assert.match(await read('../sync.mjs'), /const SCHEMA = 1;/);
  assert.match(await read('../serve.mjs'), /schema: 1/);
});
