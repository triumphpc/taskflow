#!/usr/bin/env node
// Заглушка MCP-сервера для спайков S1..S3: те же ПОЛНЫЕ имена инструментов, что у настоящих серверов
// (mcp__<сервер>__<инструмент>), но ничего не отправляет и в сеть не ходит. Каждый вызов дописывается
// строкой JSON в файл вызовов (STUB_CALLS). Один процесс изображает один сервер:
//   node stub-mcp.mjs <сервер>     сервер: mcp-workspace-assistant | generic_gitlab | mcp-jira | mcp-confluence
// Транспорт stdio. Нужен пакет @modelcontextprotocol/sdk (он уже в зависимостях проекта).

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SEND_TOOLS, CONVERTER_TOOL } from '../../lib/policy.mjs';

const str = { type: 'string' };
const num = { type: 'number' };
const schema = (props, required) => ({ type: 'object', properties: props, required });

/** Полное имя -> описание. Схемы повторяют живые схемы MCP (design.md, «Проверенные схемы»). */
export const STUB_TOOLS = Object.freeze({
  [SEND_TOOLS[0]]: { description: 'Отправить сообщение в чат VK Teams (заглушка).', inputSchema: schema({ chat_sn: str, text: str, parse_mode: str }, ['chat_sn', 'text']) },
  [SEND_TOOLS[1]]: { description: 'Добавить заметку в MR (заглушка).', inputSchema: schema({ project_id: str, merge_request_iid: num, body: str }, ['project_id', 'merge_request_iid', 'body']) },
  [SEND_TOOLS[2]]: { description: 'Создать обсуждение в MR (заглушка).', inputSchema: schema({ project_id: str, merge_request_iid: num, body: str, file_path: str, new_line: num, old_line: num }, ['project_id', 'merge_request_iid', 'body', 'file_path', 'new_line']) },
  [SEND_TOOLS[3]]: { description: 'Ответить в обсуждении MR (заглушка).', inputSchema: schema({ project_id: str, merge_request_iid: num, discussion_id: str, body: str }, ['project_id', 'merge_request_iid', 'discussion_id', 'body']) },
  [SEND_TOOLS[4]]: { description: 'Комментарий в Jira (заглушка).', inputSchema: schema({ issueKey: str, comment: str }, ['issueKey', 'comment']) },
  [SEND_TOOLS[5]]: { description: 'Создать страницу Confluence (заглушка).', inputSchema: schema({ space_key: str, title: str, body: str, parent_id: { type: ['string', 'null'] } }, ['space_key', 'title', 'body']) },
  [CONVERTER_TOOL]: { description: 'Markdown в XHTML Confluence (заглушка).', inputSchema: schema({ markdown: str }, ['markdown']) },
});

export const SERVERS = Object.freeze(['mcp-workspace-assistant', 'generic_gitlab', 'mcp-jira', 'mcp-confluence']);
/** SEC13: плагинный сервер (имя как у mcp__plugin_<плагин>_<сервер>); в SERVERS не входит, поднимается только флагом --plugin. */
export const PLUGIN_SERVER = 'plugin_x_y';
const PLUGIN_TOOLS = [{ name: 'ping', description: 'Плагинная заглушка: ничего не делает.', inputSchema: schema({ text: str }, []) }];
export const serverOf = (fullName) => fullName.split('__')[1];
export const toolOf = (fullName) => fullName.split('__').slice(2).join('__');

/** Инструменты одного сервера: короткие имена, как их отдаёт настоящий сервер. */
export function toolsFor(server) {
  if (server === PLUGIN_SERVER) return PLUGIN_TOOLS;
  return Object.entries(STUB_TOOLS).filter(([full]) => serverOf(full) === server)
    .map(([full, t]) => ({ name: toolOf(full), description: t.description, inputSchema: t.inputSchema }));
}

/** Фиксирует вызов и возвращает ответ в форме MCP-блока. Ничего не отправляет. */
export function recordCall(file, server, tool, args) {
  const n = readCalls(file).length + 1;
  appendFileSync(file, `${JSON.stringify({ n, server, tool, args, at: Date.now() })}\n`);
  return { content: [{ type: 'text', text: `stub ok https://stub.example/${server}/${n}` }] };
}

export function readCalls(file) {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function serve(server) {
  const file = process.env.STUB_CALLS;
  if (!file) throw new Error('STUB_CALLS is required');
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const s = new Server({ name: server, version: '0.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(server) }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const known = toolsFor(server).some((t) => t.name === req.params.name);
    if (!known) return { content: [{ type: 'text', text: `no tool ${req.params.name}` }], isError: true };
    return recordCall(file, server, req.params.name, req.params.arguments || {});
  });
  await s.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = process.argv[2];
  if (!SERVERS.includes(server) && server !== PLUGIN_SERVER) { console.error(`usage: stub-mcp.mjs ${SERVERS.join('|')}`); process.exit(64); }
  await serve(server);
}
