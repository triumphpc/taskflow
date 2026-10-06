// Адресат и подпись шести send-инструментов (M2). Единственное место, которое знает формы их входа.
// Чистая функция: не бросает исключений, любая ошибка разбора даёт null (gate считает это «адресат не
// определён»). Имена параметров сверены с живыми схемами MCP 2026-10-06 (design.md, «Проверенные схемы»).

import { SEND_TOOLS } from './policy.mjs';

/** @typedef {'vk'|'mr_note'|'mr_discussion'|'mr_reply'|'jira'|'confluence'} Kind */
/** @typedef {'vk'|'gitlab_comment'|'jira'|'confluence'} SlotKind */
/** @typedef {'vk_chats'|'gitlab_projects'|'jira_projects'|'confluence_spaces'} ListKey */
/** @typedef {{ kind: Kind, slot: SlotKind, list: ListKey, key: string, target: string, snippet: string }} Call */

const [VK, MR_NOTE, MR_DISCUSSION, MR_REPLY, JIRA, CONFLUENCE] = SEND_TOOLS;

export const SPECS = Object.freeze({
  [VK]: { kind: 'vk', slot: 'vk', list: 'vk_chats' },
  [MR_NOTE]: { kind: 'mr_note', slot: 'gitlab_comment', list: 'gitlab_projects' },
  [MR_DISCUSSION]: { kind: 'mr_discussion', slot: 'gitlab_comment', list: 'gitlab_projects' },
  [MR_REPLY]: { kind: 'mr_reply', slot: 'gitlab_comment', list: 'gitlab_projects' },
  [JIRA]: { kind: 'jira', slot: 'jira', list: 'jira_projects' },
  [CONFLUENCE]: { kind: 'confluence', slot: 'confluence', list: 'confluence_spaces' },
});

const SNIPPET_MAX = 100;
const TITLE_MAX = 60;
const JIRA_KEY = /^([A-Z][A-Z0-9_]*)-[0-9]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
/** Ключевое поле: непустая строка без управляющих символов. Пробелы не обрезаются: сравнение точное. */
const keyField = (v) => (typeof v === 'string' && v !== '' && !CONTROL.test(v) ? v : null);
/** project_id: строка или целое число, к строке. */
const projectField = (v) => (typeof v === 'number' ? (Number.isSafeInteger(v) && v >= 0 ? String(v) : null) : keyField(v));
const textField = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const posInt = (v, min) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min ? v : null);

/** @returns {Call|null} null: инструмент неизвестен или вход не той формы */
export function describeCall(toolName, toolInput) {
  try {
    const spec = Object.hasOwn(SPECS, toolName) ? SPECS[toolName] : null;
    if (!spec || !isObj(toolInput)) return null;
    const i = toolInput;
    let key; let target; let body;
    switch (spec.kind) {
      case 'vk':
        key = keyField(i.chat_sn); body = textField(i.text);
        target = key && `чат ${key}`;
        break;
      case 'mr_note':
      case 'mr_discussion':
      case 'mr_reply': {
        key = projectField(i.project_id); body = textField(i.body);
        const iid = posInt(i.merge_request_iid, 1);
        if (key === null || iid === null) return null;
        target = `${key}!${iid}`;
        if (spec.kind === 'mr_discussion') {
          const file = keyField(i.file_path); const line = posInt(i.new_line, 1);
          if (file === null || line === null) return null;
          target += ` ${file}:${line}`;
        } else if (spec.kind === 'mr_reply') {
          if (keyField(i.discussion_id) === null) return null;
          target += ' (ответ)';
        }
        break;
      }
      case 'jira': {
        const issue = keyField(i.issueKey);
        const m = issue && JIRA_KEY.exec(issue);
        key = m ? m[1] : null; body = textField(i.comment);
        target = m ? issue : null;
        break;
      }
      case 'confluence': {
        key = keyField(i.space_key); body = textField(i.body);
        const title = textField(i.title);
        if (title === null) return null;
        target = key && `${key}: ${oneLine(title).slice(0, TITLE_MAX)}`;
        break;
      }
      default:
        return null;
    }
    if (!key || !target || body === null) return null;
    const source = spec.kind === 'confluence' ? body.replace(/<[^>]*>/g, ' ') : body;
    return { kind: spec.kind, slot: spec.slot, list: spec.list, key, target: oneLine(target), snippet: oneLine(source).slice(0, SNIPPET_MAX) };
  } catch {
    return null;
  }
}

// GitLab quick actions (/merge, /approve, /close ...) исполняются сервером из текста комментария, VK Teams
// трактует ведущий «/» как команду бота (SEC01, SEC08). Консервативно: любая строка, начинающаяся с «/»
// и буквы или «_» (для VK: с любого «/»), без исключений для блоков кода.
// Проверка построчно (SEC14): класс с \s внутри многострочного ^ давал квадратичное время на «\n»×N. Здесь
// строка не содержит переводов строк, регэксп якорный и без m, значит разбор линеен по длине тела.
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
const QUICK_ACTION_LINE = /^[\s\p{Cc}\p{Cf}]*\/[a-z_]/iu;
const VK_COMMAND_LINE = /^[\s\p{Cc}\p{Cf}]*\//u;
const anyLine = (text, re) => text.split(LINE_BREAK).some((line) => re.test(line));
const QUICK_ACTION = { test: (text) => anyLine(text, QUICK_ACTION_LINE) };
const VK_COMMAND = { test: (text) => anyLine(text, VK_COMMAND_LINE) };
// Макросы Confluence, исполняющие произвольный HTML или подтягивающие чужое содержимое (SEC08).
// Тег режется до ближайшего «>» и проверяется один раз; следующий поиск идёт после него, поэтому
// 40000 незакрытых «<ac:structured-macro » не дают квадрата (атрибуты вложенных начал уже внутри среза).
const MACRO_START = /<ac:structured-macro\b/gi;
const MACRO_TAG = /^<ac:structured-macro\b[^>]*\b(?:ac:)?name\s*=\s*(["'])\s*(?:html|iframe|include|html-include)\s*\1/i;
const DANGEROUS_MACRO = {
  test: (text) => {
    MACRO_START.lastIndex = 0;
    let m;
    while ((m = MACRO_START.exec(text)) !== null) {
      const end = text.indexOf('>', m.index);
      const tag = end === -1 ? text.slice(m.index) : text.slice(m.index, end);
      if (MACRO_TAG.test(tag)) return true;
      if (end === -1) return false;
      MACRO_START.lastIndex = end;
    }
    return false;
  },
};

/**
 * Запрещённое содержимое тела. Чистая функция; ошибка разбора даёт null.
 * @returns {'quick_action'|'macro'|null} фиксированный код причины, текст вызова в него не попадает
 */
export function contentRisk(toolName, toolInput) {
  try {
    const spec = Object.hasOwn(SPECS, toolName) ? SPECS[toolName] : null;
    if (!spec || !isObj(toolInput)) return null;
    switch (spec.kind) {
      case 'mr_note': case 'mr_discussion': case 'mr_reply':
        return typeof toolInput.body === 'string' && QUICK_ACTION.test(toolInput.body) ? 'quick_action' : null;
      case 'vk':
        return typeof toolInput.text === 'string' && VK_COMMAND.test(toolInput.text) ? 'quick_action' : null;
      case 'confluence':
        return typeof toolInput.body === 'string' && DANGEROUS_MACRO.test(toolInput.body) ? 'macro' : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
