// Клиент MCP-инструментов TaskFlow для демона делегирования: JSON-RPC по HTTP.
// Различает отказ сервера (TaskflowRejected: штатный ответ, повторять нельзя) и недоступность
// (TaskflowUnavailable: сеть, 5xx, таймаут, мусор). Токен не попадает в тексты ошибок.
// Сервер MCP работает без сессий, поэтому initialize перед tools/call не нужен (spike U5).

export class TaskflowRejected extends Error {
  constructor(reason) {
    super(`Сервер отклонил операцию: ${reason}`);
    this.name = 'TaskflowRejected';
    this.reason = reason;
  }
}

export class TaskflowUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskflowUnavailable';
  }
}

const REJECT = /^AGENT_REJECTED:([a-z_]+)$/;

/** Ответ может прийти обычным JSON или как SSE с одним событием message. */
function parseBody(text, contentType) {
  if ((contentType || '').includes('text/event-stream')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

export function createTaskflowClient({ url, token, fetchImpl = fetch, timeoutMs = 15_000 }) {
  let nextId = 1;

  async function callTool(name, args) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
        signal: ctl.signal,
      });
      text = await res.text();
    } catch (err) {
      throw new TaskflowUnavailable(ctl.signal.aborted ? `таймаут ${timeoutMs} мс` : `сеть: ${err?.cause?.code || err?.name || 'ошибка'}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500) throw new TaskflowUnavailable(`сервер ответил ${res.status}`);
    if (res.status === 401 || res.status === 403) throw new TaskflowUnavailable(`сервер отклонил доступ (${res.status})`);
    let msg;
    try { msg = parseBody(text, res.headers.get('content-type')); } catch { throw new TaskflowUnavailable('неразбираемый ответ сервера'); }
    if (!msg || msg.error || !msg.result) throw new TaskflowUnavailable('ответ без результата');
    const out = msg.result.content?.[0]?.text;
    if (typeof out !== 'string') throw new TaskflowUnavailable('ответ без текста');
    if (msg.result.isError) {
      const m = REJECT.exec(out.trim());
      if (m) throw new TaskflowRejected(m[1]);
      throw new TaskflowUnavailable('инструмент вернул ошибку');
    }
    try { return JSON.parse(out); } catch { throw new TaskflowUnavailable('неразбираемый ответ инструмента'); }
  }

  return {
    queue: ({ today, taskId } = {}) => callTool('agent_queue', { today, ...(taskId !== undefined ? { task_id: taskId } : {}) }),
    claim: ({ id, today }) => callTool('agent_claim', { task_id: id, today }),
    // journal (журнал отправок) уходит только если задан: запрос без него побайтно прежний.
    finish: ({ id, claimToken, status, text, journal }) => callTool('agent_finish', { task_id: id, claim_token: claimToken, status, text, ...(journal !== undefined ? { journal } : {}) }),
    reap: ({ id, journal }) => callTool('agent_finish', { task_id: id, by_ttl: true, ...(journal !== undefined ? { journal } : {}) }),
  };
}
