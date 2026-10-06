// Заглушка MCP для тестов отправки (C16): «вызвать инструмент» значит дописать строку JSON в файл вызовов.
// Ничего не отправляет и в сеть не ходит. Счётчик вызовов = число строк в файле.
import { appendFileSync, readFileSync } from 'node:fs';

/** Фиксирует вызов и возвращает ответ инструмента в форме MCP-блока (ссылка с номером вызова). */
export function stubCall(file, { tool_name: tool, tool_input: input }) {
  const n = readCalls(file).length + 1;
  appendFileSync(file, `${JSON.stringify({ n, tool, input })}\n`);
  return { content: [{ type: 'text', text: `stub ok https://stub.example/${n}` }] };
}

/** @returns {{ n: number, tool: string, input: object }[]} */
export function readCalls(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}
