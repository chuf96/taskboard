// Разбор и запись задач в .md-файлах проектов.
// Задача = строка чеклиста без отступа + строки описания с отступом под ней.

export const STATUS_BY_CHAR = { ' ': 'new', '/': 'progress', '?': 'waiting', 'x': 'closed', 'X': 'closed' };
export const CHAR_BY_STATUS = { new: ' ', progress: '/', waiting: '?', closed: 'x' };
export const FIELD = { assignee: 'исполнитель', created: 'создана', taken: 'взята', waiting: 'ждём с', deadline: 'вернуться до', closed: 'закрыта', result: 'результат', deleted: 'удалена' };
export const DATE_KEYS = ['created', 'taken', 'waiting', 'deadline', 'closed'];
export const DEFAULT_OVERDUE_DAYS = 3;
const KNOWN_KEYS = new Set(Object.values(FIELD));

const TASK_RE = /^([-*+]) \[(.)\](?: (.*))?$/;
const FIELD_RE = /\[([^\[\]:]+?)::\s*([^\]]*?)\s*\]/g;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Блок-якорь Obsidian в конце строки задачи: ^t0042. Служит постоянным ID задачи.
const BLOCK_ID_RE = /\s\^([A-Za-z0-9-]+)\s*$/;
const BOARD_ID_RE = /\s\^t(\d+)\s*$/gm;

/** Следующий ID задачи: больше всех ^tNNNN во всех переданных текстах. */
export function nextTaskId(texts) {
  let max = 0;
  for (const text of texts) for (const m of String(text || '').matchAll(BOARD_ID_RE)) max = Math.max(max, Number(m[1]));
  return 't' + String(max + 1).padStart(4, '0');
}

/** Значение поля Dataview в одну строку и без квадратных скобок, которые сломали бы разбор. */
export function fieldValue(v) {
  return String(v ?? '').replace(/\s*\n\s*/g, ' ').replace(/\[/g, '(').replace(/\]/g, ')').trim();
}

export function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(/\r?\n/), eol };
}

export function isValidDate(s) {
  const m = DATE_RE.exec(s || '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const isIndented = (l) => /^[ \t]/.test(l) && l.trim() !== '';
const isBlank = (l) => l.trim() === '';

/** Разбирает строку задачи. Возвращает null, если строка не задача. */
export function parseTaskLine(line) {
  const m = TASK_RE.exec(line);
  if (!m) return null;
  const [, bullet, char, full = ''] = m;
  const bm = BLOCK_ID_RE.exec(' ' + full);
  const id = bm ? bm[1] : '';
  const rest = bm ? (' ' + full).slice(0, bm.index).trim() : full;
  const fields = {};
  const extra = [];
  for (const f of rest.matchAll(FIELD_RE)) {
    const key = f[1].trim();
    if (KNOWN_KEYS.has(key) && !(key in fields)) fields[key] = f[2];
    else extra.push(f[0]);
  }
  const title = rest.replace(FIELD_RE, '').replace(/\s{2,}/g, ' ').trim();
  return {
    bullet, char, title,
    status: STATUS_BY_CHAR[char] || 'error',
    assignee: fields[FIELD.assignee] ?? '',
    created: fields[FIELD.created] ?? '',
    taken: fields[FIELD.taken] ?? '',
    waiting: fields[FIELD.waiting] ?? '',
    deadline: fields[FIELD.deadline] ?? '',
    closed: fields[FIELD.closed] ?? '',
    result: fields[FIELD.result] ?? '',
    deleted: fields[FIELD.deleted] ?? '',
    id, extra,
  };
}

export function formatTaskLine(t) {
  const parts = [`${t.bullet || '-'} [${t.char}]`, t.title.trim()];
  const add = (key, v) => { if (v) parts.push(`[${key}:: ${v}]`); };
  add(FIELD.assignee, t.assignee);
  add(FIELD.created, t.created);
  add(FIELD.taken, t.taken);
  add(FIELD.waiting, t.waiting);
  add(FIELD.deadline, t.deadline);
  add(FIELD.closed, t.closed);
  add(FIELD.result, t.result);
  add(FIELD.deleted, t.deleted);
  parts.push(...(t.extra || []));
  if (t.id) parts.push(`^${t.id}`);
  return parts.filter(Boolean).join(' ');
}

/** Находит конец блока задачи, начинающейся на строке i (исключительно). */
function blockEnd(lines, i) {
  let end = i + 1;
  let j = i + 1;
  while (j < lines.length) {
    if (isIndented(lines[j])) { end = j + 1; j++; continue; }
    if (isBlank(lines[j])) { j++; continue; }
    break;
  }
  return end;
}

function dedent(lines) {
  const ind = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0]);
  if (!ind.length) return { text: lines.join('\n').trim() ? lines.join('\n') : '', unit: '    ' };
  let common = ind[0];
  for (const s of ind) while (!s.startsWith(common)) common = common.slice(0, -1);
  return { text: lines.map((l) => (l.startsWith(common) ? l.slice(common.length) : l.trimStart())).join('\n'), unit: common || '    ' };
}

