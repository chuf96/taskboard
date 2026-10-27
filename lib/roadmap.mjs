// Дорожная карта: контрольные точки в разделе «## RoadMap» файла проекта, релизы, префиксы.
// Точка = строка списка без чекбокса + строки описания с отступом:
// - Синяя кнопка оплаты [префикс:: BA] [владелец:: Ника] [старт:: 2026-10-13] [срок:: 2026-10-30] [первоначальный срок:: 2026-10-23] [здоровье:: есть риски] [сдвигов:: 1] [задача:: t0005] [после:: m0001] ^m0003

import { splitLines, isValidDate, fieldValue } from './md.mjs';

export const SECTION = 'RoadMap';
const SECTION_RE = /^##\s+roadmap\s*$/i;
const HEADING_RE = /^#{1,2}\s/;
const POINT_RE = /^([-*+]) (?!\[.\]( |$))(.+)$/;
const FIELD_RE = /\[([^\[\]:]+?)::\s*([^\]]*?)\s*\]/g;
const BLOCK_ID_RE = /\s\^([A-Za-z0-9-]+)\s*$/;
const POINT_ID_RE = /\s\^m(\d+)\s*$/gm;

export const PFIELD = {
  pre: 'префикс', owner: 'владелец', start: 'старт', plan: 'срок', orig: 'первоначальный срок', ind: 'индикативный',
  health: 'здоровье', shifts: 'сдвигов', closed: 'закрыта', task: 'задача', after: 'после',
};
const KNOWN = new Set(Object.values(PFIELD));

// Здоровье: в файле словами, в интерфейсе кодом g/y/r. Цвета понимаются тоже — на случай ручной правки.
export const HEALTH = { g: 'по плану', y: 'есть риски', r: 'есть проблема' };
const HEALTH_BY_WORD = { 'по плану': 'g', 'есть риски': 'y', 'есть проблема': 'r', 'зелёная': 'g', 'зеленая': 'g', 'жёлтая': 'y', 'желтая': 'y', 'красная': 'r' };
export const healthCode = (w) => HEALTH_BY_WORD[String(w || '').trim().toLowerCase()] || 'g';

const isIndented = (l) => /^[ \t]/.test(l) && l.trim() !== '';
const isBlank = (l) => l.trim() === '';
const dayNum = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
export const daysBetween = (a, b) => Math.round(dayNum(b) - dayNum(a));

/** Следующий ID точки: больше всех ^mNNNN во всех переданных текстах. */
export function nextPointId(texts) {
  let max = 0;
  for (const text of texts) for (const m of String(text || '').matchAll(POINT_ID_RE)) max = Math.max(max, Number(m[1]));
  return 'm' + String(max + 1).padStart(4, '0');
}

/** Границы раздела «## RoadMap»: { head, end } — индексы строк (end исключительно), или null. */
export function findSection(lines) {
  const head = lines.findIndex((l) => SECTION_RE.test(l));
  if (head < 0) return null;
  let end = head + 1;
  while (end < lines.length && !HEADING_RE.test(lines[end])) end++;
  return { head, end };
}

export function parsePointLine(line) {
  const m = POINT_RE.exec(line);
  if (!m) return null;
  const full = ' ' + m[3];
  const bm = BLOCK_ID_RE.exec(full);
  if (!bm || !/^m\d+$/.test(bm[1])) return null;
  const rest = full.slice(0, bm.index).trim();
  const f = {};
  const extra = [];
  for (const x of rest.matchAll(FIELD_RE)) {
    const k = x[1].trim();
    if (KNOWN.has(k) && !(k in f)) f[k] = x[2];
    else extra.push(x[0]);
  }
  const shifts = parseInt(f[PFIELD.shifts], 10);
  return {
    bullet: m[1], id: bm[1],
    title: rest.replace(FIELD_RE, '').replace(/\s{2,}/g, ' ').trim(),
    pre: (f[PFIELD.pre] || '').trim(),
    owner: (f[PFIELD.owner] || '').trim(),
    start: f[PFIELD.start] || '',
    plan: f[PFIELD.plan] || '',
    orig: f[PFIELD.orig] || '',
    ind: (f[PFIELD.ind] || '').trim().toLowerCase() === 'да',
    health: healthCode(f[PFIELD.health]),
    shifts: Number.isFinite(shifts) && shifts > 0 ? shifts : 0,
    closed: f[PFIELD.closed] || '',
    task: (f[PFIELD.task] || '').trim().replace(/^\^/, ''),
    after: (f[PFIELD.after] || '').split(/[,;\s]+/).map((s) => s.replace(/^\^/, '')).filter((s) => /^m\d+$/.test(s)),
    extra,
  };
}

