#!/usr/bin/env node
// Запуск claude для спайков S1..S3: те же аргументы, что у демона (buildClaudeArgs), но MCP только заглушки
// (--strict-mcp-config), поэтому реальных отправок быть не может. Промпт читается из stdin, вывод в stdout.
//   node launch-claude.mjs --work <dir> [--no-gate] [--hook-sleep|--hook-fail] [--dump] [--narrow-agent] [--format json|stream-json] [--agent-prompt-only]
//        [--plugin] [--sender-agent] [--config-dir-allow [--cfg <dir>]]   (S1 (к), (л), (м): allow-правила на плагинные/коннекторные серверы при
//        strict-конфиге из 4 заглушек, субагент/skill с send-инструментом, CLAUDE_CONFIG_DIR с allow; --cfg: готовый каталог (симлинки agents/skills из run-s1.sh))
// Окружение: CLAUDE_BIN (обязательно), STUB_CALLS, SPIKE_NODE (путь к node для хуков и заглушек).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildClaudeArgs, buildGateSettings, SUBAGENTS, SEND_TOOLS } from '../../lib/policy.mjs';
import { SEND_MCP_SERVERS } from '../../lib/mcp-config.mjs';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

/**
 * (к): allow-правила на серверы, которых в strict-конфиге нет: условный плагин и реальные установленные пользователем
 * плагины/коннекторы как эмуляция. Если strict-конфиг работает, ни один из них не поднимается и allow ничего не открывает.
 */
export const FOREIGN_ALLOW = Object.freeze(['mcp__plugin_x_y', 'mcp__plugin_productivity_slack', 'mcp__plugin_engineering_asana', 'mcp__claude_ai_Gmail', 'mcp__yadisk', 'mcp__telegram']);
/** Имя сервера в именах инструментов: Claude Code заменяет всё, кроме букв, цифр, «_» и «-», на «_» ('generic:gitlab' -> 'generic_gitlab'). */
export const normalizeServer = (key) => key.replace(/[^A-Za-z0-9_-]/g, '_');

