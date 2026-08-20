#!/usr/bin/env node
// Сервер TaskFlow: раздаёт статику и обслуживает /api для синхронизации задач.
//   node serve.mjs [порт]
// Переменные окружения:
//   PORT           — порт (по умолчанию 8787)
//   HOST           — адрес прослушивания (по умолчанию 127.0.0.1; на VPS за
//                    обратным прокси этого достаточно и наружу торчать не надо)
//   TASKFLOW_DATA  — каталог с данными (по умолчанию ./data)
//   TASKFLOW_TOKEN — токен доступа к API; если не задан, берётся из data/token.txt
//                    или генерируется при первом запуске

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyncStore, readBody } from './sync.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = resolve(process.env.TASKFLOW_DATA || join(ROOT, 'data'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const store = await new SyncStore(DATA_DIR).init();

const sendJson = (res, code, payload) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(payload));
};

async function handleApi(req, res, url) {
  const route = url.pathname.slice('/api'.length) || '/';

  // Проверка живости — единственный маршрут без токена: по нему клиент
  // отличает «сервер синхронизации есть» от «это просто статика».
  if (route === '/ping') {
    sendJson(res, 200, { ok: true, app: 'taskflow', schema: 1 });
    return;
  }

  if (!store.checkToken(req.headers.authorization)) {
    sendJson(res, 401, { error: 'Неверный токен' });
    return;
  }

  if (route === '/state' && req.method === 'GET') {
    sendJson(res, 200, store.snapshot());
    return;
  }

  if (route === '/sync' && req.method === 'POST') {
    let incoming;
    try {
      incoming = JSON.parse(await readBody(req) || '{}');
    } catch (err) {
      sendJson(res, 400, { error: `Некорректный JSON: ${err.message}` });
      return;
    }
    if (!Array.isArray(incoming.tasks) && !Array.isArray(incoming.deleted)) {
      sendJson(res, 400, { error: 'Ожидались поля tasks и deleted' });
      return;
    }
    sendJson(res, 200, await store.sync(incoming));
    return;
  }

  sendJson(res, 404, { error: 'Нет такого метода' });
}

async function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  const filePath = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  // Каталог данных лежит внутри проекта, а раздавать его нельзя:
  // там и задачи, и токен доступа к API.
  if (filePath === DATA_DIR || filePath.startsWith(DATA_DIR + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }

  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }

  const body = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    // Service worker должен уметь управлять всей областью приложения.
    'Service-Worker-Allowed': '/',
  }).end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await handleStatic(req, res, url);
  } catch (err) {
    if (res.headersSent) return;
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(err));
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`TaskFlow → http://${shown}:${PORT}`);
  console.log(`Данные: ${DATA_DIR}`);
  console.log(`Токен синхронизации: ${store.token}`);
  console.log('Вставьте его в Настройки → Синхронизация на каждом устройстве.');
});
