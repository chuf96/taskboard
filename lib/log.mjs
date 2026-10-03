// Журнал действий: logs/ГГГГ-ММ-ДД.md, одна строка на событие.
// Событие: { project?, task?, id?, text, kind?, from?, to?, what?, external?, result? }.
// Строка читается человеком, а в конце несёт поля Dataview для разбора скриптом или агентом:
// - 14:57 · Доработки · «Меню» · статус: Ожидание ответа → Закрыто [id:: t0042] [событие:: статус] [из:: waiting] [в:: closed]
// result пишется полем [результат:: …] в строке события закрытия.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { today, fieldValue } from './md.mjs';

export const LOG_DIR = 'logs';
export const STATUS_RU = { new: 'Новая', progress: 'В работе', waiting: 'Ожидание ответа', closed: 'Закрыто', cancelled: 'Отменена', error: 'Ошибка' };
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

const ru = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('.') : iso || '—');
const statusRu = (t) => (t.status === 'error' ? `[${t.char}]` : STATUS_RU[t.status]);
const statusCode = (t) => (t.status === 'error' ? `[${t.char}]` : t.status);

export function formatEvent(e, now = new Date()) {
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const parts = [hm];
  if (e.project) parts.push(e.project);
  if (e.task) parts.push(`«${e.task}»`);
  parts.push(e.text);
  const fields = [];
  const add = (k, v) => { const x = fieldValue(v); if (x) fields.push(`[${k}:: ${x}]`); };
  add('id', e.id);
  add('событие', e.kind);
  add('из', e.from);
  add('в', e.to);
  add('что', e.what);
  add('результат', e.result);
  if (e.external) add('источник', 'вне борда');
  const lines = [`- ${parts.join(' · ')}${fields.length ? ' ' + fields.join(' ') : ''}`];
  return lines.join('\n');
}

export function dayHeader(now = new Date()) {
  return `# ${ru(today(now))}, ${WEEKDAYS[now.getDay()]}\n`;
}