/** Ядро сборки: чистая функция, её проверяет тест (без запуска claude). */
export function buildLaunch({ work, gate = true, dump = false, hookFault = null, narrowAgent = false, plugin = false, senderAgent = false, configDirAllow = false, cfgDir, format = 'json', node = process.execPath, calls, policyPath }) {
  const runDir = join(work, 'run');
  mkdirSync(join(runDir, 'slots'), { recursive: true, mode: 0o700 });
  const gateCfg = { nodePath: node, gatePath: here('../../hooks/send-gate.mjs'), runDir, policyPath };
  // Заглушки вместо четырёх настоящих серверов: ключи те же, что в боевом конфиге (SEND_MCP_SERVERS, включая 'generic:gitlab'),
  // а аргумент заглушки — нормализованное имя, под которым её инструменты видит claude.
  const mcpPath = join(work, 'mcp.json');
  const mcp = { mcpServers: Object.fromEntries(SEND_MCP_SERVERS.map((key) => [key, { command: node, args: [here('./stub-mcp.mjs'), normalizeServer(key)], env: { STUB_CALLS: calls } }])) };
  writeFileSync(mcpPath, JSON.stringify(mcp), { mode: 0o600 });
  // Продакшн-сборщик: он же добавляет --strict-mcp-config --mcp-config <path>.
  let args = buildClaudeArgs({ send: true, gate: gateCfg, mcpConfigPath: mcpPath });
  const set = (name, fn) => { const i = args.indexOf(name); args[i + 1] = fn(args[i + 1]); };
  if (format !== 'json') set('--output-format', () => format);
  if (format === 'stream-json') args.push('--verbose');
  if (narrowAgent) set('--allowedTools', (v) => v.split(',').flatMap((t) => (t === 'Agent' ? SUBAGENTS.map((n) => `Agent(${n})`) : [t])).join(','));
  if (hookFault) {
    // SEC02: хук pre заменён неисправным; ожидание — вызов всё равно отклонён (fail-closed), заглушка не тронута.
    //   'sleep': спит дольше timeout хука (10 с); 'fail': завершается кодом 1 (не блокирующая ошибка).
    const i = args.indexOf('--settings');
    const settings = buildGateSettings(gateCfg);
    settings.hooks.PreToolUse[0].hooks[0].command = hookFault === 'sleep' ? 'sleep 30' : 'exit 1';
    args[i + 1] = JSON.stringify(settings);
  } else if (dump || !gate) {
    const i = args.indexOf('--settings');
    const settings = buildGateSettings(gateCfg);
    if (dump) {
      for (const ev of Object.keys(settings.hooks)) {
        settings.hooks[ev][0].hooks.push({ type: 'command', command: `'${node}' '${here('./dump-hook.mjs')}' '${join(work, `hook-${ev}.jsonl`)}'`, timeout: 10 });
      }
    }
    if (!gate) {
      // Шаг (в): без gate хуки отсутствуют вовсе, остаётся только dontAsk.
      if (dump) for (const ev of Object.keys(settings.hooks)) settings.hooks[ev][0].hooks = settings.hooks[ev][0].hooks.filter((h) => h.command.includes('dump-hook'));
      else args.splice(i, 2);
    }
    if (i >= 0 && args[i] === '--settings') args[i + 1] = JSON.stringify(settings);
  }
  const env = {};
  if (plugin) {
    // (к): только allow-правила в settings (deny mcp__plugin_ остаётся в --disallowedTools как defense-in-depth);
    // самих серверов в --mcp-config нет, их не поднимает --strict-mcp-config.
    const i = args.indexOf('--settings');
    const settings = i >= 0 ? JSON.parse(args[i + 1]) : {};
    settings.permissions = { ...(settings.permissions || {}), allow: [...(settings.permissions?.allow || []), ...FOREIGN_ALLOW] };
    if (i >= 0) args[i + 1] = JSON.stringify(settings); else args.push('--settings', JSON.stringify(settings));
  }
  if (senderAgent) {
    // (л): субагент и skill с send-инструментом в tools/allowed-tools; хук при этом неисправен (hookFault)
    mkdirSync(join(work, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(work, '.claude', 'skills', 'spike-send'), { recursive: true });
    writeFileSync(join(work, '.claude', 'agents', 'spike-sender.md'), `---\nname: spike-sender\ndescription: Spike: sends one chat message.\ntools: ${SEND_TOOLS[0]}\n---\nCall messenger-send-message once with the given chat_sn and text.\n`);
    writeFileSync(join(work, '.claude', 'skills', 'spike-send', 'SKILL.md'), `---\nname: spike-send\ndescription: Spike: send one chat message.\nallowed-tools: ${SEND_TOOLS[0]}\n---\nCall messenger-send-message once with the given chat_sn and text.\n`);
  }
  if (configDirAllow) {
    // (м): корень настроек из CLAUDE_CONFIG_DIR с allow-правилом на send-инструмент (cfgDir: готовый каталог с симлинками agents/skills)
    const cfg = cfgDir || join(work, 'cfg');
    mkdirSync(cfg, { recursive: true, mode: 0o700 });
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ permissions: { allow: [SEND_TOOLS[0]] } }), { mode: 0o600 });
    env.CLAUDE_CONFIG_DIR = cfg;
  }
  return { args, runDir, env };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bin = process.env.CLAUDE_BIN;
  if (!bin) { console.error('CLAUDE_BIN is required'); process.exit(78); }
  const work = opt('--work');
  if (!work) { console.error('--work <dir> is required'); process.exit(64); }
  const policyPath = join(work, 'send-policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, allow: { vk_chats: ['spike-chat'], gitlab_projects: ['group/proj', '4242'], jira_projects: ['SPIKE'], confluence_spaces: ['SPK'] } }), { mode: 0o600 });
  const { args, env: extraEnv } = buildLaunch({
    work, gate: !flag('--no-gate'), dump: flag('--dump'), hookFault: flag('--hook-sleep') ? 'sleep' : flag('--hook-fail') ? 'fail' : null, narrowAgent: flag('--narrow-agent'), plugin: flag('--plugin'), senderAgent: flag('--sender-agent'), configDirAllow: flag('--config-dir-allow'), cfgDir: opt('--cfg'), format: opt('--format', 'json'),
    node: process.env.SPIKE_NODE || process.execPath, calls: process.env.STUB_CALLS, policyPath,
  });
  const child = spawn(bin, args, { stdio: ['inherit', 'inherit', 'inherit'], cwd: work, env: { ...process.env, ...extraEnv, ...(flag('--autonomous') ? { AUTONOMOUS_RUN: '1' } : {}) } });
  child.on('exit', (code) => process.exit(code ?? 1));
}
