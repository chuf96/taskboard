#!/usr/bin/env node
// Task Board — локальный сервер. Без внешних зависимостей, без интернета.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import * as md from './lib/md.mjs';
import * as log from './lib/log.mjs';
import * as rm from './lib/roadmap.mjs';
import * as rc from './lib/recur.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const CONFIG_DIR = process.env.TASKBOARD_HOME || path.join(os.homedir(), '.taskboard');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const BASE_PORT = Number(process.env.TASKBOARD_PORT || 4317);
const NO_OPEN = process.argv.includes('--no-open');
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;

const PEOPLE_FILE = '_исполнители.md';
const TAGS_FILE = '_тэги.md';
const STATS_FILE = '_статистика.md';
const RELEASES_FILE = '_релизы.md';
const PREFIXES_FILE = '_префиксы.md';
const RECUR_FILE = '_регулярные.md';
const ORDER_FILE = '_board.json';
const ARCHIVE_TASKS = path.join('архив', 'задачи');
const ARCHIVE_PROJECTS = path.join('архив', 'проекты');

let port = BASE_PORT;
let config = { last: null, recent: [] };
let folder = null;
let watcher = null;
let snap = { files: {}, people: [] }; // последнее известное состояние папки — для журнала
const clients = new Set();

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

// ---------- конфиг ----------
async function loadConfig() {
  try { config = { ...config, ...JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8')) }; } catch {}
}
async function saveConfig() {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function openFolder(p) {
  const abs = path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw new HttpError(400, 'Папка не найдена');
  folder = abs;
  config.last = abs;
  config.recent = [abs, ...config.recent.filter((r) => r !== abs)].slice(0, 8);
  await saveConfig();
  snap = await takeSnapshot();
  startWatcher();
  migrateSoon();
  statsSoon();
  recurSoon();
}

// ---------- слежение за папкой ----------
function startWatcher() {
  if (watcher) watcher.close();
  watcher = null;
  let timer = null;
  try {
    watcher = fs.watch(folder, () => {
      clearTimeout(timer);
      timer = setTimeout(() => serial(syncExternal).catch((e) => console.error(e)).finally(() => broadcast('change')), 150);
    });
    watcher.on('error', () => {});
  } catch {}
}
function broadcast(event) {
  for (const res of clients) res.write(`event: ${event}\ndata: {}\n\n`);
}

// ---------- файлы ----------
function resolveRel(rel) {
  const abs = path.resolve(folder, rel);
  if (abs !== folder && !abs.startsWith(folder + path.sep)) throw new HttpError(400, 'Недопустимый путь');
  return abs;
}
async function readRel(rel) {
  try { return await fsp.readFile(resolveRel(rel), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function writeRel(rel, content) {
  const abs = resolveRel(rel);
  if (content === null) { await fsp.rm(abs, { force: true }); return; }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, abs);
}

function checkProjectFile(file) {
  if (typeof file !== 'string' || file !== path.basename(file) || !/\.md$/i.test(file) || file.startsWith('_') || file.startsWith('.'))
    throw new HttpError(400, 'Недопустимый файл проекта');
  return file;
}
function checkName(name, what = 'Название') {
  const n = String(name || '').trim();
  if (!n) throw new HttpError(400, `${what} не может быть пустым`);
  if (n.length > 100) throw new HttpError(400, `${what} слишком длинное`);
  return n;
}
function checkGroup(group) {
  const g = String(group || '').replace(/\s+/g, ' ').trim();
  if (g.length > 60) throw new HttpError(400, 'Название группы слишком длинное');
  return g;
}
function checkProjectName(name) {
  const n = checkName(name, 'Название проекта');
  if (/[\\/:*?"<>|]/.test(n) || n.startsWith('.') || n.startsWith('_')) throw new HttpError(400, 'Название содержит недопустимые символы');
  return n;
}

async function listProjectFiles() {
  const ents = await fsp.readdir(folder, { withFileTypes: true });
  return ents.filter((e) => e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith('_') && !e.name.startsWith('.')).map((e) => e.name);
}
// _board.json: { order: [...файлы], settings: { overdueDays } }
async function readBoardJson() {
  try { const o = JSON.parse(await readRel(ORDER_FILE)); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
async function readOrder() { const o = await readBoardJson(); return Array.isArray(o.order) ? o.order : []; }
async function readSettings() {
  const s = (await readBoardJson()).settings || {};
  const d = Number(s.overdueDays);
  return { overdueDays: Number.isInteger(d) && d >= 1 && d <= 365 ? d : md.DEFAULT_OVERDUE_DAYS };
}
// Содержимое _board.json с изменёнными ключами — остальное сохраняется
async function boardJsonWith(patch) { return JSON.stringify({ ...(await readBoardJson()), ...patch }, null, 2) + '\n'; }
async function readPeople() { return md.parsePeople((await readRel(PEOPLE_FILE)) || ''); }
async function readPeopleGroups() { return md.parsePeopleGroups((await readRel(PEOPLE_FILE)) || ''); }
async function readTagList() { return md.parseTags((await readRel(TAGS_FILE)) || ''); }
async function readTags() { return (await readTagList()).map((t) => t.name); }
async function readReleases() { return rm.parseReleases((await readRel(RELEASES_FILE)) || ''); }
// Пока файла префиксов нет, действуют префиксы по умолчанию; файл появится при первой правке справочника
async function readPrefixes() { const t = await readRel(PREFIXES_FILE); return t === null ? rm.DEFAULT_PREFIXES.map((p) => ({ ...p })) : rm.parsePrefixes(t); }
async function readRules() { return rc.parseRules((await readRel(RECUR_FILE)) || ''); }

// Задачи из архива (архив/задачи и архив/проекты) — для счётчиков «Создано/Закрыто»
async function readArchivedTasks() {
  const out = [];
  for (const dir of [ARCHIVE_TASKS, ARCHIVE_PROJECTS]) {
    const ents = await fsp.readdir(path.join(folder, dir), { withFileTypes: true }).catch(() => []);
    for (const e of ents) if (e.isFile() && /\.md$/i.test(e.name)) out.push(...md.parseProject((await readRel(path.join(dir, e.name))) ?? '', e.name).tasks);
  }
  return out;
}
async function readBoardTasks() {
  const out = [];
  for (const f of await listProjectFiles()) out.push(...md.parseProject((await readRel(f)) ?? '', f).tasks);
  return out;
}

// _статистика.md: строка за сегодня обновляется после каждого изменения и раз в несколько минут
async function updateStatsFile() {
  if (!folder) return;
  const before = await readRel(STATS_FILE);
  const after = md.updateStats(before, await readBoardTasks(), await readArchivedTasks(), md.today());
  if (after !== before) await writeRel(STATS_FILE, after);
}
const statsSoon = () => serial(updateStatsFile).catch((e) => console.error(e));
setInterval(statsSoon, 5 * 60 * 1000).unref();

async function uniqueRel(dir, file) {
  const ext = path.extname(file); const base = file.slice(0, -ext.length);
  for (let i = 1; ; i++) {
    const rel = path.join(dir, i === 1 ? file : `${base} (${i})${ext}`);
    if ((await readRel(rel)) === null) return rel;
  }
}

// ---------- доска ----------
async function getBoard() {
  const files = await listProjectFiles();
  const order = await readOrder();
  files.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    return a.localeCompare(b, 'ru');
  });
  const people = await readPeople();
  const peopleGroups = await readPeopleGroups();
  const tagList = await readTagList();
  const tags = tagList.map((t) => t.name);
  const tagColors = Object.fromEntries(tagList.filter((t) => t.color).map((t) => [t.name, t.color]));
  const settings = await readSettings();
  const now = md.today();
  const projects = [];
  for (const file of files) {
    const text = (await readRel(file)) ?? '';
    const p = md.parseProject(text, file);
    const r = rm.parseRoadmap(text);
    const byTask = new Map(r.points.filter((x) => x.task).map((x) => [x.task, x.id]));
    projects.push({
      file, title: p.title, roadmap: r.has,
      points: r.points.map((x) => ({
        id: x.id, title: x.title, pre: x.pre, owner: x.owner, start: x.start, plan: x.plan, orig: x.orig, ind: x.ind,
        health: x.health, shifts: x.shifts, closed: x.closed, task: x.task, after: x.after, desc: x.desc, errors: rm.validatePoint(x, people),
      })),
      tasks: p.tasks.map((t) => ({
        line: t.line, lineNo: t.lineNo, title: t.title, status: t.status, char: t.char, due: t.due, point: (t.id && byTask.get(t.id)) || '',
        assignee: t.assignee, tag: t.tag, focus: t.focus, id: t.id, created: t.created, taken: t.taken, waiting: t.waiting, deadline: t.deadline, closed: t.closed, cancelled: t.cancelled, result: t.result,
        description: t.description, errors: md.validateTask(t, people, tags), overdue: md.isOverdue(t, now, settings.overdueDays), recur: t.recur,
      })),
    });
  }
  const counters = md.dayCounters(projects.flatMap((p) => p.tasks), await readArchivedTasks(), now);
  const recurring = (await readRules()).map((r) => ({
    ...r, next: r.paused ? '' : rc.nextOccurrence(r, r.last && r.last >= now ? addDays(now, 1) : now), text: rc.describe(r),
    errors: ruleErrors(r, files, people, tags),
  }));
  return { folder, name: path.basename(folder), projects, people, peopleGroups, tags, tagColors, counters, today: now, settings, version: VERSION, releases: await readReleases(), prefixes: await readPrefixes(), recurring };
}
const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
function ruleErrors(r, files, people, tags) {
  const e = [];
  if (!files.includes(r.file)) e.push(`Проекта «${r.file.replace(/\.md$/i, '')}» нет на доске: задачи не создаются`);
  if (r.assignee && !people.includes(r.assignee)) e.push(`Исполнителя «${r.assignee}» нет в справочнике`);
  if (r.tag && !tags.includes(r.tag)) e.push(`Тэга «${r.tag}» нет в справочнике`);
  if (r.kind === 'week' && !r.days.length) e.push('Не выбраны дни недели');
  return e;
}

// ---------- операции ----------
// Каждая операция возвращает набор изменений файлов { rel: новоеСодержимое | null }.
// Сервер пишет их и возвращает клиенту before/after для отмены.

async function mustTask(file, ref) {
  const text = await readRel(checkProjectFile(file));
  if (text === null) throw new HttpError(409, 'Файл проекта не найден — доска обновлена');
  const t = md.findTask(text, ref || {});
  if (!t) throw new HttpError(409, 'Задача изменилась в файле — доска обновлена');
  return { text, t };
}

// Выдаёт новые ID задач: следующий после самого большого ^tNNNN на доске и в архиве.
async function idAllocator() {
  const texts = [];
  const dirs = ['', ARCHIVE_TASKS, ARCHIVE_PROJECTS];
  for (const dir of dirs) {
    const ents = await fsp.readdir(path.join(folder, dir), { withFileTypes: true }).catch(() => []);
    for (const e of ents) if (e.isFile() && /\.md$/i.test(e.name)) texts.push((await readRel(path.join(dir, e.name))) ?? '');
  }
  let n = Number(md.nextTaskId(texts).slice(1));
  return () => 't' + String(n++).padStart(4, '0');
}
// Задаче без ID он проставляется при первом изменении через борд
async function withId(t) { return t.id ? t : { ...t, id: (await idAllocator())() }; }

// ---------- регулярные задачи ----------
// Создаёт сегодняшние задачи по правилам и отмечает в правилах [создано по:: сегодня].
// Пропущенные дни (борд не открывали) не догоняются: только сегодняшний день.
async function generateRecurring(ws, now = md.today()) {
  const rulesText = await ws.get(RECUR_FILE);
  const rules = rc.parseRules(rulesText || '');
  const due = rc.dueToday(rules, now);
  if (!due.length) return [];
  const files = await listProjectFiles();
  const alloc = await idAllocator();
  const events = [];
  for (const r of due) {
    if (!files.includes(r.file)) continue;
    const text = await ws.get(r.file);
    const p = md.parseProject(text || '', r.file);
    // Задачу за сегодня уже создали (например, правило вернули отменой) — второй не нужно
    if (!p.tasks.some((t) => t.recur === r.id && t.due === now)) {
      const t = { bullet: '-', char: ' ', title: r.title, assignee: r.assignee, tag: r.tag, due: now, created: now, recur: r.id, extra: [], id: alloc() };
      ws.set(r.file, md.insertBlock(text || '', md.taskBlock(t)));
      events.push({ project: p.title, task: t.title, id: t.id, text: 'создана по регулярному правилу', kind: 'создание', what: 'регулярная' });
    }
    r.last = now;
  }
  ws.set(RECUR_FILE, rc.formatRules(rules, rulesText || ''));
  return events;
}
// Фоновая проверка: при открытии доски, раз в минуту и при смене дня. Не попадает в отмену.
async function recurTick() {
  if (!folder) return;
  if ((await readRel(RECUR_FILE)) === null) return;
  await syncExternal();
  const ws = workspace();
  const events = await generateRecurring(ws);
  const changes = await commit(ws.files());
  if (!changes.length) return;
  await logAfterWrite(events);
  await updateStatsFile();
  broadcast('change');
}
const recurSoon = () => serial(recurTick).catch((e) => console.error(e));

// 3.4: ряды точек на дорожке задаются порядком в файле. Один раз раскладываем точки по дате,
// как карта показывала их раньше, чтобы после обновления ничего не перепрыгнуло.
async function migrateRowOrder() {
  if (!folder || (await readBoardJson()).rmRows) return;
  await syncExternal();
  const files = {};
  for (const f of await listProjectFiles()) {
    const t = (await readRel(f)) ?? '';
    const n = rm.sortPointsByDate(t);
    if (n !== t) files[f] = n;
  }
  files[ORDER_FILE] = await boardJsonWith({ rmRows: 1 });
  await commit(files);
  snap = await takeSnapshot();
}
const migrateSoon = () => serial(migrateRowOrder).catch((e) => console.error(e));
setInterval(recurSoon, 60 * 1000).unref();

async function checkRule(r, prev) {
  const n = { ...(prev || {}) };
  n.title = md.fieldValue(checkName(r.title)).slice(0, 120);
  n.file = checkProjectFile(r.file);
  if (!(await listProjectFiles()).includes(n.file)) throw new HttpError(400, 'Выберите проект');
  n.assignee = String(r.assignee || '').trim();
  if (n.assignee && !(await readPeople()).includes(n.assignee)) throw new HttpError(400, `Исполнителя «${n.assignee}» нет в справочнике`);
  n.tag = String(r.tag || '').trim();
  if (n.tag && !(await readTags()).includes(n.tag)) throw new HttpError(400, `Тэга «${n.tag}» нет в справочнике`);
  n.kind = r.kind === 'month' ? 'month' : 'week';
  n.start = checkDate(r.start, 'дату начала') || md.today();
  if (n.kind === 'month') {
    const d = Number(r.day);
    if (!Number.isInteger(d) || d < 1 || d > 31) throw new HttpError(400, 'Число месяца — от 1 до 31');
    n.day = d; n.days = []; n.every = 1;
  } else {
    const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
    if (!days.length) throw new HttpError(400, 'Выберите хотя бы один день недели');
    const every = Number(r.every);
    if (!Number.isInteger(every) || every < 1 || every > 52) throw new HttpError(400, 'Повтор — раз в 1–52 недели');
    n.days = days; n.every = every; n.day = 1;
  }
  n.paused = !!r.paused;
  return n;
}
async function mustRule(id) {
  const text = (await readRel(RECUR_FILE)) || '';
  const rules = rc.parseRules(text);
  const r = rules.find((x) => x.id === id);
  if (!r) throw new HttpError(409, 'Правило изменилось в файле — список обновлён');
  return { text, rules, r };
}
// Операция над правилами: сразу создаёт сегодняшнюю задачу, если правило на неё выпадает. Отмена уберёт и то и другое.
async function rulesResult(rules, text, log) {
  const ws = workspace();
  ws.set(RECUR_FILE, rc.formatRules(rules, text));
  const created = await generateRecurring(ws);
  return { files: ws.files(), log: [...log, ...created] };
}

async function archiveTaskFile(file) {
  const rel = path.join(ARCHIVE_TASKS, file);
  let text = await readRel(rel);
  if (text === null) {
    const src = (await readRel(file)) ?? '';
    text = `# ${md.parseProject(src, file).title} — архив\n`;
  }
  return { rel, text };
}

// ---------- дорожная карта: помощники ----------
// Правки нескольких файлов в рамках одной операции: читаем один раз, пишем всё вместе
function workspace() {
  const cache = new Map();
  const dirty = new Set();
  return {
    async get(rel) { if (!cache.has(rel)) cache.set(rel, await readRel(rel)); return cache.get(rel); },
    set(rel, text) { cache.set(rel, text); dirty.add(rel); },
    files() { return Object.fromEntries([...dirty].map((r) => [r, cache.get(r)])); },
  };
}
async function findPoint(ws, id) {
  for (const file of await listProjectFiles()) {
    const p = rm.parseRoadmap((await ws.get(file)) || '').points.find((x) => x.id === id);
    if (p) return { file, p };
  }
  return null;
}
async function mustPoint(ws, file, id) {
  checkProjectFile(file);
  const text = await ws.get(file);
  if (text === null) throw new HttpError(409, 'Файл проекта не найден — карта обновлена');
  const p = rm.parseRoadmap(text).points.find((x) => x.id === id);
  if (!p) throw new HttpError(409, 'Контрольная точка изменилась в файле — карта обновлена');
  return p;
}
async function pointIdAllocator() {
  const texts = [];
  for (const dir of ['', ARCHIVE_TASKS, ARCHIVE_PROJECTS]) {
    const ents = await fsp.readdir(path.join(folder, dir), { withFileTypes: true }).catch(() => []);
    for (const e of ents) if (e.isFile() && /\.md$/i.test(e.name)) texts.push((await readRel(path.join(dir, e.name))) ?? '');
  }
  // Удалённые точки остаются в журнале: их ID не выдаём снова, чтобы история точки не смешивалась
  for (const n of await fsp.readdir(path.join(folder, log.LOG_DIR)).catch(() => [])) {
    if (!/\.md$/i.test(n)) continue;
    const t = (await readRel(path.join(log.LOG_DIR, n))) ?? '';
    texts.push([...t.matchAll(/\[id:: (m\d+)\]/g)].map((m) => ` ^${m[1]}`).join('\n'));
  }
  return rm.nextPointId(texts);
}
// Убирает связи на удалённые точки во всех проектах
async function dropLinksEverywhere(ws, ids) {
  if (!ids.length) return;
  for (const file of await listProjectFiles()) {
    const t = await ws.get(file);
    if (t === null) continue;
    const n = rm.dropLinks(t, ids);
    if (n !== t) ws.set(file, n);
  }
}
function checkDate(v, label, required = false) {
  const d = String(v || '').trim();
  if (!d) { if (required) throw new HttpError(400, `Укажите ${label}`); return ''; }
  if (!md.isValidDate(d)) throw new HttpError(400, `${label[0].toUpperCase() + label.slice(1)}: неверная дата`);
  return d;
}
async function checkOwner(name) {
  const n = String(name || '').trim();
  if (!n) throw new HttpError(400, 'У контрольной точки обязательно есть владелец');
  if (!(await readPeople()).includes(n)) throw new HttpError(400, `Владельца «${n}» нет в справочнике исполнителей`);
  return n;
}
async function checkPrefix(code) {
  const c = String(code || '').trim();
  if (!c) return '';
  const p = (await readPrefixes()).find((x) => x.code.toLowerCase() === c.toLowerCase());
  if (!p) throw new HttpError(400, `Префикса «${c}» нет в справочнике`);
  return p.code;
}

/**
 * Применяет правку к точке. Сдвиг — любое изменение реального срока: счётчик сдвигов растёт,
 * и для него обязательно новое здоровье. Индикативный срок сдвигов не копит; когда галочку снимают,
 * текущий срок становится первоначальным.
 */
function applyPointPatch(p, patch, now = md.today()) {
  const n = { ...p, after: [...p.after] };
  if ('title' in patch) { const t = String(patch.title || '').replace(/\s*\n\s*/g, ' ').trim(); if (t) n.title = t.slice(0, 120); }
  if ('pre' in patch) n.pre = patch.pre || '';
  if ('desc' in patch) n.desc = String(patch.desc || '');
  if ('owner' in patch && patch.owner) n.owner = patch.owner;
  if ('start' in patch) n.start = patch.start || '';
  if ('health' in patch && rm.HEALTH[patch.health]) n.health = patch.health;
  if ('ind' in patch) n.ind = !!patch.ind;
  if ('plan' in patch && patch.plan) n.plan = patch.plan;
  let shifted = false;
  if (p.ind && !n.ind) { n.orig = n.plan; n.shifts = 0; }
  else if (!p.ind && n.ind) { n.orig = ''; n.shifts = 0; }
  else if (!n.ind && n.plan !== p.plan) { n.shifts = (p.shifts || 0) + 1; if (!n.orig) n.orig = p.plan; shifted = true; }
  if (shifted && !rm.HEALTH[patch.health]) throw new HttpError(400, 'Срок сдвинут — выберите здоровье контрольной точки');
  if ('status' in patch) n.closed = patch.status === 'closed' ? (p.closed || patch.closed || now) : '';
  else if ('closed' in patch && n.closed && patch.closed) n.closed = patch.closed;
  return n;
}

// Точка, созданная из задачи, синхронизирована с ней: срок, название, владелец, закрытие
function syncTaskFromPoint(text, before, after) {
  if (!after.task) return text;
  const t = md.parseProject(text, '').tasks.find((x) => x.id === after.task);
  if (!t) return text;
  const patch = {};
  if (after.plan !== before.plan) patch.due = after.plan;
  if (after.title !== before.title) patch.title = after.title;
  if (after.owner !== before.owner) patch.assignee = after.owner;
  if (after.closed && !before.closed && t.status !== 'closed') patch.status = 'closed';
  if (!Object.keys(patch).length) return text;
  const n = md.applyPatch(t, patch);
  if (patch.status === 'closed') n.closed = after.closed;
  return md.replaceBlock(text, t, md.taskBlock(n));
}

const ops = {
  async create({ file, title, due }) {
    checkProjectFile(file);
    const text = await readRel(file);
    if (text === null) throw new HttpError(409, 'Файл проекта не найден');
    const t = { bullet: '-', char: ' ', title: checkName(title), due: checkDate(due, 'срок'), created: md.today(), extra: [], id: (await idAllocator())() };
    const out = md.insertBlock(text, md.taskBlock(t));
    return { files: { [file]: out }, task: { file, line: md.formatTaskLine(t) } };
  },

  async update({ file, ref, patch, health }) {
    const { text, t } = await mustTask(file, ref);
    if (patch && 'due' in patch) patch.due = checkDate(patch.due, 'срок');
    const n = md.applyPatch(await withId(t), patch || {});
    const block = md.taskBlock(n);
    const ws = workspace();
    let out = md.replaceBlock(text, t, block);
    // Связанная контрольная точка следует за задачей
    const pt = n.id && rm.parseRoadmap(out).points.find((x) => x.task === n.id);
    if (pt && !n.due && t.due && n.status !== 'cancelled') throw new HttpError(400, 'У задачи есть контрольная точка на RoadMap: срок обязателен');
    if (pt) {
      if (n.status === 'cancelled' && t.status !== 'cancelled') {
        out = rm.replacePoint(out, pt.id, null);
        ws.set(file, out);
        await dropLinksEverywhere(ws, [pt.id]);
        out = await ws.get(file);
      } else {
        const pp = {};
        if (n.title !== t.title) pp.title = n.title;
        if (n.assignee && n.assignee !== t.assignee) pp.owner = n.assignee;
        if (n.due && n.due !== t.due) pp.plan = n.due;
        if (n.status === 'closed' && t.status !== 'closed') { pp.status = 'closed'; pp.closed = n.closed; }
        if (t.status === 'closed' && n.status !== 'closed') pp.status = 'open';
        if (health) pp.health = health;
        if (Object.keys(pp).length) out = rm.replacePoint(out, pt.id, rm.pointBlock(applyPointPatch(pt, pp)));
      }
    }
    ws.set(file, out);
    const line = md.parseProject(out, file).tasks.find((x) => x.id === n.id)?.line || block[0];
    return { files: ws.files(), task: { file, line, lineNo: t.lineNo }, rejected: n.rejected || null };
  },

  async delete({ file, ref }) {
    const { text, t } = await mustTask(file, ref);
    let { text: out } = md.removeBlock(text, t);
    const arch = await archiveTaskFile(file);
    const tid = await withId(t);
    const block = md.taskBlock({ ...tid, deleted: md.today() });
    // Контрольная точка задачи удаляется вместе с ней, связи с точкой тоже
    const ws = workspace();
    const pt = t.id && rm.parseRoadmap(out).points.find((x) => x.task === t.id);
    if (pt) { ws.set(file, rm.replacePoint(out, pt.id, null)); await dropLinksEverywhere(ws, [pt.id]); out = await ws.get(file); }
    return { files: { [file]: out, [arch.rel]: md.appendBlock(arch.text, block) }, log: [{ project: projTitle(file, text), task: t.title, id: tid.id, text: 'удалена (перенесена в архив)', kind: 'удаление' }] };
  },

  async move({ file, ref, toFile, beforeRef }) {
    const { text, t } = await mustTask(file, ref);
    checkProjectFile(toFile);
    const block = md.taskBlock(await withId(t));
    if (toFile === file) {
      if (beforeRef && beforeRef.line === t.line && beforeRef.lineNo === t.lineNo) return { files: {} };
      const { text: removed } = md.removeBlock(text, t);
      const before = beforeRef ? md.findTask(removed, { ...beforeRef, lineNo: beforeRef.lineNo > t.lineNo ? beforeRef.lineNo - (t.endNo - t.lineNo) : beforeRef.lineNo }) : null;
      if (beforeRef && !before) throw new HttpError(409, 'Задача изменилась в файле — доска обновлена');
      return { files: { [file]: md.insertBlock(removed, block, before) }, task: { file, line: block[0] } };
    }
    const target = await readRel(toFile);
    if (target === null) throw new HttpError(409, 'Файл проекта не найден');
    const before = beforeRef ? md.findTask(target, beforeRef) : null;
    let { text: removed } = md.removeBlock(text, t);
    let into = md.insertBlock(target, block, before);
    // Контрольная точка задачи переезжает в новый проект вместе с задачей
    const pt = t.id && rm.parseRoadmap(removed).points.find((x) => x.task === t.id);
    if (pt) { removed = rm.replacePoint(removed, pt.id, null); into = rm.addPoint(into, rm.pointBlock(pt), rm.placeByDate(into, pt)); }
    return { files: { [file]: removed, [toFile]: into }, task: { file: toFile, line: block[0] } };
  },

  async archiveClosed({ file }) {
    checkProjectFile(file);
    let text = await readRel(file);
    if (text === null) throw new HttpError(409, 'Файл проекта не найден');
    const closed = md.parseProject(text, file).tasks.filter((t) => md.isDone(t));
    if (!closed.length) return { files: {} };
    let { rel, text: arch } = await archiveTaskFile(file);
    const alloc = await idAllocator();
    for (const t of closed) if (!t.id) t.id = alloc();
    for (const t of closed.reverse()) text = md.removeBlock(text, t).text;
    for (const t of closed.reverse()) arch = md.appendBlock(arch, md.taskBlock(t));
    const project = projTitle(file, text);
    return { files: { [file]: text, [rel]: arch }, log: closed.map((t) => ({ project, task: t.title, id: t.id, text: 'закрытая задача перенесена в архив', kind: 'архив' })) };
  },

  async createProject({ name }) {
    const n = checkProjectName(name);
    const file = `${n}.md`;
    if ((await readRel(file)) !== null) throw new HttpError(409, 'Проект с таким названием уже есть');
    const order = await readOrder();
    const files = { [file]: `# ${n}\n\n` };
    if (order.length) files[ORDER_FILE] = await boardJsonWith({ order: [...order, file] });
    return { files, log: [{ project: n, text: 'проект создан', kind: 'создание проекта' }] };
  },

  async renameProject({ file, name }) {
    checkProjectFile(file);
    const n = checkProjectName(name);
    const text = await readRel(file);
    if (text === null) throw new HttpError(409, 'Файл проекта не найден');
    const newFile = `${n}.md`;
    const files = {};
    if (newFile !== file) {
      if ((await readRel(newFile)) !== null) throw new HttpError(409, 'Проект с таким названием уже есть');
      files[file] = null;
      const order = await readOrder();
      if (order.includes(file)) files[ORDER_FILE] = await boardJsonWith({ order: order.map((f) => (f === file ? newFile : f)) });
    }
    files[newFile] = md.renameH1(text, n);
    const rt = await readRel(RECUR_FILE);
    const rules = rc.parseRules(rt || '');
    if (newFile !== file && rules.some((r) => r.file === file)) files[RECUR_FILE] = rc.formatRules(rules.map((r) => (r.file === file ? { ...r, file: newFile } : r)), rt);
    return { files, log: [{ project: n, text: `проект переименован: «${projTitle(file, text)}» → «${n}»`, kind: 'переименование проекта', from: projTitle(file, text), to: n }] };
  },

  async archiveProject({ file }) {
    checkProjectFile(file);
    const text = await readRel(file);
    if (text === null) throw new HttpError(409, 'Файл проекта не найден');
    const rel = await uniqueRel(ARCHIVE_PROJECTS, file);
    return { files: { [file]: null, [rel]: text }, log: [{ project: projTitle(file, text), text: 'проект перенесён в архив', kind: 'архив проекта' }] };
  },

  async reorderProjects({ order }) {
    if (!Array.isArray(order)) throw new HttpError(400, 'Неверный порядок');
    order.forEach(checkProjectFile);
    return { files: { [ORDER_FILE]: await boardJsonWith({ order }) }, log: [] };
  },

  async setSettings({ overdueDays }) {
    const d = Number(overdueDays);
    if (!Number.isInteger(d) || d < 1 || d > 365) throw new HttpError(400, 'Количество дней — целое число от 1 до 365');
    const cur = await readSettings();
    const settings = { ...((await readBoardJson()).settings || {}), overdueDays: d };
    return { files: { [ORDER_FILE]: await boardJsonWith({ settings }) }, log: cur.overdueDays === d ? [] : [{ project: 'Настройки', text: `дней ожидания до напоминания: ${cur.overdueDays} → ${d}`, kind: 'настройки', from: String(cur.overdueDays), to: String(d) }] };
  },

  async personAdd({ name, group }) {
    const n = checkName(name, 'Имя');
    const g = checkGroup(group);
    const text = (await readRel(PEOPLE_FILE)) || '';
    const people = md.parsePeopleGroups(text);
    if (people.some((p) => p.name === n)) throw new HttpError(409, 'Такой исполнитель уже есть');
    return { files: { [PEOPLE_FILE]: md.formatPeopleGroups([...people, { name: n, group: g }], text) }, log: [{ project: 'Исполнители', text: `добавлен: ${n}${g ? ` (${g})` : ''}`, kind: 'исполнители', to: n }] };
  },

  async personRename({ from, to }) {
    const n = checkName(to, 'Имя');
    const text = (await readRel(PEOPLE_FILE)) || '';
    const people = md.parsePeopleGroups(text);
    if (!people.some((p) => p.name === from)) throw new HttpError(409, 'Исполнитель не найден');
    if (n !== from && people.some((p) => p.name === n)) throw new HttpError(409, 'Такой исполнитель уже есть');
    const files = { [PEOPLE_FILE]: md.formatPeopleGroups(people.map((p) => (p.name === from ? { ...p, name: n } : p)), text) };
    for (const file of await listProjectFiles()) {
      let t = await readRel(file);
      const tasks = md.parseProject(t, file).tasks.filter((x) => x.assignee === from);
      if (!tasks.length) continue;
      for (const x of tasks.reverse()) t = md.replaceBlock(t, { ...x, endNo: x.lineNo + 1 }, [md.formatTaskLine({ ...x, assignee: n })]);
      files[file] = t;
    }
    for (const file of await listProjectFiles()) {
      let t = files[file] ?? (await readRel(file));
      const pts = rm.parseRoadmap(t).points.filter((x) => x.owner === from);
      if (!pts.length) continue;
      for (const x of pts) t = rm.replacePoint(t, x.id, rm.pointBlock({ ...x, owner: n }));
      files[file] = t;
    }
    return { files, log: [{ project: 'Исполнители', text: `переименован: ${from} → ${n} (во всех задачах)`, kind: 'исполнители', from, to: n }] };
  },

  // Переносит исполнителя в группу; новая группа появляется сама, пустая исчезает
  async personGroup({ name, group }) {
    const g = checkGroup(group);
    const text = (await readRel(PEOPLE_FILE)) || '';
    const people = md.parsePeopleGroups(text);
    const p = people.find((x) => x.name === name);
    if (!p) throw new HttpError(409, 'Исполнитель не найден');
    if (p.group === g) return { files: {} };
    const from = p.group;
    const rest = people.filter((x) => x.name !== name);
    // В конец своей новой группы, чтобы порядок внутри групп не прыгал
    const lastIdx = rest.map((x) => x.group).lastIndexOf(g);
    rest.splice(lastIdx < 0 ? rest.length : lastIdx + 1, 0, { name, group: g });
    return { files: { [PEOPLE_FILE]: md.formatPeopleGroups(rest, text) }, log: [{ project: 'Исполнители', text: `${name}: группа ${from || '—'} → ${g || '—'}`, kind: 'группа исполнителя', from: from || '', to: g || '' }] };
  },

  async groupRename({ from, to }) {
    const g = checkGroup(to);
    if (!g) throw new HttpError(400, 'Название группы не может быть пустым');
    const text = (await readRel(PEOPLE_FILE)) || '';
    const people = md.parsePeopleGroups(text);
    if (!people.some((p) => p.group === from)) throw new HttpError(409, 'Группа не найдена');
    if (g !== from && people.some((p) => p.group === g)) throw new HttpError(409, 'Такая группа уже есть');
    // Заголовок меняем и в исходном тексте, чтобы группа осталась на своём месте
    const renamed = text.split(/\r?\n/).map((l) => (/^##\s+(.+?)\s*$/.exec(l)?.[1] === from ? `## ${g}` : l)).join('\n');
    return { files: { [PEOPLE_FILE]: md.formatPeopleGroups(people.map((p) => (p.group === from ? { ...p, group: g } : p)), renamed) }, log: [{ project: 'Исполнители', text: `группа переименована: ${from} → ${g}`, kind: 'группа исполнителя', from, to: g }] };
  },

  async personDelete({ name }) {
    const text = (await readRel(PEOPLE_FILE)) || '';
    const people = md.parsePeopleGroups(text);
    const places = [];
    for (const file of await listProjectFiles()) {
      const p = md.parseProject((await readRel(file)) || '', file);
      for (const t of p.tasks) if (t.assignee === name) places.push(`${p.title}: ${t.title}`);
      for (const x of rm.parseRoadmap((await readRel(file)) || '').points) if (x.owner === name) places.push(`${p.title}, RoadMap: ${x.title}`);
    }
    if (places.length) throw new HttpError(409, `Нельзя удалить: ${name} назначен(а) на задачи или владеет точками`, { places });
    return { files: { [PEOPLE_FILE]: md.formatPeopleGroups(people.filter((p) => p.name !== name), text) }, log: [{ project: 'Исполнители', text: `удалён: ${name}`, kind: 'исполнители', from: name }] };
  },

  async tagAdd({ name, color }) {
    const n = md.fieldValue(checkName(name, 'Тэг')).slice(0, 40);
    const text = (await readRel(TAGS_FILE)) || '';
    const tags = md.parseTags(text);
    if (tags.some((t) => t.name === n)) throw new HttpError(409, 'Такой тэг уже есть');
    const c = md.TAG_COLOR_NAMES.includes(color) ? color : '';
    return { files: { [TAGS_FILE]: md.formatTags([...tags, { name: n, color: c }], text) }, log: [{ project: 'Тэги', text: `добавлен: ${n}${c ? ` (${c})` : ''}`, kind: 'тэги', to: n }] };
  },

  async tagColor({ name, color }) {
    if (!md.TAG_COLOR_NAMES.includes(color)) throw new HttpError(400, 'Неизвестный цвет');
    const text = (await readRel(TAGS_FILE)) || '';
    const tags = md.parseTags(text);
    const t = tags.find((x) => x.name === name);
    if (!t) throw new HttpError(409, 'Тэг не найден');
    const from = t.color;
    t.color = color;
    return { files: { [TAGS_FILE]: md.formatTags(tags, text) }, log: [{ project: 'Тэги', text: `цвет «${name}»: ${from || 'авто'} → ${color}`, kind: 'тэги', from, to: color }] };
  },

  async tagRename({ from, to }) {
    const n = md.fieldValue(checkName(to, 'Тэг')).slice(0, 40);
    const text = (await readRel(TAGS_FILE)) || '';
    const tags = md.parseTags(text);
    if (!tags.some((t) => t.name === from)) throw new HttpError(409, 'Тэг не найден');
    if (n !== from && tags.some((t) => t.name === n)) throw new HttpError(409, 'Такой тэг уже есть');
    const files = { [TAGS_FILE]: md.formatTags(tags.map((t) => (t.name === from ? { ...t, name: n } : t)), text) };
    for (const file of await listProjectFiles()) {
      let t = await readRel(file);
      const tasks = md.parseProject(t, file).tasks.filter((x) => x.tag === from);
      if (!tasks.length) continue;
      for (const x of tasks.reverse()) t = md.replaceBlock(t, { ...x, endNo: x.lineNo + 1 }, [md.formatTaskLine({ ...x, tag: n })]);
      files[file] = t;
    }
    return { files, log: [{ project: 'Тэги', text: `переименован: ${from} → ${n} (во всех задачах)`, kind: 'тэги', from, to: n }] };
  },

  async tagDelete({ name }) {
    const text = (await readRel(TAGS_FILE)) || '';
    const tags = md.parseTags(text);
    const places = [];
    for (const file of await listProjectFiles()) {
      const p = md.parseProject((await readRel(file)) || '', file);
      for (const t of p.tasks) if (t.tag === name) places.push(`${p.title}: ${t.title}`);
    }
    if (places.length) throw new HttpError(409, `Нельзя удалить: тэг «${name}» стоит у задач`, { places });
    return { files: { [TAGS_FILE]: md.formatTags(tags.filter((t) => t.name !== name), text) }, log: [{ project: 'Тэги', text: `удалён: ${name}`, kind: 'тэги', from: name }] };
  },

  // ---------- дорожная карта ----------
  async pointCreate({ file, pre, title, desc, owner, start, plan, ind }) {
    checkProjectFile(file);
    const text = await readRel(file);
    if (text === null) throw new HttpError(409, 'Файл проекта не найден');
    const p = {
      bullet: '-', id: await pointIdAllocator(), title: checkName(title).slice(0, 120), pre: await checkPrefix(pre), desc: String(desc || '').trim(),
      owner: await checkOwner(owner), start: checkDate(start, 'старт работ'), plan: checkDate(plan, 'срок', true), ind: !!ind,
      health: 'g', shifts: 0, closed: '', task: '', after: [], extra: [],
    };
    if (!p.ind) p.orig = p.plan;
    return { files: { [file]: rm.addPoint(text, rm.pointBlock(p), rm.placeByDate(text, p)) }, point: { file, id: p.id } };
  },

  // Точка из задачи: только при сроке и исполнителе; дальше они синхронизированы
  async pointFromTask({ file, ref }) {
    const { text, t } = await mustTask(file, ref);
    if (!md.isValidDate(t.due)) throw new HttpError(400, 'Сначала поставьте задаче срок');
    if (!t.assignee) throw new HttpError(400, 'Сначала выберите исполнителя задачи');
    await checkOwner(t.assignee);
    const tid = await withId(t);
    if (rm.parseRoadmap(text).points.some((x) => x.task === tid.id)) throw new HttpError(409, 'У задачи уже есть контрольная точка');
    let out = md.replaceBlock(text, t, md.taskBlock(tid));
    const p = {
      bullet: '-', id: await pointIdAllocator(), title: t.title, pre: '', desc: '', owner: t.assignee, start: '', plan: t.due, orig: t.due, ind: false,
      health: 'g', shifts: 0, closed: t.status === 'closed' ? (t.closed || md.today()) : '', task: tid.id, after: [], extra: [],
    };
    out = rm.addPoint(out, rm.pointBlock(p), rm.placeByDate(out, p));
    return { files: { [file]: out }, point: { file, id: p.id } };
  },

  async pointUpdate({ file, id, patch }) {
    const ws = workspace();
    const p = await mustPoint(ws, file, id);
    const pp = { ...(patch || {}) };
    if ('pre' in pp) pp.pre = await checkPrefix(pp.pre);
    if ('owner' in pp) pp.owner = await checkOwner(pp.owner);
    if ('plan' in pp) pp.plan = checkDate(pp.plan, 'срок', true);
    if ('start' in pp) pp.start = checkDate(pp.start, 'старт работ');
    if ('closed' in pp) pp.closed = checkDate(pp.closed, 'дату закрытия');
    if ('title' in pp && !String(pp.title || '').trim()) throw new HttpError(400, 'Название не может быть пустым');
    const n = applyPointPatch(p, pp);
    let text = rm.replacePoint(await ws.get(file), id, rm.pointBlock(n));
    text = syncTaskFromPoint(text, p, n);
    ws.set(file, text);
    return { files: ws.files(), point: { file, id } };
  },

  // Ряд точки на дорожке = её место в разделе RoadMap: ставим перед beforeId ('' — в самый низ)
  async pointOrder({ file, id, beforeId }) {
    const ws = workspace();
    const p = await mustPoint(ws, file, id);
    const text = await ws.get(file);
    const pts = rm.parseRoadmap(text).points;
    if (beforeId && !pts.some((x) => x.id === beforeId)) throw new HttpError(409, 'Контрольная точка изменилась в файле — карта обновлена');
    const out = rm.movePoint(text, id, beforeId || '');
    const from = pts.findIndex((x) => x.id === id), to = rm.parseRoadmap(out).points.findIndex((x) => x.id === id);
    if (out === text || from === to) return { files: {} };
    return { files: { [file]: out }, point: { file, id }, log: [{ project: projTitle(file, text), task: log.pointName(p), id, section: 'roadmap', text: `ряд на дорожке: ${from + 1} → ${to + 1}`, kind: 'порядок точки', from: String(from + 1), to: String(to + 1) }] };
  },

  async pointDelete({ file, id }) {
    const ws = workspace();
    await mustPoint(ws, file, id);
    ws.set(file, rm.replacePoint(await ws.get(file), id, null));
    await dropLinksEverywhere(ws, [id]);
    return { files: ws.files() };
  },

  // Связь «to после from»: хранится у точки to как [после:: from]
  async linkAdd({ from, to }) {
    if (from === to) throw new HttpError(400, 'Нельзя связать точку саму с собой');
    const ws = workspace();
    const a = await findPoint(ws, from), b = await findPoint(ws, to);
    if (!a || !b) throw new HttpError(409, 'Точка не найдена — карта обновлена');
    if (b.p.after.includes(from) || a.p.after.includes(to)) return { files: {} };
    ws.set(b.file, rm.replacePoint(await ws.get(b.file), to, rm.pointBlock({ ...b.p, after: [...b.p.after, from] })));
    return { files: ws.files() };
  },

  async linkDelete({ from, to }) {
    const ws = workspace();
    const b = await findPoint(ws, to);
    if (!b || !b.p.after.includes(from)) return { files: {} };
    ws.set(b.file, rm.replacePoint(await ws.get(b.file), to, rm.pointBlock({ ...b.p, after: b.p.after.filter((x) => x !== from) })));
    return { files: ws.files() };
  },

  // Дорожка проекта на карте — это раздел «## RoadMap» в его файле
  async laneAdd({ file }) {
    checkProjectFile(file);
    const text = await readRel(file);
    if (text === null) throw new HttpError(409, 'Файл проекта не найден');
    return { files: { [file]: rm.ensureSection(text) }, log: [{ project: projTitle(file, text), section: 'roadmap', text: 'проект добавлен на дорожную карту', kind: 'дорожка' }] };
  },

  // Убрать дорожку можно, только когда все её точки закрыты; закрытые точки уходят в архив проекта
  async laneRemove({ file }) {
    checkProjectFile(file);
    const text = await readRel(file);
    if (text === null) throw new HttpError(409, 'Файл проекта не найден');
    const { text: out, points } = rm.removeSection(text);
    if (points.some((x) => !x.closed)) throw new HttpError(409, 'Убрать дорожку можно, когда все её точки закрыты');
    const ws = workspace();
    ws.set(file, out);
    if (points.length) {
      const arch = await archiveTaskFile(file);
      let a = arch.text;
      for (const x of points) a = rm.addPoint(a, rm.pointBlock(x));
      ws.set(arch.rel, a);
      await dropLinksEverywhere(ws, points.map((x) => x.id));
    }
    const title = projTitle(file, text);
    return { files: ws.files(), log: [{ project: title, section: 'roadmap', text: `проект убран с дорожной карты${points.length ? `, закрытые точки (${points.length}) перенесены в архив` : ''}`, kind: 'дорожка', archivedPoints: points.map((x) => x.id) }] };
  },

  async recurAdd({ rule }) {
    const text = await readRel(RECUR_FILE);
    const texts = [text || ''];
    for (const f of await listProjectFiles()) texts.push((await readRel(f)) || '');
    const r = { ...(await checkRule(rule || {})), id: rc.nextRuleId(texts), last: '' };
    const rules = [...rc.parseRules(text || ''), r];
    return rulesResult(rules, text || '', [{ project: 'Регулярные задачи', task: r.title, id: r.id, text: `правило добавлено: ${rc.describe(r)}`, kind: 'регулярные' }]);
  },

  async recurUpdate({ id, rule }) {
    const { text, rules, r } = await mustRule(id);
    const n = await checkRule(rule || {}, r);
    // [создано по::] сохраняется: если задачу за сегодня уже создали, вторую правка не создаст
    const what = n.paused !== r.paused ? (n.paused ? 'правило на паузе' : 'правило снова действует') : `правило изменено: ${rc.describe(n)}`;
    return rulesResult(rules.map((x) => (x.id === id ? n : x)), text, [{ project: 'Регулярные задачи', task: n.title, id, text: what, kind: 'регулярные' }]);
  },

  async recurDelete({ id }) {
    const { text, rules, r } = await mustRule(id);
    return { files: { [RECUR_FILE]: rc.formatRules(rules.filter((x) => x.id !== id), text) }, log: [{ project: 'Регулярные задачи', task: r.title, id, text: 'правило удалено, созданные задачи остались', kind: 'регулярные' }] };
  },

  async releaseSet({ date, name }) {
    const d = checkDate(date, 'дату релиза', true);
    const n = md.fieldValue(String(name || '')).slice(0, 30);
    const text = (await readRel(RELEASES_FILE)) || '';
    const list = rm.parseReleases(text);
    const cur = list.find((r) => r.date === d);
    const next = list.filter((r) => r.date !== d);
    if (n) next.push({ date: d, name: n });
    const label = d.split('-').reverse().join('.');
    const ev = n ? (cur ? `релиз ${label}: ${cur.name} → ${n}` : `плановый релиз ${n}: ${label}`) : `плановый релиз ${cur?.name || ''} снят: ${label}`;
    return { files: { [RELEASES_FILE]: rm.formatReleases(next, text) }, log: [{ project: 'Релизы', section: 'roadmap', text: ev, kind: 'релиз', from: cur?.name || '', to: n }] };
  },

  async prefixAdd({ code, name, color }) {
    const c = String(code || '').trim().replace(/[\[\]\s]/g, '').toUpperCase().slice(0, 12);
    if (!c) throw new HttpError(400, 'Код префикса не может быть пустым');
    const text = await readRel(PREFIXES_FILE);
    const list = await readPrefixes();
    if (list.some((p) => p.code.toLowerCase() === c.toLowerCase())) throw new HttpError(409, 'Такой префикс уже есть');
    const col = md.TAG_COLOR_NAMES.includes(color) ? color : '';
    const n = md.fieldValue(String(name || '')).slice(0, 60);
    return { files: { [PREFIXES_FILE]: rm.formatPrefixes([...list, { code: c, name: n, color: col }], text || '') }, log: [{ project: 'Префиксы', section: 'roadmap', text: `добавлен: ${c}${n ? ` (${n})` : ''}`, kind: 'префиксы', to: c }] };
  },

  async prefixUpdate({ code, name, color }) {
    const text = await readRel(PREFIXES_FILE);
    const list = await readPrefixes();
    const p = list.find((x) => x.code === code);
    if (!p) throw new HttpError(409, 'Префикс не найден');
    const before = { ...p };
    if (name !== undefined) p.name = md.fieldValue(String(name || '')).slice(0, 60);
    if (color !== undefined && md.TAG_COLOR_NAMES.includes(color)) p.color = color;
    const what = before.name !== p.name ? `расшифровка ${code}: ${before.name || 'нет'} → ${p.name || 'нет'}` : `цвет ${code}: ${before.color || 'авто'} → ${p.color}`;
    return { files: { [PREFIXES_FILE]: rm.formatPrefixes(list, text || '') }, log: [{ project: 'Префиксы', section: 'roadmap', text: what, kind: 'префиксы' }] };
  },

  async prefixDelete({ code }) {
    const places = [];
    for (const file of await listProjectFiles()) {
      const text = (await readRel(file)) || '';
      for (const x of rm.parseRoadmap(text).points) if (x.pre === code) places.push(`${projTitle(file, text)}: ${x.title}`);
    }
    if (places.length) throw new HttpError(409, `Нельзя удалить: префикс ${code} стоит у точек`, { places });
    const text = await readRel(PREFIXES_FILE);
    const list = (await readPrefixes()).filter((p) => p.code !== code);
    return { files: { [PREFIXES_FILE]: rm.formatPrefixes(list, text || '') }, log: [{ project: 'Префиксы', section: 'roadmap', text: `удалён: ${code}`, kind: 'префиксы', from: code }] };
  },
};

// История контрольной точки из журнала: все строки с её ID, новые сверху
async function pointHistory(id) {
  if (!/^m\d+$/.test(id)) return [];
  const dir = path.join(folder, log.LOG_DIR);
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort();
  const items = [];
  for (const n of names) {
    const text = (await readRel(path.join(log.LOG_DIR, n))) || '';
    for (const l of text.split(/\r?\n/)) {
      if (!l.includes(`[id:: ${id}]`)) continue;
      const parts = l.replace(/^[-*+]\s+/, '').replace(/\s*\[[^\[\]:]+::[^\]]*\]/g, '').split(' · ');
      const titleAt = parts.findIndex((x) => /^«.*»$/.test(x));
      items.push({ date: n.slice(0, 10), time: parts[0], text: parts.slice(titleAt >= 0 ? titleAt + 1 : 2).join(' · ') });
    }
  }
  return items.reverse().slice(0, 100);
}

const projTitle = (file, text) => md.parseProject(text || '', file).title;

async function takeSnapshot() {
  const files = {};
  for (const f of await listProjectFiles()) {
    const text = (await readRel(f)) ?? '';
    const p = md.parseProject(text, f);
    files[f] = { title: p.title, tasks: p.tasks, points: rm.parseRoadmap(text).points };
  }
  return { files, people: await readPeople(), tags: await readTags() };
}

// Правки, сделанные вне борда (Obsidian и т.п.): сравниваем с последним снимком и пишем в журнал.
async function syncExternal() {
  if (!folder) return;
  const cur = await takeSnapshot();
  const events = [...log.diffSnapshots(snap.files, cur.files, ' (вне борда)', true), ...log.diffPoints(snap.files, cur.files, ' (вне борда)', true), ...log.diffPeople(snap.people, cur.people, ' (вне борда)', true), ...log.diffPeople(snap.tags || [], cur.tags, ' (вне борда)', true, 'Тэги')];
  snap = cur;
  await log.appendLog(folder, events);
  if (events.length) await updateStatsFile();
}

async function logAfterWrite(explicit, withPoints = true) {
  const cur = await takeSnapshot();
  // Точки, ушедшие в архив вместе с дорожкой, не «удалены»: это уже сказано в событии дорожки
  const archived = new Set((explicit || []).flatMap((e) => e.archivedPoints || []));
  const points = !withPoints ? [] : log.diffPoints(snap.files, cur.files).filter((e) => !(e.kind === 'удаление точки' && archived.has(e.id)));
  const events = explicit ? [...explicit, ...points] : [...log.diffSnapshots(snap.files, cur.files), ...points, ...log.diffPeople(snap.people, cur.people), ...log.diffPeople(snap.tags || [], cur.tags, '', false, 'Тэги')];
  snap = cur;
  await log.appendLog(folder, events);
  return events;
}

async function commit(files) {
  const changes = [];
  for (const [rel, after] of Object.entries(files)) {
    const before = await readRel(rel);
    if (before === after) continue;
    changes.push({ path: rel, before, after });
  }
  // Сначала файлы, куда задача добавляется, потом откуда убирается, удаления последними: сбой даст дубль, а не потерю
  for (const c of md.writeOrder(changes, 'after', 'before')) await writeRel(c.path, c.after);
  return changes;
}

// Отмена/повтор: восстанавливаем содержимое, только если файлы не менялись с тех пор.
async function restore(changes, dir) {
  const from = dir === 'undo' ? 'after' : 'before';
  const to = dir === 'undo' ? 'before' : 'after';
  for (const c of changes) {
    resolveRel(c.path);
    if ((await readRel(c.path)) !== c[from]) throw new HttpError(409, 'Файл изменился после этого действия — отменить нельзя');
  }
  for (const c of md.writeOrder(changes, to, from)) await writeRel(c.path, c[to]);
}

async function restoreAndLog(changes, dir, events, label) {
  await syncExternal();
  await restore(changes, dir);
  const word = dir === 'undo' ? 'отменено' : 'возвращено';
  const list = Array.isArray(events) && events.length ? events : [{ text: String(label || 'действие') }];
  const kind = dir === 'undo' ? 'отмена' : 'возврат';
  await logAfterWrite(list.slice(0, 200).map((e) => ({ project: String(e.project || ''), task: String(e.task || ''), id: String(e.id || ''), section: String(e.section || ''), text: `${word}: ${String(e.text || '')}`, kind, what: String(e.kind || '') })), false);
  await updateStatsFile();
}

let queue = Promise.resolve();
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  if (!/^application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Нужен JSON');
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 5e6) throw new HttpError(413, 'Слишком большой запрос'); }
  try { return JSON.parse(data || '{}'); } catch { throw new HttpError(400, 'Неверный JSON'); }
}
function needFolder() { if (!folder) throw new HttpError(409, 'Папка не выбрана'); }

async function listDirs(p) {
  const abs = path.resolve(p ? p.replace(/^~(?=$|\/)/, os.homedir()) : os.homedir());
  const ents = await fsp.readdir(abs, { withFileTypes: true }).catch(() => { throw new HttpError(400, 'Не удалось открыть папку'); });
  const dirs = ents.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b, 'ru'));
  const mdCount = ents.filter((e) => e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith('_')).length;
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, dirs, mdCount, home: os.homedir() };
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/ping': return send(res, 200, { app: 'taskboard', version: VERSION });
    case 'POST /api/shutdown': {
      // Новая версия борда просит старую уступить порт
      await readBody(req);
      send(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    case 'GET /api/state': return send(res, 200, { folder, recent: config.recent, version: VERSION });
    case 'GET /api/fs': return send(res, 200, await listDirs(url.searchParams.get('path')));
    case 'POST /api/open': { const b = await readBody(req); await openFolder(String(b.path || '')); return send(res, 200, { folder }); }
    case 'POST /api/forget': { const b = await readBody(req); config.recent = config.recent.filter((r) => r !== b.path); await saveConfig(); return send(res, 200, { recent: config.recent }); }
    case 'GET /api/board': needFolder(); await recurSoon(); return send(res, 200, await getBoard());
    case 'GET /api/history': needFolder(); return send(res, 200, { items: await pointHistory(String(url.searchParams.get('id') || '')) });
    case 'POST /api/op': {
      needFolder();
      const b = await readBody(req);
      const op = ops[b.type];
      if (!op) throw new HttpError(400, 'Неизвестная операция');
      const result = await serial(async () => {
        await syncExternal();
        const r = await op(b);
        const changes = await commit(r.files);
        const events = changes.length ? await logAfterWrite(r.log) : [];
        if (changes.length) await updateStatsFile();
        return { ...r, changes, events };
      });
      return send(res, 200, { changes: result.changes, task: result.task || null, point: result.point || null, events: result.events, rejected: result.rejected || null });
    }
    case 'POST /api/restore': {
      needFolder();
      const b = await readBody(req);
      await serial(() => restoreAndLog(b.changes || [], b.dir, b.events, b.label));
      return send(res, 200, { ok: true });
    }
    case 'GET /api/events': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
  }
  throw new HttpError(404, 'Не найдено');
}

async function handleStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const abs = path.join(PUBLIC_DIR, path.normalize(p));
  if (!abs.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Не найдено');
  const data = await fsp.readFile(abs).catch(() => { throw new HttpError(404, 'Не найдено'); });
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    // Защита от DNS-rebinding: принимаем только локальные адреса
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new HttpError(403, 'Доступ только локально');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await handleStatic(req, res, url);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e instanceof HttpError ? e.message : 'Внутренняя ошибка: ' + e.message, ...(e.extra || {}) });
  }
});