/** Разбирает файл проекта. */
export function parseProject(text, fileName) {
  const { lines } = splitLines(text);
  const h1 = lines.find((l) => /^# \S/.test(l));
  const title = h1 ? h1.slice(2).trim() : fileName.replace(/\.md$/i, '');
  const tasks = [];
  for (let i = 0; i < lines.length; i++) {
    const t = parseTaskLine(lines[i]);
    if (!t) continue;
    const end = blockEnd(lines, i);
    const d = dedent(lines.slice(i + 1, end));
    tasks.push({ ...t, line: lines[i], lineNo: i, endNo: end, description: d.text, indentUnit: d.unit });
    i = end - 1;
  }
  return { title, tasks };
}

const dayNum = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };

/**
 * «Пора напомнить»: только для «Ожидания ответа».
 * 1) указан срок «вернуться до» — просрочено, если сегодня позже срока (правило 2 тогда не применяется);
 * 2) срока нет — просрочено, если с «ждём с» прошло overdueDays дней или больше.
 */
export function isOverdue(t, now = today(), overdueDays = DEFAULT_OVERDUE_DAYS) {
  if (t.status !== 'waiting') return false;
  if (t.deadline) return isValidDate(t.deadline) && dayNum(now) > dayNum(t.deadline);
  if (!isValidDate(t.waiting)) return false;
  return dayNum(now) - dayNum(t.waiting) >= overdueDays;
}

