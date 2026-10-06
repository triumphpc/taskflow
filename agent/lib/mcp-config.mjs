// MCP-конфиг режима с отправкой: claude запускается с --strict-mcp-config и видит ТОЛЬКО четыре сервера из
// SEND_MCP_SERVERS (спайк S1 (к): deny-префикс mcp__plugin_ не работает, allow-правило открыло плагинный
// инструмент). Описания серверов копируются дословно из user-scope `mcpServers` файла `.claude.json`
// (`<CLAUDE_CONFIG_DIR>/.claude.json`, иначе `~/.claude.json`) во временный <runDir>/mcp.json (0600).
// Файл содержит токены в env/headers: в argv его содержимое не попадает, в логи не пишется (только имена
// серверов), удаляется после прогона claude на любом пути, остатки после SIGKILL убирает sweep (run-dir.mjs).

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_FILE } from './run-dir.mjs';

/** Ключи как в `.claude.json` (дословно): Claude Code сам нормализует 'generic:gitlab' в mcp__generic_gitlab__. Новый сервер: добавить сюда. */
export const SEND_MCP_SERVERS = Object.freeze(['mcp-workspace-assistant', 'mcp-jira', 'mcp-confluence', 'generic:gitlab']);

/** Ошибка конфигурации (exit 78). Причина фиксированная: текст файла и значения в сообщение не попадают. */
export class McpConfigError extends Error {
  constructor(reason) {
    super(`mcp_config: ${reason}`);
    this.name = 'McpConfigError';
    this.code = 'config_error';
    this.reason = reason;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v !== '';

/** Путь файла с user-scope mcpServers: тот же корень, что видит claude (CLAUDE_CONFIG_DIR из его окружения, иначе HOME). */
export const userConfigPath = ({ configDir, home }) => {
  const root = nonEmpty(configDir) ? configDir : home;
  if (!nonEmpty(root)) throw new McpConfigError('no_home');
  return join(root, '.claude.json');
};

const MIN_ARG_SECRET = 6;

/** Строки, которые не должны попасть в лог: значения env и headers, строки args (>= 6), url и значения его query. */
export function mcpSecrets(servers) {
  const out = [];
  for (const cfg of Object.values(servers)) {
    for (const bag of [cfg?.env, cfg?.headers]) {
      if (!isObject(bag)) continue;
      for (const v of Object.values(bag)) if (typeof v === 'string' && v !== '') out.push(v);
    }
    if (Array.isArray(cfg?.args)) for (const a of cfg.args) if (typeof a === 'string' && a.length >= MIN_ARG_SECRET) out.push(a);
    if (nonEmpty(cfg?.url)) {
      out.push(cfg.url);
      try {
        const u = new URL(cfg.url);
        for (const v of u.searchParams.values()) if (v !== '') out.push(v);
        if (u.password) out.push(decodeURIComponent(u.password));
      } catch { /* не разбирается как URL: целиком уже добавлен */ }
    }
  }
  return out;
}

/**
 * @returns {{ config: { mcpServers: object }, found: string[], missing: string[], secrets: string[] }}
 * @throws {McpConfigError} reason: no_home | missing_file | unreadable | invalid | no_servers
 * Отсутствующий сервер из allowlist не ошибка (в `missing` только имя); ни одного сервера: ошибка.
 */
export function buildSendMcpConfig({ configDir, home, servers = SEND_MCP_SERVERS } = {}) {
  const file = userConfigPath({ configDir, home });
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) { throw new McpConfigError(err?.code === 'ENOENT' ? 'missing_file' : 'unreadable'); }
  let doc;
  try { doc = JSON.parse(text); } catch { throw new McpConfigError('invalid'); }
  const all = doc?.mcpServers;
  if (!isObject(all)) throw new McpConfigError(all === undefined ? 'no_servers' : 'invalid');
  const picked = {};
  const missing = [];
  for (const name of servers) {
    if (Object.hasOwn(all, name) && isObject(all[name])) picked[name] = JSON.parse(JSON.stringify(all[name]));
    else missing.push(name);
  }
  const found = Object.keys(picked);
  if (!found.length) throw new McpConfigError('no_servers');
  return { config: { mcpServers: picked }, found, missing, secrets: mcpSecrets(picked) };
}

const LIVE = new Set();

/** <runDir>/mcp.json: флаг wx (не затирает чужое), права 0600. Путь регистрируется для удаления при втором сигнале. @returns {string} путь */
export function writeMcpConfig(runDir, cfg) {
  const path = join(runDir, MCP_FILE);
  writeFileSync(path, JSON.stringify(cfg.config), { flag: 'wx', mode: 0o600 });
  LIVE.add(path);
  return path;
}

/** Удаляет файл (нет файла не ошибка). Из LIVE путь уходит только после успешного удаления; `rm` для подмены в тестах. */
export function removeMcpConfig(path, { rm = rmSync } = {}) {
  try { rm(path, { force: true }); } catch (err) {
    if (err?.code !== 'ENOENT') throw err;                  // путь остаётся в LIVE: exit-обработчик повторит
  }
  LIVE.delete(path);
}

/** Синхронно удаляет все файлы, записанные этим процессом: второй сигнал, выход процесса. */
export function removeAllMcpConfigs() {
  for (const path of [...LIVE]) { try { removeMcpConfig(path); } catch { /* sweep при следующем старте */ } }
}