function openBrowser(u) {
  if (NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? ['open', [u]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : ['xdg-open', [u]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch {}
}

// Возвращает версию борда на порту ('' — версия до 1.7.2) или null, если там не борд.
async function runningBoard(p) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(800) });
    const d = await r.json();
    return d.app === 'taskboard' ? d.version || '' : null;
  } catch { return null; }
}

const portFree = (p) => new Promise((ok) => {
  const t = http.createServer().once('error', () => ok(false)).listen(p, '127.0.0.1', () => t.close(() => ok(true)));
});

// Останавливает запущенный борд другой версии, чтобы не открылась старая
async function stopOldBoard(p) {
  try {
    await fetch(`http://127.0.0.1:${p}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(800) });
  } catch {}
  for (let i = 0; i < 10; i++) { if (await portFree(p)) return true; await new Promise((r) => setTimeout(r, 200)); }
  // Старые версии не умеют останавливаться по запросу — завершаем процесс, который слушает порт
  try {
    const pids = execFileSync('lsof', ['-nP', '-t', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number);
    for (const pid of pids) if (pid !== process.pid) process.kill(pid, 'SIGTERM');
  } catch {}
  for (let i = 0; i < 15; i++) { if (await portFree(p)) return true; await new Promise((r) => setTimeout(r, 200)); }
  return false;
}

function listen() {
  server.once('error', async (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    const running = await runningBoard(port);
    if (running === VERSION) {
      console.log(`Борд уже запущен: http://127.0.0.1:${port}`);
      openBrowser(`http://127.0.0.1:${port}`);
      process.exit(0);
    }
    if (running !== null) {
      console.log(`Уже запущена другая версия борда (${running || 'старая'}) — останавливаю её…`);
      if (await stopOldBoard(port)) { console.log('Прежняя версия остановлена.'); return listen(); }
      console.error(`Не удалось остановить старую версию. Закройте её окно Терминала и запустите борд снова.`);
      process.exit(1);
    }
    if (++port > BASE_PORT + 20) { console.error('Нет свободного порта'); process.exit(1); }
    listen();
  });
  server.listen(port, '127.0.0.1');
}
// Один обработчик на все попытки listen, иначе после повтора браузер открылся бы дважды
server.once('listening', () => {
  server.removeAllListeners('error');
  const u = `http://127.0.0.1:${port}`;
  console.log(`Task Board ${VERSION} работает: ${u}\nЗакройте это окно, чтобы остановить борд.`);
  openBrowser(u);
});

await loadConfig();
const argFolder = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (argFolder) await openFolder(argFolder).catch(() => console.error('Папка не найдена:', argFolder));
else if (config.last && fs.existsSync(config.last)) { folder = config.last; snap = await takeSnapshot(); startWatcher(); migrateSoon(); statsSoon(); recurSoon(); }
listen();
