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
  statsSoon();
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
async function readTags() { return md.parsePeople((await readRel(TAGS_FILE)) || ''); }

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
  const tags = await readTags();
  const settings = await readSettings();
  const now = md.today();
  const projects = [];
  for (const file of files) {
    const text = (await readRel(file)) ?? '';
    const p = md.parseProject(text, file);
    projects.push({
      file, title: p.title,
      tasks: p.tasks.map((t) => ({
        line: t.line, lineNo: t.lineNo, title: t.title, status: t.status, char: t.char,
        assignee: t.assignee, tag: t.tag, created: t.created, taken: t.taken, waiting: t.waiting, deadline: t.deadline, closed: t.closed, result: t.result,
        description: t.description, errors: md.validateTask(t, people, tags), overdue: md.isOverdue(t, now, settings.overdueDays),
      })),
    });
  }
  const counters = md.dayCounters(projects.flatMap((p) => p.tasks), await readArchivedTasks(), now);
  return { folder, name: path.basename(folder), projects, people, tags, counters, today: now, settings, version: VERSION };
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

async function archiveTaskFile(file) {
  const rel = path.join(ARCHIVE_TASKS, file);
  let text = await readRel(rel);
  if (text === null) {
    const src = (await readRel(file)) ?? '';
    text = `# ${md.parseProject(src, file).title} — архив\n`;
  }
  return { rel, text };
}