/** Порядок записи файлов: сначала туда, куда добавляется, потом откуда убирается, удаления последними. */
export function writeOrder(changes, to = 'after', from = 'before') {
  const rank = (c) => {
    if (c[to] === null) return 3;
    if (c[from] === null) return 0;
    return c[to].length >= c[from].length ? 1 : 2;
  };
  return changes.map((c, i) => [rank(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

export function validateTask(t, people) {
  const errors = [];
  if (t.status === 'error') errors.push(`Неизвестный символ статуса «[${t.char}]»`);
  for (const [k, label] of [['created', 'Дата создания'], ['taken', 'Дата взятия'], ['waiting', 'Дата «ждём с»'], ['deadline', 'Срок «вернуться до»'], ['closed', 'Дата закрытия']]) {
    if (t[k] && !isValidDate(t[k])) errors.push(`${label} в неверном формате: «${t[k]}»`);
  }
  if (deadlineBeforeWaiting(t)) errors.push(`Срок «вернуться до» раньше даты «ждём с»`);
  if (t.assignee && people && !people.includes(t.assignee)) errors.push(`Исполнителя «${t.assignee}» нет в справочнике`);
  return errors;
}

/** Ищет задачу по исходной строке; при дублях берёт ближайшую к lineNo. */
export function findTask(text, ref) {
  const { tasks } = parseProject(text, '');
  const same = tasks.filter((t) => t.line === ref.line);
  if (!same.length) return null;
  same.sort((a, b) => Math.abs(a.lineNo - (ref.lineNo ?? 0)) - Math.abs(b.lineNo - (ref.lineNo ?? 0)));
  return same[0];
}

function join(lines, eol) { return lines.join(eol); }

/** Строки блока задачи (строка + описание с отступом). */
export function taskBlock(t) {
  const out = [formatTaskLine(t)];
  if (t.description && t.description.trim()) {
    const unit = t.indentUnit || '    ';
    for (const l of t.description.replace(/\s+$/, '').split('\n')) out.push(l.trim() ? unit + l : '');
  }
  return out;
}

/** Применяет изменения к задаче с автоматическими датами по правилам PRD. */
export function applyPatch(t, patch, now = today()) {
  const n = { ...t };
  if ('title' in patch) n.title = String(patch.title).replace(/\s*\n\s*/g, ' ').trim() || t.title;
  if ('assignee' in patch) n.assignee = patch.assignee || '';
  if ('description' in patch) n.description = patch.description || '';
  if ('status' in patch && patch.status !== t.status) {
    n.status = patch.status;
    n.char = CHAR_BY_STATUS[patch.status];
    if (patch.status === 'progress' && !n.taken) n.taken = now;
    if (patch.status === 'closed') n.closed = n.closed && isValidDate(n.closed) ? n.closed : now;
    else { n.closed = ''; n.result = ''; }
    // «Ждём с» ставится при каждом входе в ожидание; при выходе из него оба поля ожидания очищаются
    if (patch.status === 'waiting') n.waiting = now;
    else if (t.status === 'waiting') { n.waiting = ''; n.deadline = ''; }
  }
  for (const k of DATE_KEYS) if (k in patch) n[k] = patch[k] || '';
  // «Результат» есть только у закрытых задач
  if (n.status === 'closed' && 'result' in patch) n.result = fieldValue(patch.result).slice(0, 300);
  // «Вернуться до» не может быть раньше «ждём с»: при ручной правке такой срок стирается
  if (('deadline' in patch || 'waiting' in patch) && deadlineBeforeWaiting(n)) { n.deadline = ''; n.rejected = 'deadline'; }
  return n;
}

export function deadlineBeforeWaiting(t) {
  return isValidDate(t.deadline) && isValidDate(t.waiting) && t.deadline < t.waiting;
}

/** Заменяет блок задачи новыми строками. */
export function replaceBlock(text, t, newLines) {
  const { lines, eol } = splitLines(text);
  lines.splice(t.lineNo, t.endNo - t.lineNo, ...newLines);
  return join(lines, eol);
}

/** Удаляет блок задачи из текста, возвращает { text, block }. */
export function removeBlock(text, t) {
  const { lines, eol } = splitLines(text);
  const block = lines.slice(t.lineNo, t.endNo);
  lines.splice(t.lineNo, t.endNo - t.lineNo);
  return { text: join(lines, eol), block };
}

/** Вставляет строки перед задачей before или после последней задачи. */
export function insertBlock(text, blockLines, before) {
  const { lines, eol } = splitLines(text);
  let at;
  if (before) at = before.lineNo;
  else {
    const { tasks } = parseProject(text, '');
    if (tasks.length) at = tasks[tasks.length - 1].endNo;
    else {
      // в конец файла, отбросив хвостовые пустые строки и оставив одну пустую перед задачами
      while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
      if (lines.length) lines.push('');
      at = lines.length;
      lines.push('');
    }
  }
  lines.splice(at, 0, ...blockLines);
  let out = join(lines, eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

export function appendBlock(text, blockLines) {
  const { eol } = splitLines(text || '\n');
  let out = (text || '').replace(/\s+$/, '');
  out += (out ? eol : '') + blockLines.join(eol) + eol;
  return out;
}

/** Справочник исполнителей: строки списка `- Имя`. */
export function parsePeople(text) {
  const out = [];
  for (const l of splitLines(text || '').lines) {
    const m = /^[-*+] (?!\[.\])(.+)$/.exec(l);
    if (m && m[1].trim() && !out.includes(m[1].trim())) out.push(m[1].trim());
  }
  return out;
}

export function formatPeople(people, text) {
  // Сохраняем заголовок/прочий текст, заменяем только список
  const lines = splitLines(text || '').lines.filter((l) => !/^[-*+] (?!\[.\])(.+)$/.test(l));
  while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
  const head = lines.length ? lines : ['# Исполнители'];
  return [...head, '', ...people.map((p) => `- ${p}`), ''].join('\n');
}

export function renameH1(text, name) {
  const { lines, eol } = splitLines(text);
  const i = lines.findIndex((l) => /^# \S/.test(l));
  if (i >= 0) lines[i] = `# ${name}`;
  else lines.unshift(`# ${name}`, '');
  return join(lines, eol);
}
