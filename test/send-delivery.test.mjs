// Файлы поставки режима с отправкой: env.example, шаблон политики, README (M12, C8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSendPolicy, policyState, LIST_KEYS } from '../agent/lib/send-policy.mjs';
import { isSendEnabled } from '../agent/lib/policy.mjs';

const A = (f) => fileURLToPath(new URL(`../agent/${f}`, import.meta.url));

test('delivery: [send] AC-033 env.example ships TASKFLOW_AGENT_SEND=off, no secrets; send mode is opt-in (only "on", SEC03)', async () => {
  const ex = await readFile(A('env.example'), 'utf8');
  assert.match(ex, /^export TASKFLOW_AGENT_SEND=off$/m);
  assert.equal(ex.match(/^export TASKFLOW_AGENT_SEND=/gm).length, 1);
  assert.match(ex, /^# export TASKFLOW_AGENT_SEND_POLICY=$/m);
  // the only exported name with a value is the switch; every other export is empty
  const withValue = ex.split('\n').filter((l) => /^export [A-Z_a-z]+=./.test(l));
  assert.deepEqual(withValue, ['export TASKFLOW_AGENT_SEND=off']);
  // sourcing the shipped file gives "off", so read-only; the variable's absence is read-only too (SEC03)
  assert.equal(isSendEnabled({ TASKFLOW_AGENT_SEND: 'off' }), false);
  assert.equal(isSendEnabled({}), false);
  assert.equal(isSendEnabled({ TASKFLOW_AGENT_SEND: 'on' }), true);
});

test('delivery: send-policy.example.json passes loadSendPolicy as a format: empty lists, limits shown, no values or modes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tf-deliv-'));
  try {
    const raw = await readFile(A('send-policy.example.json'), 'utf8');
    const doc = JSON.parse(raw);
    assert.equal(doc.version, 1);
    assert.deepEqual(Object.keys(doc.allow).sort(), [...LIST_KEYS].sort());
    for (const k of LIST_KEYS) assert.deepEqual(doc.allow[k], []);
    assert.deepEqual(doc.limits, { vk: 3, gitlab_comment: 20, jira: 3, confluence: 2 });
    const copy = join(dir, 'send-policy.json');
    await writeFile(copy, raw, { mode: 0o600 });
    await chmod(copy, 0o600);
    const r = loadSendPolicy(copy);
    assert.equal(r.ok, true);
    assert.equal(policyState(copy), 'empty');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('delivery: [send] AC-033 README warns about the missing variable and the empty-list rule and covers every M12 point', async () => {
  const readme = await readFile(A('README.md'), 'utf8');
  const low = readme.toLowerCase();
  assert.ok(low.includes('отправка включена только при `on`'));
  assert.ok(!low.includes('при отсутствии переменной режим с отправкой включён'));
  assert.ok(low.includes('пустой белый список блокирует любое действие'));
  assert.ok(low.includes('«не всё выполнено»'));
  for (const frag of [
    'TASKFLOW_AGENT_SEND=off', 'TASKFLOW_AGENT_SEND_POLICY', 'send-policy.json', '0600', 'заблокировано (адресат вне списка)',
    'Выключатель', 'Известные ограничения', 'Аварийная процедура', 'очистите списки', 'тем же сроком', 'Порядок раскатки', 'сервер', 'S1', 'S2', 'S3',
    'run-s1.sh', 'send-policy.example.json', 'Сервер не поддерживает журнал действий',
  ]) assert.ok(readme.includes(frag), frag);
});