export async function appendLog(folder, events, now = new Date()) {
  if (!events.length) return;
  const dir = path.join(folder, LOG_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${today(now)}.md`);
  let head = '';
  try { await fsp.access(file); } catch { head = dayHeader(now) + '\n'; }
  await fsp.appendFile(file, head + events.map((e) => formatEvent(e, now)).join('\n') + '\n', 'utf8');
}

/** События изменения одной задачи. keys — какие даты менялись явно (автоматические даты не пишем отдельно). */
export function taskChanges(project, a, b, { explicitDates = true } = {}) {
  const out = [];
  const task = b.title;
  const id = b.id || a.id;
  const ev = (kind, text, from, to, more) => ({ project, task, id, text, kind, from, to, ...more });
  if (a.title !== b.title) out.push(ev('название', `название: «${a.title}» → «${b.title}»`, a.title, b.title));
  const closing = b.status === 'closed' && (a.status !== b.status || a.char !== b.char);
  if (a.status !== b.status || a.char !== b.char) {
    out.push(ev('статус', `статус: ${statusRu(a)} → ${statusRu(b)}`, statusCode(a), statusCode(b), closing ? { result: b.result } : {}));
  }
  if (a.assignee !== b.assignee) out.push(ev('исполнитель', `исполнитель: ${a.assignee || '—'} → ${b.assignee || '—'}`, a.assignee, b.assignee));
  if ((a.tag || '') !== (b.tag || '')) out.push(ev('тэг', `тэг: ${a.tag || '—'} → ${b.tag || '—'}`, a.tag, b.tag));
  // Результат при закрытии пишется под событием закрытия, иначе — отдельным событием
  if (!closing && (a.result || '') !== (b.result || '')) {
    if (b.result) out.push(ev('результат', `результат: ${b.result}`, a.result, b.result));
    else if (b.status === 'closed') out.push(ev('результат', 'результат стёрт', a.result, ''));
  }
  if (explicitDates) {
    // Даты, которые проставляются/стираются автоматически при смене статуса, отдельной строкой не пишем
    const changed = a.status !== b.status;
    const auto = { taken: b.status === 'progress' && !a.taken, closed: changed, cancelled: changed, waiting: changed, deadline: changed && a.status === 'waiting' && !b.deadline };
    for (const [k, label] of [['created', 'дата создания'], ['taken', 'дата взятия'], ['waiting', 'ждём с'], ['deadline', 'вернуться до'], ['closed', 'дата закрытия'], ['cancelled', 'дата отмены']]) {
      if (a[k] !== b[k] && !auto[k]) out.push(ev(label, `${label}: ${ru(a[k])} → ${ru(b[k])}`, a[k], b[k]));
    }
  }
  return out;
}

/** Сопоставляет задачи до/после: по строке, затем по названию, затем по позиции. */
export function matchTasks(before, after) {
  const pairs = [];
  const restB = new Set(before.map((_, i) => i));
  const restA = new Set(after.map((_, i) => i));
  const take = (pred) => {
    for (const ib of [...restB]) {
      for (const ia of restA) {
        if (pred(before[ib], after[ia], ib, ia)) { pairs.push([before[ib], after[ia]]); restB.delete(ib); restA.delete(ia); break; }
      }
    }
  };
  take((x, y) => x.id && x.id === y.id);
  take((x, y) => x.line === y.line && x.description === y.description);
  take((x, y) => x.line === y.line);
  take((x, y) => x.title === y.title);
  take((x, y, ib, ia) => ib === ia);
  return { pairs, removed: [...restB].map((i) => before[i]), added: [...restA].map((i) => after[i]) };
}

/**
 * Сравнивает снимки папки: { file: { title, tasks } } до и после.
 * Возвращает события, в т.ч. переносы задач между проектами.
 */
export function diffSnapshots(before, after, suffix = '', external = false) {
  const events = [];
  const removedAll = [];
  const addedAll = [];
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const f of files) {
    const b = before[f], a = after[f];
    if (!b) events.push({ project: a.title, text: 'проект создан', kind: 'создание проекта' });
    if (!a) { events.push({ project: b.title, text: 'проект удалён', kind: 'удаление проекта' }); continue; }
    if (b && b.title !== a.title) events.push({ project: a.title, text: `проект переименован: «${b.title}» → «${a.title}»`, kind: 'переименование проекта', from: b.title, to: a.title });
    const m = matchTasks(b ? b.tasks : [], a.tasks);
    for (const [x, y] of m.pairs) events.push(...taskChanges(a.title, x, y));
    removedAll.push(...m.removed.map((t) => ({ t, project: b.title })));
    addedAll.push(...m.added.map((t) => ({ t, project: a.title })));
  }
  for (const r of removedAll) {
    const i = addedAll.findIndex((x) => (r.t.id ? x.t.id === r.t.id : x.t.title === r.t.title) && x.project !== r.project);
    if (i >= 0) {
      const [ad] = addedAll.splice(i, 1);
      events.push({ project: ad.project, task: ad.t.title, id: ad.t.id || r.t.id, text: `перенесена из «${r.project}»`, kind: 'перенос', from: r.project, to: ad.project });
      events.push(...taskChanges(ad.project, r.t, ad.t).filter((e) => !e.text.startsWith('название')));
    } else events.push({ project: r.project, task: r.t.title, id: r.t.id, text: 'удалена', kind: 'удаление' });
  }
  for (const x of addedAll) {
    events.push({ project: x.project, task: x.t.title, id: x.t.id, text: 'создана', kind: 'создание' });
    if (x.t.status === 'closed') events.push({ project: x.project, task: x.t.title, id: x.t.id, text: 'статус: Закрыто', kind: 'статус', to: 'closed', result: x.t.result });
  }
  for (const e of events) { if (suffix) e.text += suffix; if (external) e.external = true; }
  return events;
}

export function diffPeople(before, after, suffix = '', external = false, project = 'Исполнители') {
  const out = [];
  const x = external ? { external: true } : {};
  const kind = project.toLowerCase();
  for (const p of after) if (!before.includes(p)) out.push({ project, text: `добавлен: ${p}${suffix}`, kind, to: p, ...x });
  for (const p of before) if (!after.includes(p)) out.push({ project, text: `удалён: ${p}${suffix}`, kind, from: p, ...x });
  return out;
}
