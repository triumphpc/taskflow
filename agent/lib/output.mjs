// Разбор вывода `claude --output-format json` в {status, text, costUsd?}. Все сбои становятся failed
// с короткой причиной: демон сам ничего не додумывает и не повторяет.

const VALID = ['review', 'needs_info', 'failed'];
const failed = (text, extra = {}) => ({ status: 'failed', text, ...extra });

function parseEnvelope(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return [...v].reverse().find((e) => e && e.type === 'result') || null;
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

function parseResultText(result) {
  const text = String(result ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch { /* ищем объект внутри */ }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

export function parseClaudeOutput({ stdout, code, signal } = {}) {
  const env = parseEnvelope(stdout);
  if (!env) {
    if (code !== 0 && code !== undefined) return failed(`claude завершился с кодом ${code ?? signal ?? 'неизвестно'}`);
    return failed('Некорректный вывод claude');
  }
  const costUsd = typeof env.total_cost_usd === 'number' ? { costUsd: env.total_cost_usd } : {};
  if (env.subtype === 'error_max_turns') return failed('Исчерпан лимит ходов', costUsd);
  if (env.subtype === 'error_max_budget_usd') return failed('Исчерпан бюджет', costUsd);
  if (env.is_error === true) {
    return failed(`Ошибка агента: ${String(env.result ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`, costUsd);
  }
  const obj = parseResultText(env.result);
  const ok = obj && typeof obj === 'object' && VALID.includes(obj.status) && typeof obj.text === 'string' && obj.text.trim() !== '';
  if (!ok) return failed('Агент вернул ответ неверного формата', costUsd);
  return { status: obj.status, text: obj.text, ...costUsd };
}