export function formatPointLine(p) {
  const parts = [`${p.bullet || '-'} ${fieldValue(p.title)}`];
  const add = (k, v) => { if (v) parts.push(`[${k}:: ${v}]`); };
  add(PFIELD.pre, p.pre);
  add(PFIELD.owner, p.owner);
  add(PFIELD.start, p.start);
  add(PFIELD.plan, p.plan);
  if (!p.ind) add(PFIELD.orig, p.orig);
  add(PFIELD.ind, p.ind ? 'да' : '');
  add(PFIELD.health, HEALTH[p.health] || HEALTH.g);
  add(PFIELD.shifts, !p.ind && p.shifts ? String(p.shifts) : '');
  add(PFIELD.closed, p.closed);
  add(PFIELD.task, p.task);
  add(PFIELD.after, (p.after || []).join(', '));
  parts.push(...(p.extra || []));
  parts.push(`^${p.id}`);
  return parts.join(' ');
}

export function pointBlock(p) {
  const out = [formatPointLine(p)];
  if (p.desc && p.desc.trim()) for (const l of p.desc.replace(/\s+$/, '').split('\n')) out.push(l.trim() ? (p.indentUnit || '    ') + l.trim() : '');
  return out;
}

/** Разбирает раздел RoadMap файла проекта. has — есть ли раздел (дорожка на карте). */
export function parseRoadmap(text) {
  const { lines } = splitLines(text || '');
  const sec = findSection(lines);
  if (!sec) return { has: false, points: [] };
  const points = [];
  for (let i = sec.head + 1; i < sec.end; i++) {
    const p = parsePointLine(lines[i]);
    if (!p) continue;
    let end = i + 1, j = i + 1;
    while (j < sec.end) {
      if (isIndented(lines[j])) { end = j + 1; j++; continue; }
      if (isBlank(lines[j])) { j++; continue; }
      break;
    }
    const body = lines.slice(i + 1, end).filter((l) => l.trim());
    const unit = body.length ? /^[ \t]*/.exec(body[0])[0] : '    ';
    points.push({ ...p, desc: body.map((l) => l.trim()).join('\n'), indentUnit: unit, lineNo: i, endNo: end, line: lines[i] });
    i = end - 1;
  }
  return { has: true, points };
}

/** Добавляет раздел «## RoadMap» в конец файла, если его нет. */
export function ensureSection(text) {
  const { lines, eol } = splitLines(text || '');
  if (findSection(lines)) return text;
  while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
  lines.push('', `## ${SECTION}`, '');
  return lines.join(eol);
}

/**
 * Вставляет блок точки в раздел RoadMap (раздел создаётся при необходимости):
 * перед точкой beforeId, а без неё — в конец. Порядок точек в разделе = порядок рядов на дорожке.
 */