const ops = {
  async create({ file, title }) {
    checkProjectFile(file);
    const text = await readRel(file);
    if (text === null) throw new HttpError(409, 'Файл проекта не найден');
    const t = { bullet: '-', char: ' ', title: checkName(title), created: md.today(), extra: [], id: (await idAllocator())() };
    const out = md.insertBlock(text, md.taskBlock(t));
    return { files: { [file]: out }, task: { file, line: md.formatTaskLine(t) } };
  },

  async update({ file, ref, patch }) {
    const { text, t } = await mustTask(file, ref);
    const n = md.applyPatch(await withId(t), patch || {});
    const block = md.taskBlock(n);
    return { files: { [file]: md.replaceBlock(text, t, block) }, task: { file, line: block[0], lineNo: t.lineNo }, rejected: n.rejected || null };
  },

  async delete({ file, ref }) {
    const { text, t } = await mustTask(file, ref);
    const { text: out } = md.removeBlock(text, t);
    const arch = await archiveTaskFile(file);
    const tid = await withId(t);
    const block = md.taskBlock({ ...tid, deleted: md.today() });
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
    const { text: removed } = md.removeBlock(text, t);
    return { files: { [file]: removed, [toFile]: md.insertBlock(target, block, before) }, task: { file: toFile, line: block[0] } };
  },

  async archiveClosed({ file }) {
    checkProjectFile(file);
    let text = await readRel(file);
    if (text === null) throw new HttpError(409, 'Файл проекта не найден');
    const closed = md.parseProject(text, file).tasks.filter((t) => t.status === 'closed');
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

  async personAdd({ name }) {
    const n = checkName(name, 'Имя');
    const text = (await readRel(PEOPLE_FILE)) || '';
    const people = md.parsePeople(text);
    if (people.includes(n)) throw new HttpError(409, 'Такой исполнитель уже есть');
    return { files: { [PEOPLE_FILE]: md.formatPeople([...people, n], text) }, log: [{ project: 'Исполнители', text: `добавлен: ${n}`, kind: 'исполнители', to: n }] };
  },

  async personRename({ from, to }) {
    const n = checkName(to, 'Имя');
    const text = (await readRel(PEOPLE_FILE)) || '';
    const people = md.parsePeople(text);
    if (!people.includes(from)) throw new HttpError(409, 'Исполнитель не найден');
    if (n !== from && people.includes(n)) throw new HttpError(409, 'Такой исполнитель уже есть');
    const files = { [PEOPLE_FILE]: md.formatPeople(people.map((p) => (p === from ? n : p)), text) };
    for (const file of await listProjectFiles()) {
      let t = await readRel(file);
      const tasks = md.parseProject(t, file).tasks.filter((x) => x.assignee === from);
      if (!tasks.length) continue;
      for (const x of tasks.reverse()) t = md.replaceBlock(t, { ...x, endNo: x.lineNo + 1 }, [md.formatTaskLine({ ...x, assignee: n })]);
      files[file] = t;
    }
    return { files, log: [{ project: 'Исполнители', text: `переименован: ${from} → ${n} (во всех задачах)`, kind: 'исполнители', from, to: n }] };
  },

  async personDelete({ name }) {
    const text = (await readRel(PEOPLE_FILE)) || '';
    const people = md.parsePeople(text);
    const places = [];
    for (const file of await listProjectFiles()) {
      const p = md.parseProject((await readRel(file)) || '', file);
      for (const t of p.tasks) if (t.assignee === name) places.push(`${p.title}: ${t.title}`);
    }
    if (places.length) throw new HttpError(409, `Нельзя удалить: ${name} назначен(а) на задачи`, { places });
    return { files: { [PEOPLE_FILE]: md.formatPeople(people.filter((p) => p !== name), text) }, log: [{ project: 'Исполнители', text: `удалён: ${name}`, kind: 'исполнители', from: name }] };
  },

  async tagAdd({ name }) {
    const n = md.fieldValue(checkName(name, 'Тэг')).slice(0, 40);
    const text = (await readRel(TAGS_FILE)) || '';
    const tags = md.parsePeople(text);
    if (tags.includes(n)) throw new HttpError(409, 'Такой тэг уже есть');
    return { files: { [TAGS_FILE]: md.formatPeople([...tags, n], text, '# Тэги') }, log: [{ project: 'Тэги', text: `добавлен: ${n}`, kind: 'тэги', to: n }] };
  },

  async tagRename({ from, to }) {
    const n = md.fieldValue(checkName(to, 'Тэг')).slice(0, 40);
    const text = (await readRel(TAGS_FILE)) || '';
    const tags = md.parsePeople(text);
    if (!tags.includes(from)) throw new HttpError(409, 'Тэг не найден');
    if (n !== from && tags.includes(n)) throw new HttpError(409, 'Такой тэг уже есть');
    const files = { [TAGS_FILE]: md.formatPeople(tags.map((x) => (x === from ? n : x)), text, '# Тэги') };
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
    const tags = md.parsePeople(text);
    const places = [];
    for (const file of await listProjectFiles()) {
      const p = md.parseProject((await readRel(file)) || '', file);
      for (const t of p.tasks) if (t.tag === name) places.push(`${p.title}: ${t.title}`);
    }
    if (places.length) throw new HttpError(409, `Нельзя удалить: тэг «${name}» стоит у задач`, { places });
    return { files: { [TAGS_FILE]: md.formatPeople(tags.filter((x) => x !== name), text, '# Тэги') }, log: [{ project: 'Тэги', text: `удалён: ${name}`, kind: 'тэги', from: name }] };
  },
};

const projTitle = (file, text) => md.parseProject(text || '', file).title;

async function takeSnapshot() {
  const files = {};
  for (const f of await listProjectFiles()) {
    const p = md.parseProject((await readRel(f)) ?? '', f);
    files[f] = { title: p.title, tasks: p.tasks };
  }
  return { files, people: await readPeople(), tags: await readTags() };
}

// Правки, сделанные вне борда (Obsidian и т.п.): сравниваем с последним снимком и пишем в журнал.
async function syncExternal() {
  if (!folder) return;
  const cur = await takeSnapshot();
  const events = [...log.diffSnapshots(snap.files, cur.files, ' (вне борда)', true), ...log.diffPeople(snap.people, cur.people, ' (вне борда)', true), ...log.diffPeople(snap.tags || [], cur.tags, ' (вне борда)', true, 'Тэги')];
  snap = cur;
  await log.appendLog(folder, events);
  if (events.length) await updateStatsFile();
}

async function logAfterWrite(explicit) {
  const cur = await takeSnapshot();
  const events = explicit ?? [...log.diffSnapshots(snap.files, cur.files), ...log.diffPeople(snap.people, cur.people), ...log.diffPeople(snap.tags || [], cur.tags, '', false, 'Тэги')];
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
  await logAfterWrite(list.slice(0, 200).map((e) => ({ project: String(e.project || ''), task: String(e.task || ''), id: String(e.id || ''), text: `${word}: ${String(e.text || '')}`, kind, what: String(e.kind || '') })));
  await updateStatsFile();
}

let queue = Promise.resolve();
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

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
    case 'GET /api/board': needFolder(); return send(res, 200, await getBoard());
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
      return send(res, 200, { changes: result.changes, task: result.task || null, events: result.events, rejected: result.rejected || null });
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
else if (config.last && fs.existsSync(config.last)) { folder = config.last; snap = await takeSnapshot(); startWatcher(); statsSoon(); }
listen();
