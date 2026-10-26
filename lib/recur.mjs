// Регулярные задачи: правила в _регулярные.md, по одному на строку.
// - Рутина [проект:: Работа.md] [исполнитель:: Ника] [дни:: пн, вт, ср, чт, пт] [каждые:: 1] [с:: 2026-10-26] [создано по:: 2026-10-26] ^r0001
// - Отчёт [проект:: Работа.md] [число:: 31] [с:: 2026-10-26] ^r0002
// [пауза:: да] — правило на паузе. [создано по::] — день, за который задача уже создана: так генерация не повторяется.

import { isValidDate, fieldValue } from './md.mjs';

export const DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const LINE_RE = /^[-*+] (?!\[.\])(.*)$/;
const FIELD_RE = /\[([^\[\]:]+?)::\s*([^\]]*?)\s*\]/g;
const ID_RE = /\s\^(r\d+)\s*$/;

const dayNum = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const isoOf = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
// Понедельник = 1 … воскресенье = 7
export const weekday = (iso) => ((Math.floor(dayNum(iso)) + 3) % 7) + 1;
const monday = (iso) => dayNum(iso) - (weekday(iso) - 1);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function parseRules(text) {
  const out = [];
  for (const l of String(text || '').split(/\r?\n/)) {
    const m = LINE_RE.exec(l);
    if (!m) continue;
    const idm = ID_RE.exec(' ' + m[1]);
    if (!idm) continue;
    const rest = (' ' + m[1]).slice(0, idm.index);
    const f = {};
    for (const x of rest.matchAll(FIELD_RE)) if (!(x[1].trim() in f)) f[x[1].trim()] = x[2];
    const days = String(f['дни'] || '').toLowerCase().split(/[\s,]+/).map((d) => DAYS.indexOf(d) + 1).filter((d) => d > 0);
    out.push({
      id: idm[1],
      title: rest.replace(FIELD_RE, '').replace(/\s{2,}/g, ' ').trim(),
      file: f['проект'] || '',
      assignee: f['исполнитель'] || '',
      tag: f['тэг'] || '',
      kind: f['число'] !== undefined ? 'month' : 'week',
      days: [...new Set(days)].sort(),
      every: Math.max(1, parseInt(f['каждые'], 10) || 1),
      day: Math.min(31, Math.max(1, parseInt(f['число'], 10) || 1)),
      start: f['с'] || '',
      paused: String(f['пауза'] || '').trim().toLowerCase() === 'да',
      last: f['создано по'] || '',
    });
  }
  return out;
}

export function formatRule(r) {
  const parts = ['-', fieldValue(r.title)];
  const add = (k, v) => { if (v) parts.push(`[${k}:: ${fieldValue(v)}]`); };
  add('проект', r.file);
  add('исполнитель', r.assignee);
  add('тэг', r.tag);
  if (r.kind === 'month') add('число', String(r.day));
  else { add('дни', r.days.map((d) => DAYS[d - 1]).join(', ')); add('каждые', String(r.every || 1)); }
  add('с', r.start);
  add('пауза', r.paused ? 'да' : '');
  add('создано по', r.last);
  parts.push(`^${r.id}`);
  return parts.join(' ');
}

const HEADER = '# Регулярные задачи\n\nПравила, по которым борд сам создаёт задачи со сроком на нужный день. Правьте через меню ☰ → «Регулярные задачи».\n\n';

/** Пишет правила, сохраняя заголовок и прочий текст файла; строки правил идут подряд на месте первой. */
export function formatRules(rules, prev = '') {
  const lines = String(prev || '').split(/\r?\n/);
  const isRule = (l) => { const m = LINE_RE.exec(l); return !!m && ID_RE.test(' ' + m[1]); };
  const at = lines.findIndex(isRule);
  const keep = lines.filter((l) => !isRule(l));
  const body = rules.map(formatRule);
  if (!prev || !String(prev).trim()) return HEADER + body.join('\n') + (body.length ? '\n' : '');
  if (at < 0) return keep.join('\n').replace(/\s*$/, '\n\n') + body.join('\n') + (body.length ? '\n' : '');
  const idx = lines.slice(0, at).filter((l) => !isRule(l)).length;
  keep.splice(idx, 0, ...body);
  return keep.join('\n').replace(/\n*$/, '\n');
}

export function nextRuleId(texts) {
  let max = 0;
  for (const t of texts) for (const m of String(t || '').matchAll(/(?:\^|регулярная:: )r(\d+)/g)) max = Math.max(max, Number(m[1]));
  return 'r' + String(max + 1).padStart(4, '0');
}

/** Выпадает ли правило на этот день. Начало («с») — точка отсчёта недель; раньше него задач нет. */
export function occursOn(r, iso) {
  if (!isValidDate(iso)) return false;
  if (r.start && isValidDate(r.start) && dayNum(iso) < dayNum(r.start)) return false;
  if (r.kind === 'month') {
    const [y, m, d] = iso.split('-').map(Number);
    return d === Math.min(r.day, lastDay(y, m));
  }
  if (!r.days.includes(weekday(iso))) return false;
  const every = r.every || 1;
  if (every === 1) return true;
  const base = isValidDate(r.start) ? monday(r.start) : monday(iso);
  return ((monday(iso) - base) / 7) % every === 0;
}

/** Ближайший день правила начиная с from (включительно), не дальше чем через ~2 года. */
export function nextOccurrence(r, from) {
  if (!isValidDate(from)) return '';
  const n0 = dayNum(from);
  for (let i = 0; i < 800; i++) { const iso = isoOf(n0 + i); if (occursOn(r, iso)) return iso; }
  return '';
}

/** Правила, по которым сегодня пора создать задачу. */
export function dueToday(rules, today) {
  return rules.filter((r) => !r.paused && r.title && r.file && (!r.last || r.last < today) && occursOn(r, today));
}

/** Человеческое описание повтора: «пн, ср раз в 2 недели», «каждый будний день», «31 числа (или последний день месяца)». */
export function describe(r) {
  if (r.kind === 'month') return `${r.day} числа каждого месяца${r.day > 28 ? ' (в коротком месяце в последний день)' : ''}`;
  const d = r.days.join(',');
  const days = d === '1,2,3,4,5' ? 'по будням' : d === '1,2,3,4,5,6,7' ? 'каждый день' : r.days.map((x) => DAYS[x - 1]).join(', ');
  return r.every > 1 ? `${days}, раз в ${r.every} нед.` : d === '1,2,3,4,5,6,7' || d === '1,2,3,4,5' ? days : `${days}, каждую неделю`;
}