export function addPoint(text, block, beforeId = '') {
  const { lines, eol } = splitLines(ensureSection(text));
  const sec = findSection(lines);
  const before = beforeId && parseRoadmap(lines.join(eol)).points.find((x) => x.id === beforeId);
  if (before) {
    lines.splice(before.lineNo, 0, ...block);
    let out = lines.join(eol);
    if (!out.endsWith(eol)) out += eol;
    return out;
  }
  let at = sec.end;
  while (at > sec.head + 1 && isBlank(lines[at - 1])) at--;
  // Пустая строка между заголовком раздела и первой точкой
  if (at === sec.head + 1) { lines.splice(at, 0, ''); at++; }
  lines.splice(at, 0, ...block);
  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

// Дата, в которую точка стоит на карте: закрытая — в день закрытия
export const shownDate = (p) => (isValidDate(p.closed) ? p.closed : p.plan);
const byDate = (a, b) => {
  const da = isValidDate(shownDate(a)) ? shownDate(a) : '9999', db = isValidDate(shownDate(b)) ? shownDate(b) : '9999';
  return da < db ? -1 : da > db ? 1 : a.id.localeCompare(b.id);
};

/** Куда поставить новую точку: перед первой, что стоит позже неё. '' — в конец. */
export function placeByDate(text, p) {
  const d = shownDate(p);
  if (!isValidDate(d)) return '';
  return parseRoadmap(text).points.find((x) => isValidDate(shownDate(x)) && shownDate(x) > d)?.id || '';
}

/** Переставляет точку перед beforeId ('' — в конец раздела). */
export function movePoint(text, id, beforeId = '') {
  const p = parseRoadmap(text).points.find((x) => x.id === id);
  if (!p || id === beforeId) return text;
  const { lines, eol } = splitLines(text);
  const block = lines.slice(p.lineNo, p.endNo);
  return addPoint(replacePoint(text, id, null), block, beforeId);
}

/** Раскладывает точки раздела по дате (так карта показывала их до 3.4). Текст без изменений, если порядок уже такой. */
export function sortPointsByDate(text) {
  const pts = parseRoadmap(text).points;
  const sorted = [...pts].sort(byDate);
  if (sorted.every((x, i) => x.id === pts[i].id)) return text;
  let out = text;
  for (let i = sorted.length - 2; i >= 0; i--) out = movePoint(out, sorted[i].id, sorted[i + 1].id);
  return out;
}

/** Заменяет блок точки (newBlock = null — удаляет). */
export function replacePoint(text, id, newBlock) {
  const p = parseRoadmap(text).points.find((x) => x.id === id);
  if (!p) return text;
  const { lines, eol } = splitLines(text);
  lines.splice(p.lineNo, p.endNo - p.lineNo, ...(newBlock || []));
  return lines.join(eol);
}

/** Убирает раздел RoadMap целиком. Возвращает { text, points }. */
export function removeSection(text) {
  const { lines, eol } = splitLines(text);
  const sec = findSection(lines);
  if (!sec) return { text, points: [] };
  const points = parseRoadmap(text).points;
  let from = sec.head;
  while (from > 0 && isBlank(lines[from - 1])) from--;
  lines.splice(from, sec.end - from);
  if (sec.end < splitLines(text).lines.length && from > 0) lines.splice(from, 0, '');
  let out = lines.join(eol);
  if (out && !out.endsWith(eol)) out += eol;
  return { text: out, points };
}

/** Убирает ID из списков «после» всех точек текста. */
export function dropLinks(text, ids) {
  let out = text;
  for (const p of parseRoadmap(text).points.reverse()) {
    const after = p.after.filter((x) => !ids.includes(x));
    if (after.length !== p.after.length) out = replacePoint(out, p.id, pointBlock({ ...p, after }));
  }
  return out;
}

export function validatePoint(p, people) {
  const errors = [];
  if (!isValidDate(p.plan)) errors.push(p.plan ? `Срок в неверном формате: «${p.plan}»` : 'Не указан срок');
  for (const [k, label] of [['start', 'Старт работ'], ['orig', 'Первоначальный срок'], ['closed', 'Дата закрытия']]) if (p[k] && !isValidDate(p[k])) errors.push(`${label} в неверном формате: «${p[k]}»`);
  if (!p.owner) errors.push('Не указан владелец');
  else if (people && !people.includes(p.owner)) errors.push(`Владельца «${p.owner}» нет в справочнике исполнителей`);
  return errors;
}

// ---------- релизы: _релизы.md, строки «- 2026-11-10 [релиз:: 2.3]» ----------
export function parseReleases(text) {
  const out = [];
  for (const l of splitLines(text || '').lines) {
    const m = /^[-*+] (\d{4}-\d{2}-\d{2})\s*\[релиз::\s*([^\]]*?)\s*\]/.exec(l);
    if (m && isValidDate(m[1]) && !out.some((r) => r.date === m[1])) out.push({ date: m[1], name: m[2] });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
export function formatReleases(list, text) {
  const lines = splitLines(text || '').lines.filter((l) => !/^[-*+] \d{4}-\d{2}-\d{2}/.test(l));
  while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
  const head = lines.length ? lines : ['# Релизы', '', 'Плановые релизы на дорожной карте. Ведётся бордом.'];
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
  return [...head, '', ...sorted.map((r) => `- ${r.date} [релиз:: ${fieldValue(r.name)}]`), ''].join('\n');
}

// ---------- префиксы: _префиксы.md, строки «- BA [название:: Бизнес-аналитика] [цвет:: голубой]» ----------
export function parsePrefixes(text) {
  const out = [];
  for (const l of splitLines(text || '').lines) {
    const m = /^[-*+] ([^\s\[]+)(.*)$/.exec(l);
    if (!m || /^\[.\]$/.test(m[1])) continue;
    const f = {};
    for (const x of m[2].matchAll(FIELD_RE)) f[x[1].trim()] = x[2];
    const code = m[1].trim();
    if (code && !out.some((p) => p.code.toLowerCase() === code.toLowerCase())) out.push({ code, name: (f['название'] || '').trim(), color: (f['цвет'] || '').trim() });
  }
  return out;
}
export function formatPrefixes(list, text) {
  const lines = splitLines(text || '').lines.filter((l) => !/^[-*+] [^\s\[]/.test(l));
  while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
  const head = lines.length ? lines : ['# Префиксы', '', 'Коды этапов для контрольных точек дорожной карты.'];
  return [...head, '', ...list.map((p) => `- ${p.code}${p.name ? ` [название:: ${fieldValue(p.name)}]` : ''}${p.color ? ` [цвет:: ${p.color}]` : ''}`), ''].join('\n');
}
export const DEFAULT_PREFIXES = [
  { code: 'BA', name: 'Бизнес-аналитика', color: 'голубой' },
  { code: 'SA', name: 'Системная аналитика', color: 'фиолетовый' },
  { code: 'DEV', name: 'Разработка', color: 'зелёный' },
  { code: 'IFT', name: 'ИФТ', color: 'оранжевый' },
  { code: 'PROM', name: 'ПРОМ', color: 'розовый' },
];
