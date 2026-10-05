import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeOutput } from '../agent/lib/output.mjs';

const env = (result, o = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.31, result, ...o });
const parse = (stdout, o = {}) => parseClaudeOutput({ stdout, code: 0, signal: null, ...o });

test('output: plain JSON result is accepted with cost (AC-011)', () => {
  assert.deepEqual(parse(env('{"status":"review","text":"Готово"}')), { status: 'review', text: 'Готово', costUsd: 0.31 });
  assert.equal(parse(env('{"status":"needs_info","text":"Какой срок?"}')).status, 'needs_info');
  assert.equal(parse(env('{"status":"failed","text":"нет доступа"}')).status, 'failed');
});

test('output: code fence and surrounding noise are tolerated', () => {
  assert.equal(parse(env('```json\n{"status":"review","text":"x"}\n```')).status, 'review');
  assert.equal(parse(env('Вот ответ: {"status":"review","text":"x"} Спасибо')).text, 'x');
});

test('output: wrong status, empty text, no object -> failed with format reason (AC-013)', () => {
  for (const r of ['{"status":"delegated","text":"x"}', '{"status":"review","text":""}', '{"status":"review"}', '', 'просто текст', '{broken']) {
    const out = parse(env(r));
    assert.equal(out.status, 'failed', r);
    assert.equal(out.text, 'Агент вернул ответ неверного формата', r);
  }
});

test('output: limits and agent errors are failed with fixed reasons', () => {
  assert.equal(parse(env('', { subtype: 'error_max_turns', is_error: true })).text, 'Исчерпан лимит ходов');
  assert.equal(parse(env('', { subtype: 'error_max_budget_usd', is_error: true })).text, 'Исчерпан бюджет');
  const e = parse(env('x'.repeat(500), { is_error: true }));
  assert.equal(e.status, 'failed');
  assert.equal(e.text, `Ошибка агента: ${'x'.repeat(120)}`);
});

test('output: empty or unparseable envelope -> failed (code 0)', () => {
  for (const s of ['', '   ', 'not json', 'null', '42']) assert.deepEqual(parse(s), { status: 'failed', text: 'Некорректный вывод claude' });
});

test('output: non-zero exit without envelope -> failed with the code', () => {
  assert.deepEqual(parseClaudeOutput({ stdout: '', code: 2, signal: null }), { status: 'failed', text: 'claude завершился с кодом 2' });
  assert.equal(parseClaudeOutput({ stdout: 'garbage', code: 1 }).text, 'claude завершился с кодом 1');
  assert.equal(parseClaudeOutput({ stdout: '', code: null, signal: 'SIGKILL' }).text, 'claude завершился с кодом SIGKILL');
});

test('output: a valid envelope wins even with a non-zero code', () => {
  assert.equal(parseClaudeOutput({ stdout: env('{"status":"review","text":"x"}'), code: 1 }).status, 'review');
});

test('output: text is not truncated here (composeNote does that on the server)', () => {
  const long = 'я'.repeat(9000);
  assert.equal(parse(env(JSON.stringify({ status: 'review', text: long }))).text.length, 9000);
});
