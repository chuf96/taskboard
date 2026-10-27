// Журнал действий: logs/ГГГГ-ММ-ДД.md, одна строка на событие.
// Событие: { project?, task?, id?, text, kind?, from?, to?, what?, external?, result? }.
// Строка читается человеком, а в конце несёт поля Dataview для разбора скриптом или агентом:
// - 14:57 · Доработки · «Меню» · статус: Ожидание ответа → Закрыто [id:: t0042] [событие:: статус] [из:: waiting] [в:: closed]
// result пишется полем [результат:: …] в строке события закрытия.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { today, fieldValue } from './md.mjs';
import { HEALTH, daysBetween } from './roadmap.mjs';

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
  add('раздел', e.section);
  add('событие', e.kind);
  add('из', e.from);
  add('в', e.to);
  add('что', e.what);
  add('дней', e.days);
  add('здоровье', e.health);
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
  if (!!a.focus !== !!b.focus) out.push(ev('фокус', b.focus ? 'добавлена в фокус' : 'убрана из фокуса', a.focus ? 'да' : 'нет', b.focus ? 'да' : 'нет'));
  // Результат при закрытии пишется под событием закрытия, иначе — отдельным событием
  if (!closing && (a.result || '') !== (b.result || '')) {
    if (b.result) out.push(ev('результат', `результат: ${b.result}`, a.result, b.result));
    else if (b.status === 'closed') out.push(ev('результат', 'результат стёрт', a.result, ''));
  }
  if (explicitDates) {
    // Даты, которые проставляются/стираются автоматически при смене статуса, отдельной строкой не пишем
    const changed = a.status !== b.status;
    const auto = { taken: b.status === 'progress' && !a.taken, closed: changed, cancelled: changed, waiting: changed, deadline: changed && a.status === 'waiting' && !b.deadline };
    for (const [k, label] of [['due', 'срок'], ['created', 'дата создания'], ['taken', 'дата взятия'], ['waiting', 'ждём с'], ['deadline', 'вернуться до'], ['closed', 'дата закрытия'], ['cancelled', 'дата отмены']]) {
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

// ---------- дорожная карта ----------
export const pointName = (p) => (p.pre ? `[${p.pre}] ` : '') + p.title;
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/** События изменения одной контрольной точки. */
export function pointChanges(project, a, b) {
  const out = [];
  const ev = (kind, text, from, to, more) => ({ project, task: pointName(b), id: b.id, section: 'roadmap', text, kind, from, to, ...more });
  if (a.title !== b.title) out.push(ev('название', `название: «${a.title}» → «${b.title}»`, a.title, b.title));
  if (a.pre !== b.pre) out.push(ev('префикс', `префикс: ${a.pre || '—'} → ${b.pre || '—'}`, a.pre, b.pre));
  if (a.owner !== b.owner) out.push(ev('владелец', `владелец: ${a.owner || '—'} → ${b.owner || '—'}`, a.owner, b.owner));
  if ((a.desc || '').trim() !== (b.desc || '').trim()) out.push(ev('описание', 'описание изменено'));
  if (a.start !== b.start) out.push(ev('старт', `старт работ: ${ru(a.start)} → ${ru(b.start)}`, a.start, b.start));
  const healthChanged = a.health !== b.health;
  let healthLogged = false;
  if (a.ind && !b.ind) out.push(ev('реальный срок', `срок стал реальным: ${ru(b.plan)}, сдвиги считаются от него`, a.plan, b.plan));
  else if (!a.ind && b.ind) out.push(ev('индикативный срок', `срок стал индикативным: ${ru(b.plan)}`, a.plan, b.plan));
  else if (a.plan !== b.plan) {
    if (b.ind) out.push(ev('срок', `индикативный срок: ${ru(a.plan)} → ${ru(b.plan)}`, a.plan, b.plan));
    else {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(a.plan) && /^\d{4}-\d{2}-\d{2}$/.test(b.plan) ? daysBetween(a.plan, b.plan) : 0;
      out.push(ev('сдвиг', `сдвиг: ${ru(a.plan)} → ${ru(b.plan)} (${signed(d)} дн.), здоровье: ${HEALTH[b.health]}`, a.plan, b.plan, { days: signed(d), health: HEALTH[b.health] }));
      healthLogged = true;
    }
  }
  if (healthChanged && !healthLogged) out.push(ev('здоровье', `здоровье: ${HEALTH[a.health]} → ${HEALTH[b.health]}`, HEALTH[a.health], HEALTH[b.health], { health: HEALTH[b.health] }));
  if (!a.closed && b.closed) out.push(ev('закрытие точки', `закрыта ${ru(b.closed)}`, '', b.closed));
  else if (a.closed && !b.closed) out.push(ev('открытие точки', 'открыта снова', a.closed, ''));
  else if (a.closed !== b.closed) out.push(ev('дата закрытия', `дата закрытия: ${ru(a.closed)} → ${ru(b.closed)}`, a.closed, b.closed));
  for (const x of b.after) if (!a.after.includes(x)) out.push(ev('связь', `связь добавлена: после ${x}`, '', x));
  for (const x of a.after) if (!b.after.includes(x)) out.push(ev('связь', `связь удалена: после ${x}`, x, ''));
  if ((a.task || '') !== (b.task || '')) out.push(ev('задача', b.task ? `связана с задачей ${b.task}` : 'связь с задачей снята', a.task, b.task));
  return out;
}

/**
 * Сравнивает точки во всех файлах: { file: { title, points } } до и после.
 * Точки сопоставляются по ID, поэтому перенос в другой проект — одно событие.
 */
export function diffPoints(before, after, suffix = '', external = false) {
  const index = (snap) => {
    const m = new Map();
    for (const [file, v] of Object.entries(snap || {})) for (const p of v.points || []) m.set(p.id, { p, project: v.title, file });
    return m;
  };
  const a = index(before), b = index(after);
  const events = [];
  for (const [id, x] of b) {
    const old = a.get(id);
    if (!old) { events.push({ project: x.project, task: pointName(x.p), id, section: 'roadmap', text: `контрольная точка создана, срок ${ru(x.p.plan)}${x.p.ind ? ' (индикативный)' : ''}`, kind: 'создание точки', to: x.p.plan }); continue; }
    if (old.file !== x.file) events.push({ project: x.project, task: pointName(x.p), id, section: 'roadmap', text: `перенесена из «${old.project}»`, kind: 'перенос точки', from: old.project, to: x.project });
    events.push(...pointChanges(x.project, old.p, x.p));
  }
  for (const [id, x] of a) if (!b.has(id)) events.push({ project: x.project, task: pointName(x.p), id, section: 'roadmap', text: 'контрольная точка удалена', kind: 'удаление точки' });
  for (const e of events) { if (suffix) e.text += suffix; if (external) e.external = true; }
  return events;
}
