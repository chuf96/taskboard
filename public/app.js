// Task Board — интерфейс. Чистый JS без зависимостей.

const STATUSES = [
  { id: 'new', label: 'Новая' },
  { id: 'progress', label: 'В работе' },
  { id: 'waiting', label: 'Ожидание' },
  { id: 'closed', label: 'Закрыта' },
  { id: 'cancelled', label: 'Отменена' },
];
const isDone = (t) => t.status === 'closed' || t.status === 'cancelled';
const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label]));
STATUS_LABEL.error = 'Ошибка';

const TITLE_MAX = 100; // совпадает с ограничением сервера

const $app = document.getElementById('app');
const $panel = document.getElementById('panel');
const $overlay = document.getElementById('overlay');
const $toasts = document.getElementById('toasts');

const state = {
  mode: 'loading',
  board: null,
  openClosed: new Set(),     // колонки с раскрытым «Закрыто»
  adding: null,              // { file, value } — открытое поле «+ Задача»
  panel: null,               // { file, line, lineNo, stale }
  undo: [], redo: [],
  pending: 0,
};

// ---------- утилиты ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

function toast(msg, isErr = false) {
  const el = h(`<div class="toast${isErr ? ' err' : ''}">${esc(msg)}</div>`);
  $toasts.append(el);
  setTimeout(() => el.remove(), isErr ? 5000 : 2500);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Ошибка'); e.status = res.status; e.data = data; throw e; }
  return data;
}

const dayMs = 86400000;
const toUTC = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(toUTC(s));
const daysBetween = (a, b) => Math.max(0, Math.round((toUTC(b) - toUTC(a)) / dayMs));
function shortDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}${y !== state.board.today.slice(0, 4) ? '.' + y : ''}`;
}
const plural = (n) => `${n} дн.`;
const ruDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
function parseRuDate(s) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(s.trim());
  if (!m) return null;
  if (m[3].length === 2) m[3] = '20' + m[3]; // 17.09.26 → 2026
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return d.getUTCDate() === +m[1] && d.getUTCMonth() === +m[2] - 1 ? iso : null;
}

function whenText(t) {
  // На карточке дата видна только у «Ожидания ответа» с указанным сроком
  if (t.status === 'waiting' && validDate(t.deadline)) return `Дедлайн ${shortDate(t.deadline)}`;
  return '';
}
// Маска даты: вводятся только цифры, точки ставятся сами (17092026 → 17.09.2026)
function formatDigits(d) {
  return d.slice(0, 2) + (d.length > 2 ? '.' + d.slice(2, 4) : '') + (d.length > 4 ? '.' + d.slice(4, 8) : '');
}
function maskDate(inp) {
  inp.setAttribute('inputmode', 'numeric');
  inp.setAttribute('maxlength', '10');
  inp.addEventListener('beforeinput', (e) => {
    // Backspace сразу после точки удаляет и точку, и цифру перед ней
    if (e.inputType === 'deleteContentBackward' && inp.selectionStart === inp.selectionEnd && inp.value[inp.selectionStart - 1] === '.') {
      e.preventDefault();
      const pos = inp.selectionStart - 1;
      const before = inp.value.slice(0, pos).replace(/\D/g, '').slice(0, -1);
      const after = inp.value.slice(pos + 1).replace(/\D/g, '');
      inp.value = formatDigits((before + after).slice(0, 8));
      const caret = formatDigits(before).length;
      inp.setSelectionRange(caret, caret);
    }
  });
  inp.addEventListener('input', () => {
    const caretDigits = inp.value.slice(0, inp.selectionStart).replace(/\D/g, '').length;
    const digits = inp.value.replace(/\D/g, '').slice(0, 8);
    inp.value = formatDigits(digits);
    let caret = formatDigits(digits.slice(0, caretDigits)).length;
    if (caretDigits === digits.length && (digits.length === 2 || digits.length === 4)) { inp.value += '.'; caret++; }
    inp.setSelectionRange(caret, caret);
  });
}

// Счётчик «Осталось N» под полем названия. alwaysShow=false — показывать, только когда осталось мало.
function attachCounter(input, alwaysShow) {
  const el = h('<div class="counter"></div>');
  const upd = () => {
    const left = TITLE_MAX - input.value.length;
    el.textContent = left >= 0 ? `Осталось ${left}` : `Лишних символов: ${-left}`;
    el.classList.toggle('low', left <= 10);
    el.hidden = !alwaysShow && left > 30;
  };
  input.addEventListener('input', upd);
  input._updateCounter = upd;
  upd();
  return el;
}

// Цвета тэгов: фон и текст. Цвет выбирается при создании тэга и хранится в _тэги.md как [цвет:: …];
// у тэга без цвета он подбирается по названию — один тэг всегда одного цвета
const TAG_COLORS = {
  'серый': ['#eceae6', '#5a5853'], 'коричневый': ['#f0e2d9', '#7a4a31'], 'оранжевый': ['#fde0c8', '#a34d0f'],
  'жёлтый': ['#fbefc0', '#8a6500'], 'лаймовый': ['#e8f2c4', '#5b6e12'], 'зелёный': ['#d8eedb', '#2f6b3a'],
  'мятный': ['#d3f0e8', '#1f6b58'], 'бирюзовый': ['#d0eef1', '#1c6670'], 'голубой': ['#dbeefa', '#245f8a'],
  'синий': ['#dce3fb', '#2f4a9e'], 'фиолетовый': ['#e7defa', '#5b3a9e'], 'сиреневый': ['#f0dcf5', '#7d3a8f'],
  'розовый': ['#fadceb', '#9c2f66'], 'красный': ['#fbdcd9', '#a3312a'],
};
const TAG_COLOR_NAMES = Object.keys(TAG_COLORS);
function tagColor(name) {
  const set = state.board?.tagColors?.[name];
  if (TAG_COLORS[set]) return set;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_COLOR_NAMES[h % TAG_COLOR_NAMES.length];
}
// Тэг рисуется цветной обводкой: цвет текста и рамки берётся из выбранного цвета тэга
function tagStyle(name) {
  return `color:${TAG_COLORS[tagColor(name)][1]}`;
}
// Ряд образцов цвета; onPick получает название цвета
function swatches(selected, onPick) {
  const el = h(`<div class="swatches">${TAG_COLOR_NAMES.map((c) => `<button class="swatch${c === selected ? ' on' : ''}" data-c="${c}" title="${c}" style="background:${TAG_COLORS[c][0]};color:${TAG_COLORS[c][1]}">А</button>`).join('')}</div>`);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.swatch'); if (!b) return;
    el.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
    onPick(b.dataset.c);
  });
  return el;
}
const personHtml = (name) => `<span class="person"><span class="nm">${esc(name)}</span></span>`;
const tagChip = (name) => `<span class="tag" style="${tagStyle(name)}" title="${esc(name)}">${esc(name)}</span>`;

const shownStatus = (t) => (t.errors.length ? 'error' : t.status);

// Очередь операций: всё по порядку, чтобы правки не перегоняли друг друга.
let chain = Promise.resolve();
// onResult вызывается до перерисовки, чтобы панель успела узнать новую строку задачи.
function run(op, label, onResult) {
  state.pending++;
  const p = chain.then(async () => {
    try {
      const r = await api('/api/op', op);
      if (r.changes.length) { state.undo.push({ label, changes: r.changes, events: r.events }); state.undo.length > 50 && state.undo.shift(); state.redo = []; }
      onResult?.(r);
      return r;
    } catch (e) {
      toast(e.message + (e.data?.places ? ': ' + e.data.places.slice(0, 5).join('; ') : ''), true);
      throw e;
    } finally {
      state.pending--;
      await loadBoard();
    }
  });
  chain = p.catch(() => {});
  return p;
}

async function history(dir) {
  const from = dir === 'undo' ? state.undo : state.redo;
  const to = dir === 'undo' ? state.redo : state.undo;
  const item = from.pop();
  if (!item) return toast(dir === 'undo' ? 'Нечего отменять' : 'Нечего возвращать');
  state.pending++;
  chain = chain.then(async () => {
    try {
      await api('/api/restore', { changes: item.changes, dir, events: item.events, label: item.label });
      to.push(item);
      toast(`${dir === 'undo' ? 'Отменено' : 'Возвращено'}: ${item.label}`);
      if (state.panel) state.panel.stale = false;
    } catch (e) { toast(e.message, true); }
    finally { state.pending--; await loadBoard(); if (state.panel) relocatePanel(true); }
  });
}

// ---------- загрузка ----------
async function start() {
  const s = await api('/api/state');
  if (s.folder) { await loadBoard(); connectEvents(); }
  else showPicker(s.recent);
}

async function loadBoard() {
  try {
    state.board = await api('/api/board');
  } catch (e) {
    if (e.status === 409) { const s = await api('/api/state'); return showPicker(s.recent); }
    throw e;
  }
  state.mode = 'board';
  renderBoard();
  syncPanel();
}

let es = null;
function connectEvents() {
  if (es) return;
  es = new EventSource('/api/events');
  let t = null;
  es.addEventListener('change', () => { clearTimeout(t); t = setTimeout(() => { if (!state.pending && state.mode === 'board') loadBoard(); }, 100); });
}

// ---------- выбор папки ----------
async function showPicker(recent, startPath) {
  state.mode = 'picker';
  closePanel();
  let cur = null;
  $app.innerHTML = '';
  const root = h(`<div class="picker">
    <h1>Task Board</h1>
    <p class="sub">Выберите папку с .md-файлами проектов. В следующий раз она откроется сама.</p>
    <div class="recent-wrap"></div>
    <h4>Обзор папок</h4>
    <div class="box">
      <div class="path-bar"><button class="btn subtle up">↑ Наверх</button><button class="btn subtle home">Домой</button><span class="grow"></span></div>
      <div class="dir-list"></div>
      <div class="picker-foot"><span class="grow"></span>${state.board ? '<button class="btn back">Отмена</button>' : ''}<button class="btn primary open">Открыть эту папку</button></div>
    </div>
  </div>`);
  $app.append(root);

  const recentWrap = root.querySelector('.recent-wrap');
  function drawRecent(list) {
    recentWrap.innerHTML = '';
    if (!list?.length) return;
    recentWrap.append(h('<h4>Недавние</h4>'));
    const box = h('<div class="box"></div>');
    for (const p of list) {
      const row = h(`<div class="row"><span>📁</span><span class="grow">${esc(p.split(/[\\/]/).pop())} <span class="hint">${esc(p)}</span></span><button class="icon-btn" title="Убрать из списка">×</button></div>`);
      row.addEventListener('click', () => openFolder(p));
      row.querySelector('button').addEventListener('click', async (e) => { e.stopPropagation(); drawRecent((await api('/api/forget', { path: p })).recent); });
      box.append(row);
    }
    recentWrap.append(box);
  }
  drawRecent(recent);

  async function go(p) {
    try { cur = await api('/api/fs' + (p ? '?path=' + encodeURIComponent(p) : '')); }
    catch (e) { return toast(e.message, true); }
    root.querySelector('.path-bar .grow').textContent = cur.path;
    root.querySelector('.path-bar .grow').title = cur.path;
    root.querySelector('.up').disabled = !cur.parent;
    const list = root.querySelector('.dir-list');
    list.innerHTML = '';
    if (!cur.dirs.length) list.append(h('<div class="row" style="cursor:default"><span class="grow hint">Вложенных папок нет</span></div>'));
    for (const d of cur.dirs) {
      const row = h(`<div class="row"><span>📁</span><span class="grow">${esc(d)}</span><span class="hint">›</span></div>`);
      row.addEventListener('click', () => go(cur.path.replace(/[\\/]$/, '') + (cur.path.includes('\\') ? '\\' : '/') + d));
      list.append(row);
    }
    root.querySelector('.picker-foot .grow').textContent = cur.mdCount ? `В папке ${cur.mdCount} .md-файл(ов) — это будут проекты` : 'В папке нет .md-файлов — можно создать проекты позже';
  }
  root.querySelector('.up').addEventListener('click', () => cur?.parent && go(cur.parent));
  root.querySelector('.home').addEventListener('click', () => go(cur?.home));
  root.querySelector('.open').addEventListener('click', () => cur && openFolder(cur.path));
  root.querySelector('.back')?.addEventListener('click', () => loadBoard());
  go(startPath);
}

async function openFolder(p) {
  try {
    await api('/api/open', { path: p });
    state.undo = []; state.redo = []; state.openClosed.clear();
    await loadBoard();
    connectEvents();
  } catch (e) { toast(e.message, true); }
}

// ---------- доска ----------
// Доска v2: проекты — строки-группы, задача — одна строка. Все поля строки кликабельные.
const ICON = {
  star: (on) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg>`,
  chev: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3"/></svg>',
  chevR: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3l3 3-3 3"/></svg>',
  plus: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 2.5v7M2.5 6h7"/></svg>',
  open: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M9.5 2.5v11"/></svg>',
  more: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  burger: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 5h12M3 9h12M3 13h12"/></svg>',
};
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function dueText(iso) {
  const [y, m, d] = iso.split('-');
  return `до ${+d} ${MONTHS[+m - 1]}${y !== state.board.today.slice(0, 4) ? ' ' + y : ''}`;
}

// Свёрнутые группы запоминаются для каждой папки в браузере
const collapseKey = () => 'taskboard.collapsed:' + (state.board?.folder || '');
function loadCollapsed() {
  try { state.collapsed = new Set(JSON.parse(localStorage.getItem(collapseKey()) || '[]')); } catch { state.collapsed = new Set(); }
}
function toggleCollapsed(key) {
  state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key);
  try { localStorage.setItem(collapseKey(), JSON.stringify([...state.collapsed])); } catch {}
  renderBoard();
}

function renderBoard() {
  const b = state.board;
  if (!state.collapsed || state.collapsedFor !== b.folder) { loadCollapsed(); state.collapsedFor = b.folder; }
  const scroll = $app.querySelector('.board')?.scrollTop || 0;
  const c = b.counters || { total: 0, created: 0, closed: 0 };
  const ratio = c.created ? `${Math.round((c.closed / c.created) * 100)}%` : '—';

  $app.innerHTML = '';
  const top = h(`<header class="topbar">
    <button class="name" title="${esc(b.folder)}">${esc(b.name)} <span class="chev">${ICON.chev}</span></button>
    <div class="counters">
      <span class="ctr" title="Все незакрытые задачи на доске"><b>${c.total}</b> всего задач</span>
      <span class="ctr" title="Задачи, созданные сегодня"><b>${c.created}</b> создано сегодня</span>
      <span class="ctr" title="Задачи, закрытые сегодня"><b>${c.closed}</b> закрыто сегодня</span>
      <span class="ratio" title="Закрыто сегодня / создано сегодня${c.created ? '' : ' — сегодня ещё ничего не создано'}">${ratio}</span>
    </div>
    <span class="spacer"></span>
    ${state.waitFilter ? `<button class="filter-chip" title="Сбросить фильтр (Esc)">Ожидания: ${esc(state.waitFilter)} <span>✕</span></button>` : ''}
    <button class="icon-btn burger" title="Меню" aria-label="Меню">${ICON.burger}</button>
  </header>`);
  top.querySelector('.name').addEventListener('click', (e) => showMenu(e.currentTarget, [
    { label: 'Сменить папку…', action: async () => showPicker((await api('/api/state')).recent, b.folder) },
  ]));
  top.querySelector('.filter-chip')?.addEventListener('click', () => setWaitFilter(null));
  top.querySelector('.burger').addEventListener('click', (e) => showMenu(e.currentTarget, [
    { label: 'Фильтр ожиданий ›', action: (anchor) => waitFilterMenu(anchor) },
    { label: 'Новый проект', action: addProject },
    { label: 'Исполнители', action: showPeople },
    { label: 'Тэги', action: showTags },
    { label: 'Настройки', action: showSettings },
    '-',
    { html: `<span class="menu-version">Версия ${esc((b.version || '').replace(/\.0$/, ''))}</span>`, disabled: true, action: () => {} },
  ]));
  $app.append(top);

  const board = h('<main class="board"><div class="list"></div></main>');
  const list = board.querySelector('.list');
  if (!b.projects.length) {
    list.append(h(`<div class="empty"><h2>Проектов пока нет</h2><p>Каждый проект — это .md-файл в папке.</p><button class="btn primary">Создать проект</button></div>`));
    list.querySelector('button').addEventListener('click', addProject);
  } else {
    list.append(renderFocus());
    const filter = state.waitFilter;
    const shown = filter ? b.projects.filter((p) => p.tasks.some((t) => isWaitingFor(t, filter))) : b.projects;
    for (const p of shown) list.append(renderProject(p));
    if (filter && !shown.length) {
      list.append(h(`<div class="empty"><h2>У исполнителя ${esc(filter)} нет задач в ожидании</h2><button class="btn primary">Сбросить фильтр</button></div>`));
      list.querySelector('.empty button').addEventListener('click', () => setWaitFilter(null));
    }
  }
  $app.append(board);
  board.scrollTop = scroll;

  const input = board.querySelector('.add-input');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); input.scrollIntoView({ block: 'nearest' }); }
  if (state.editTitle) {
    const row = [...board.querySelectorAll('.trow')].find((r) => r._ref.file === state.editTitle.file && r._ref.line === state.editTitle.line && r.dataset.group !== 'focus');
    state.editTitle = null;
    if (row) startTitleEdit(row);
  }
}

const isWaitingFor = (t, name) => t.status === 'waiting' && t.assignee === name;
const isOpenTask = (t) => !isDone(t) || t.errors.length;

function setWaitFilter(name) {
  state.waitFilter = name;
  state.adding = null;
  renderBoard();
}

// Вложенное меню «Фильтр ожиданий»: только исполнители, у которых есть задачи в «Ожидании ответа»
function waitFilterMenu(anchor) {
  const counts = new Map();
  for (const p of state.board.projects) for (const t of p.tasks) if (t.status === 'waiting' && t.assignee) counts.set(t.assignee, (counts.get(t.assignee) || 0) + 1);
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'ru'));
  const items = [{ html: '<span class="menu-back">‹ Фильтр ожиданий</span>', action: () => anchor.click() }, '-'];
  if (!names.length) items.push({ label: 'Нет задач в ожидании', disabled: true, action: () => {} });
  for (const n of names) items.push({ html: `<span class="grow">${esc(n)}</span><span class="menu-count">${counts.get(n)}</span>`, active: state.waitFilter === n, action: () => setWaitFilter(n) });
  if (state.waitFilter) items.push('-', { label: 'Сбросить фильтр', action: () => setWaitFilter(null) });
  showMenu(anchor, items);
}

function groupHead(key, title, count, cls = '') {
  const collapsed = state.collapsed.has(key);
  return h(`<div class="gh${cls}${collapsed ? ' collapsed' : ''}">
    <span class="chev">${ICON.chev}</span><h2 title="${esc(title)}">${esc(title)}</h2><span class="count">${count}</span>
  </div>`);
}

// «В фокусе сегодня»: незакрытые задачи со звездой из всех проектов
function renderFocus() {
  const filter = state.waitFilter;
  const items = [];
  for (const p of state.board.projects) for (const t of p.tasks) if (t.focus && !isDone(t) && (!filter || isWaitingFor(t, filter))) items.push([p, t]);
  const g = h('<section class="group focus-group"></section>');
  const head = groupHead('focus', 'В фокусе сегодня', items.length, ' focus');
  head.addEventListener('click', () => toggleCollapsed('focus'));
  g.append(head);
  if (state.collapsed.has('focus')) return g;
  for (const [p, t] of items) g.append(renderRow(p, t, 'focus'));
  if (!items.length) g.append(h(`<div class="hint-row">Отметьте звездой задачи, которыми займётесь сегодня, — они соберутся здесь.</div>`));
  return g;
}

function renderProject(p) {
  const filter = state.waitFilter;
  const open = filter ? p.tasks.filter((t) => isWaitingFor(t, filter)) : p.tasks.filter(isOpenTask);
  const closed = filter ? [] : p.tasks.filter((t) => !isOpenTask(t));
  const g = h(`<section class="group" data-file="${esc(p.file)}"></section>`);
  const head = groupHead(p.file, p.title, open.length);
  head.setAttribute('draggable', 'true');
  head.append(h(`<button class="icon-btn more" title="Действия с проектом">${ICON.more}</button>`));
  head.addEventListener('click', (e) => { if (!e.target.closest('.more')) toggleCollapsed(p.file); });
  head.querySelector('.more').addEventListener('click', (e) => showMenu(e.currentTarget, [
    { label: 'Переименовать', action: () => renameProject(p) },
    { label: `Архивировать закрытые${closed.length ? ` (${closed.length})` : ''}`, disabled: !closed.length, action: () => run({ type: 'archiveClosed', file: p.file }, 'архивация закрытых') },
    '-',
    { label: 'Архивировать проект', danger: true, action: () => confirmDialog('Архивировать проект?', `Файл «${p.file}» будет перенесён в папку архив/проекты. Его можно вернуть вручную.`, 'Архивировать', () => run({ type: 'archiveProject', file: p.file }, 'архивация проекта')) },
  ]));
  g.append(head);
  setupProjectDnd(g, head, p);
  if (state.collapsed.has(p.file)) return g;

  const rows = h('<div class="rows open-rows"></div>');
  for (const t of open) rows.append(renderRow(p, t, p.file));
  g.append(rows);

  if (closed.length) {
    const isOpen = state.openClosed.has(p.file);
    const label = closed.some((t) => t.status === 'cancelled') ? 'Закрытые и отменённые' : 'Закрытые';
    const tog = h(`<button class="more-row closed-toggle${isOpen ? ' open' : ''}"><span class="chev">${ICON.chevR}</span>${label}: ${closed.length}</button>`);
    tog.addEventListener('click', () => { isOpen ? state.openClosed.delete(p.file) : state.openClosed.add(p.file); renderBoard(); });
    g.append(tog);
    if (isOpen) {
      const cr = h('<div class="rows closed-rows"></div>');
      for (const t of closed) cr.append(renderRow(p, t, p.file));
      g.append(cr);
    }
  }

  if (!filter) {
    if (state.adding?.file === p.file) {
      const wrap = h(`<div class="add-row-wrap"><input class="add-input" maxlength="${TITLE_MAX}" placeholder="Название задачи… Enter — добавить, Esc — закрыть"></div>`);
      const inp = wrap.querySelector('input');
      inp.value = state.adding.value;
      inp.addEventListener('input', () => { state.adding.value = inp.value; });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const title = inp.value.trim();
          if (!title) return;
          // Поле очищаем только после успешного создания — при ошибке текст остаётся
          run({ type: 'create', file: p.file, title }, 'создание задачи', () => { if (state.adding?.file === p.file) state.adding.value = ''; }).catch(() => {});
        } else if (e.key === 'Escape') { e.stopPropagation(); state.adding = null; renderBoard(); }
      });
      inp.addEventListener('blur', () => setTimeout(() => {
        if (inp.isConnected && state.adding?.file === p.file && !state.adding.value.trim() && document.activeElement !== inp && !state.pending) { state.adding = null; renderBoard(); }
      }, 150));
      g.append(wrap);
    } else {
      const add = h(`<button class="more-row add-task"><span class="chev">${ICON.plus}</span>Задача</button>`);
      add.addEventListener('click', () => { state.adding = { file: p.file, value: '' }; renderBoard(); });
      g.append(add);
    }
  }
  setupRowDrop(g, p);
  return g;
}

const STATUS_DOT = { new: 'new', progress: 'progress', waiting: 'waiting', closed: 'closed', cancelled: 'cancelled', error: 'error' };

function dueCell(t) {
  if (t.status !== 'waiting') return '';
  if (validDate(t.deadline)) return `<button class="ed due${t.overdue ? ' over' : ''}" data-f="due" title="Вернуться до ${esc(ruDate(t.deadline))}">${esc(dueText(t.deadline))}</button>`;
  if (t.overdue && validDate(t.waiting)) return `<button class="ed due over" data-f="due" title="Ждём ответа с ${esc(ruDate(t.waiting))}. Нажмите, чтобы указать срок">ждём ${daysBetween(t.waiting, state.board.today)} дн.</button>`;
  return '<button class="ed due blank" data-f="due">+ срок</button>';
}

function renderRow(p, t, group) {
  const st = shownStatus(t);
  const sel = state.panel && state.panel.file === p.file && state.panel.line === t.line;
  const cls = ['trow', isDone(t) && !t.errors.length ? 'done' : '', t.status === 'cancelled' ? 'cancelled' : '', sel ? 'selected' : ''].filter(Boolean).join(' ');
  const row = h(`<div class="${cls}" data-group="${esc(group)}">
    <button class="star${t.focus ? ' on' : ''}" title="${t.focus ? 'Убрать из фокуса' : 'В фокус на сегодня'}">${ICON.star(t.focus)}</button>
    <button class="ed st" data-f="status" title="Сменить статус"><span class="dot ${STATUS_DOT[st]}"></span><span class="st-label">${STATUS_LABEL[st]}</span></button>
    <span class="cell-title"><button class="ed title" data-f="title" title="${esc(t.title)}">${esc(t.title || 'Без названия')}</button></span>
    <span class="cell-tag">${t.tag ? `<button class="ed tagpill" data-f="tag" style="${tagStyle(t.tag)}" title="${esc(t.tag)}">${esc(t.tag)}</button>` : '<button class="ed blank" data-f="tag">+ тэг</button>'}</span>
    <span class="cell-who"><button class="ed who${t.assignee ? '' : ' blank'}" data-f="assignee" title="${esc(t.assignee || 'Выбрать исполнителя')}">${esc(t.assignee || '+ исполнитель')}</button></span>
    <span class="cell-due">${dueCell(t)}</span>
    <button class="open-btn" title="Открыть задачу: даты, комментарий, удаление">${ICON.open}</button>
  </div>`);
  row._ref = { file: p.file, line: t.line, lineNo: t.lineNo };
  row.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (e.target.closest('.star')) return updateTask(p.file, t, { focus: !t.focus }, t.focus ? 'снятие фокуса' : 'фокус');
    if (f === 'status') return statusMenu(e.target.closest('[data-f]'), p.file, t);
    if (f === 'title') return startTitleEdit(row);
    if (f === 'tag') return tagMenu(e.target.closest('[data-f]'), t.tag, (v) => updateTask(p.file, t, { tag: v }, 'смена тэга'));
    if (f === 'assignee') return assigneeMenu(e.target.closest('[data-f]'), t.assignee, (v) => updateTask(p.file, t, { assignee: v }, 'смена исполнителя'));
    if (f === 'due') return duePopover(e.target.closest('[data-f]'), p.file, t);
    openPanel(p.file, t);
  });
  if (group !== 'focus') {
    row.setAttribute('draggable', 'true');
    row.addEventListener('dragstart', (e) => {
      if (row.querySelector('.title-edit')) { e.preventDefault(); return; }
      e.stopPropagation();
      drag = { kind: 'row', ref: row._ref };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', t.title);
      setTimeout(() => row.classList.add('dragging'), 0);
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); clearDrop(); drag = null; });
  }
  return row;
}

// Название правится прямо в строке: Enter — сохранить, Esc — отменить
function startTitleEdit(row) {
  const btn = row.querySelector('[data-f="title"]');
  if (!btn) return;
  const { file, line } = row._ref;
  const f = findTask(file, line);
  if (!f?.t) return;
  const inp = h(`<input class="title-edit" maxlength="${TITLE_MAX}">`);
  inp.value = f.t.title;
  btn.replaceWith(inp);
  row.setAttribute('draggable', 'false');
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    if (save && v && v !== f.t.title) updateTask(file, f.t, { title: v }, 'переименование задачи');
    else renderBoard();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('click', (e) => e.stopPropagation());
}

// Выбор исполнителя: сначала группа, потом человек. Если групп нет — сразу список людей.
function assigneeMenu(anchor, current, onPick, group) {
  const all = state.board.peopleGroups || state.board.people.map((name) => ({ name, group: '' }));
  const groups = [...new Set(all.map((p) => p.group))];
  const none = { html: '<span class="faint">Без исполнителя</span>', active: !current, action: () => onPick('') };
  const person = (p) => ({ html: `<span class="grow">${esc(p.name)}</span>`, active: current === p.name, action: () => onPick(p.name) });
  if (!all.length) return showMenu(anchor, [none, { label: 'Справочник пуст — добавьте в меню ☰ → «Исполнители»', disabled: true, action: () => {} }]);
  if (groups.length === 1 && groups[0] === '') return showMenu(anchor, [...all.map(person), '-', none]);
  if (group === undefined) {
    return showMenu(anchor, [
      ...groups.map((g) => {
        const people = all.filter((p) => p.group === g);
        const has = people.some((p) => p.name === current);
        return { html: `<span class="grow${has ? ' strong' : ''}">${esc(g || 'Без группы')}</span><span class="menu-count">${people.length} ›</span>`, keep: true, action: (a) => assigneeMenu(a, current, onPick, g) };
      }),
      '-', none,
    ]);
  }
  showMenu(anchor, [
    { html: `<span class="menu-back">‹ ${esc(group || 'Без группы')}</span>`, keep: true, action: (a) => assigneeMenu(a, current, onPick) },
    '-',
    ...all.filter((p) => p.group === group).map(person),
  ]);
}

function tagMenu(anchor, current, onPick) {
  const tags = state.board.tags || [];
  showMenu(anchor, [
    ...tags.map((n) => ({ html: tagChip(n), active: current === n, action: () => onPick(n) })),
    ...(tags.length ? ['-'] : [{ label: 'Тэгов нет — добавьте в меню ☰ → «Тэги»', disabled: true, action: () => {} }]),
    { html: '<span class="faint">Без тэга</span>', active: !current, action: () => onPick('') },
  ]);
}

// Срок «вернуться до» в строке: поле с маской даты
function duePopover(anchor, file, t) {
  const el = h(`<div class="popover-form">
    <span class="pop-label">Вернуться до</span>
    <input class="field" placeholder="дд.мм.гггг">
    ${t.deadline ? '<button class="btn subtle clear">Убрать срок</button>' : ''}
  </div>`);
  const inp = el.querySelector('input');
  maskDate(inp);
  inp.value = validDate(t.deadline) ? ruDate(t.deadline) : '';
  const save = () => {
    const v = inp.value.trim();
    const iso = v ? parseRuDate(v) : '';
    if (iso === null) return toast('Дата должна быть в формате ДД.ММ.ГГГГ', true);
    closeMenu();
    if (iso !== (t.deadline || '')) updateTask(file, t, { deadline: iso }, 'изменение срока');
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } });
  el.querySelector('.clear')?.addEventListener('click', () => { closeMenu(); updateTask(file, t, { deadline: '' }, 'изменение срока'); });
  showPopover(anchor, el);
  inp.focus(); inp.select();
}

// ---------- перетаскивание ----------
let drag = null;
let dropMarker = null;
function clearDrop() {
  dropMarker?.remove(); dropMarker = null;
  document.querySelectorAll('.drag-over').forEach((c) => c.classList.remove('drag-over'));
}

// Задачи перетаскиваются внутри проекта и между проектами
function setupRowDrop(g, p) {
  const findBefore = (container, y) => [...container.querySelectorAll('.trow:not(.dragging)')].find((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; }) || null;
  g.addEventListener('dragover', (e) => {
    if (drag?.kind !== 'row') return;
    e.preventDefault();
    const container = e.target.closest('.rows') || g.querySelector('.open-rows');
    if (!container) return;
    const before = findBefore(container, e.clientY);
    if (!dropMarker) dropMarker = h('<div class="drop-line"></div>');
    if (before) container.insertBefore(dropMarker, before); else container.append(dropMarker);
    dropMarker._before = before; dropMarker._container = container;
  });
  g.addEventListener('dragleave', (e) => { if (!g.contains(e.relatedTarget)) { dropMarker?.remove(); dropMarker = null; } });
  g.addEventListener('drop', (e) => {
    if (drag?.kind !== 'row' || !dropMarker) return;
    e.preventDefault();
    let before = dropMarker._before?._ref || null;
    // Сброс в конец открытых задач: вставляем перед первой закрытой, чтобы задача не ушла в хвост
    if (!before && dropMarker._container.classList.contains('open-rows')) {
      const closedT = p.tasks.find((t) => !isOpenTask(t) && t.line !== drag.ref.line);
      if (closedT) before = { line: closedT.line, lineNo: closedT.lineNo };
    }
    const ref = drag.ref;
    clearDrop();
    if (before && before.line === ref.line && before.lineNo === ref.lineNo && ref.file === p.file) return;
    const followPanel = state.panel && state.panel.file === ref.file && state.panel.line === ref.line;
    run({ type: 'move', file: ref.file, ref: { line: ref.line, lineNo: ref.lineNo }, toFile: p.file, beforeRef: before }, 'перенос задачи', (r) => {
      if (followPanel && r.task && state.panel) Object.assign(state.panel, { file: r.task.file, line: r.task.line });
    }).catch(() => {});
  });
}

// Проекты переставляются перетаскиванием заголовка
function setupProjectDnd(g, head, p) {
  head.addEventListener('dragstart', (e) => {
    drag = { kind: 'project', file: p.file };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', p.title);
    setTimeout(() => g.classList.add('dragging'), 0);
  });
  head.addEventListener('dragend', () => { g.classList.remove('dragging'); clearDrop(); drag = null; });
  g.addEventListener('dragover', (e) => {
    if (drag?.kind !== 'project' || drag.file === p.file) return;
    e.preventDefault();
    document.querySelectorAll('.drag-over').forEach((x) => x !== g && x.classList.remove('drag-over'));
    g.classList.add('drag-over');
  });
  g.addEventListener('drop', (e) => {
    if (drag?.kind !== 'project' || drag.file === p.file) return;
    e.preventDefault();
    const files = state.board.projects.map((x) => x.file).filter((f) => f !== drag.file);
    const r = g.getBoundingClientRect();
    const idx = files.indexOf(p.file) + (e.clientY > r.top + Math.min(r.height / 2, 40) ? 1 : 0);
    files.splice(idx, 0, drag.file);
    clearDrop();
    run({ type: 'reorderProjects', order: files }, 'порядок проектов').catch(() => {});
  });
}

function statusMenu(anchor, file, t) {
  showMenu(anchor, STATUSES.map((s) => ({
    html: `<span class="status-opt"><span class="dot ${s.id}"></span>${s.label}</span>`,
    active: t.status === s.id && !t.errors.some((e) => e.startsWith('Неизвестный')),
    action: () => {
      flushPanel();
      if (s.id === 'closed' && t.status !== 'closed') closeDialog(file, t);
      else updateTask(file, t, { status: s.id }, 'смена статуса');
    },
  })));
}

// При закрытии предлагаем записать результат — необязательно
function closeDialog(file, t) {
  const wrap = h(`<div class="close-form">
    <p class="close-task"></p>
    <label class="setting"><span>Результат</span><input class="field result" maxlength="300" placeholder="Чем закончилось, одной строкой (необязательно)"></label>
  </div>`);
  wrap.querySelector('.close-task').textContent = `«${t.title}»`;
  const res = wrap.querySelector('input');
  const ok = () => {
    closeModal();
    const patch = { status: 'closed' };
    if (res.value.trim()) patch.result = res.value.trim();
    updateTask(file, t, patch, 'закрытие задачи');
  };
  modal('Закрыть задачу', wrap, [{ label: 'Отмена', action: closeModal }, { label: 'Закрыть задачу', cls: 'primary', action: ok }]);
  res.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  res.focus();
}

function updateTask(file, t, patch, label = 'изменение задачи') {
  const ref = state.panel && state.panel.file === file && state.panel.line === t.line ? state.panel : { file, line: t.line, lineNo: t.lineNo };
  const isPanel = ref === state.panel;
  return run({ type: 'update', file, ref: { line: ref.line, lineNo: ref.lineNo }, patch }, label, (r) => {
    if (isPanel && r.task && state.panel) {
      state.panel.line = r.task.line; state.panel.lineNo = r.task.lineNo;
    }
    if (r.rejected === 'deadline') toast('«Вернуться до» не может быть раньше «Ждём ответа с» — срок стёрт', true);
  }).catch(() => {});
}

// ---------- меню ----------
let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; }
function showMenu(anchor, items) {
  closeMenu();
  menuEl = h('<div class="menu"></div>');
  for (const it of items) {
    if (it === '-') { menuEl.append(h('<hr>')); continue; }
    const b = h(`<button class="${it.danger ? 'danger' : ''}${it.active ? ' active' : ''}">${it.html || esc(it.label)}</button>`);
    if (it.disabled) { b.disabled = true; b.style.opacity = .45; }
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.action(anchor); });
    menuEl.append(b);
  }
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  menuEl.style.left = Math.max(8, Math.min(r.left, innerWidth - mw - 8)) + 'px';
  menuEl.style.top = (r.bottom + 4 + mh > innerHeight ? r.top - mh - 4 : r.bottom + 4) + 'px';
}
// Всплывающая форма (например, срок) — в том же слое, что и меню
function showPopover(anchor, el) {
  closeMenu();
  menuEl = h('<div class="menu popover"></div>');
  menuEl.append(el);
  document.body.append(menuEl);
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  menuEl.style.left = Math.max(8, Math.min(r.left, innerWidth - mw - 8)) + 'px';
  menuEl.style.top = (r.bottom + 4 + mh > innerHeight ? r.top - mh - 4 : r.bottom + 4) + 'px';
}
document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });

// ---------- диалоги ----------
function modal(title, contentEl, actions) {
  $overlay.innerHTML = '';
  const m = h(`<div class="modal"><h3>${esc(title)}</h3><div class="content"></div><div class="actions"></div></div>`);
  m.querySelector('.content').append(contentEl);
  for (const a of actions) {
    const b = h(`<button class="btn ${a.cls || ''}">${esc(a.label)}</button>`);
    b.addEventListener('click', a.action);
    m.querySelector('.actions').append(b);
  }
  $overlay.append(m);
  $overlay.hidden = false;
  return m;
}
function closeModal() { $overlay.hidden = true; $overlay.innerHTML = ''; }
$overlay.addEventListener('mousedown', (e) => { if (e.target === $overlay) closeModal(); });

function promptDialog(title, value, okLabel, onOk) {
  const input = h(`<input class="field" value="${esc(value)}">`);
  const ok = () => { const v = input.value.trim(); if (v) { closeModal(); onOk(v); } };
  modal(title, input, [{ label: 'Отмена', action: closeModal }, { label: okLabel, cls: 'primary', action: ok }]);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  input.focus(); input.select();
}
function confirmDialog(title, text, okLabel, onOk) {
  modal(title, h(`<p>${esc(text)}</p>`), [{ label: 'Отмена', action: closeModal }, { label: okLabel, cls: 'primary', action: () => { closeModal(); onOk(); } }]);
}

function addProject() { promptDialog('Новый проект', '', 'Создать', (name) => run({ type: 'createProject', name }, 'создание проекта').catch(() => {})); }
function renameProject(p) {
  promptDialog('Переименовать проект', p.title, 'Сохранить', (name) => {
    if (name === p.title) return;
    const followPanel = state.panel?.file === p.file;
    run({ type: 'renameProject', file: p.file, name }, 'переименование проекта', () => {
      if (followPanel && state.panel) state.panel.file = `${name}.md`;
      if (state.openClosed.delete(p.file)) state.openClosed.add(`${name}.md`);
    }).catch(() => {});
  });
}

function showSettings() {
  const wrap = h(`<div>
    <label class="setting"><span>Напоминать о задаче в «Ожидании ответа», если ответа нет столько дней (когда срок «вернуться до» не указан)</span>
      <input class="field" type="number" min="1" max="365" step="1"></label>
  </div>`);
  const input = wrap.querySelector('input');
  input.value = state.board.settings?.overdueDays ?? 3;
  const save = () => {
    const d = Number(input.value);
    if (!Number.isInteger(d) || d < 1 || d > 365) return toast('Введите целое число от 1 до 365', true);
    closeModal();
    run({ type: 'setSettings', overdueDays: d }, 'изменение настроек').catch(() => {});
  };
  modal('Настройки', wrap, [{ label: 'Отмена', action: closeModal }, { label: 'Сохранить', cls: 'primary', action: save }]);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  input.focus(); input.select();
}

// Справочник (исполнители, тэги): добавить, переименовать, удалить
function showDirectory(cfg) {
  const wrap = h(`<div><ul class="people-list"></ul><div class="add-row"><input class="field" maxlength="${cfg.max}" placeholder="${esc(cfg.placeholder)}"><button class="btn primary">Добавить</button></div></div>`);
  const list = wrap.querySelector('ul');
  const draw = () => {
    list.innerHTML = '';
    const items = cfg.items();
    if (!items.length) list.append(h(`<li><span class="nm" style="color:var(--faint)">${esc(cfg.empty)}</span></li>`));
    for (const name of items) {
      const li = h(`<li>${cfg.badge(name)}<span class="nm">${cfg.nameHtml ? cfg.nameHtml(name) : esc(name)}</span><button class="icon-btn ren" title="Переименовать">✎</button><button class="icon-btn del" title="Удалить">×</button></li>`);
      cfg.onBadge?.(name, li, draw);
      li.querySelector('.ren').addEventListener('click', () => {
        const inp = h(`<input class="field" maxlength="${cfg.max}" value="${esc(name)}">`);
        li.querySelector('.nm').replaceWith(inp);
        inp.focus(); inp.select();
        let done = false;
        const save = async () => {
          if (done) return;
          done = true;
          const v = inp.value.trim();
          if (v && v !== name) await run({ type: cfg.ops.rename, from: name, to: v }, cfg.labels.rename).catch(() => {});
          draw();
        };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') draw(); });
        inp.addEventListener('blur', save);
      });
      li.querySelector('.del').addEventListener('click', async () => { await run({ type: cfg.ops.del, name }, cfg.labels.del).catch(() => {}); draw(); });
      list.append(li);
    }
  };
  const input = wrap.querySelector('input');
  if (cfg.extra) wrap.querySelector('.add-row').before(cfg.extra);
  const add = async () => {
    const v = input.value.trim(); if (!v) return; input.value = '';
    await run({ type: cfg.ops.add, name: v, ...(cfg.addPayload?.() || {}) }, cfg.labels.add).catch(() => {});
    cfg.afterAdd?.(); draw(); input.focus();
  };
  wrap.querySelector('.add-row button').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  draw();
  modal(cfg.title, wrap, [{ label: 'Готово', action: closeModal }]);
  input.focus();
}

// Исполнители со структурой: группы (Риски, Право…) и люди в них. Без группы — как раньше.
function groupMenu(anchor, current, onPick) {
  const groups = [...new Set((state.board.peopleGroups || []).map((p) => p.group).filter(Boolean))];
  showMenu(anchor, [
    ...groups.map((g) => ({ html: `<span class="grow">${esc(g)}</span>`, active: current === g, action: () => onPick(g) })),
    { html: '<span class="faint">Без группы</span>', active: !current, action: () => onPick('') },
    '-',
    { label: 'Новая группа…', action: (a) => {
      const el = h('<div class="popover-form"><span class="pop-label">Новая группа</span><input class="field" maxlength="60" placeholder="Например, Риски"></div>');
      const inp = el.querySelector('input');
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && inp.value.trim()) { closeMenu(); onPick(inp.value.trim()); }
        if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); }
      });
      showPopover(a, el); inp.focus();
    } },
  ]);
}

function showPeople() {
  let addGroup = '';
  const wrap = h(`<div class="people-dlg">
    <div class="pgroups"></div>
    <div class="add-row"><input class="field" maxlength="100" placeholder="Имя нового исполнителя"><button class="btn pick-group" title="Группа нового исполнителя"></button><button class="btn primary add">Добавить</button></div>
    <p class="dlg-hint">Группа меняется кнопкой справа от имени. Новая группа появляется вместе с первым человеком в ней, пустая исчезает сама.</p>
  </div>`);
  const input = wrap.querySelector('input');
  const pickBtn = wrap.querySelector('.pick-group');
  const drawPick = () => { pickBtn.innerHTML = `${esc(addGroup || 'Без группы')} <span class="chev">${ICON.chev}</span>`; };
  pickBtn.addEventListener('click', () => groupMenu(pickBtn, addGroup, (g) => { addGroup = g; drawPick(); input.focus(); }));
  drawPick();

  const inlineEdit = (el, value, onSave, redraw) => {
    const inp = h(`<input class="field" maxlength="100" value="${esc(value)}">`);
    el.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const save = async () => { if (done) return; done = true; const v = inp.value.trim(); if (v && v !== value) await onSave(v); redraw(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); done = true; redraw(); } });
    inp.addEventListener('blur', save);
  };

  const draw = () => {
    const box = wrap.querySelector('.pgroups');
    box.innerHTML = '';
    const all = state.board.peopleGroups || [];
    if (!all.length) { box.append(h('<p class="faint">Справочник пуст. Имена хранятся в файле _исполнители.md</p>')); return; }
    for (const g of [...new Set(all.map((p) => p.group))]) {
      const sec = h(`<div class="pgroup"><div class="pg-head"><span class="pg-name">${esc(g || 'Без группы')}</span>${g ? '<button class="icon-btn ren" title="Переименовать группу">✎</button>' : ''}<span class="menu-count">${all.filter((p) => p.group === g).length}</span></div><ul class="people-list"></ul></div>`);
      sec.querySelector('.ren')?.addEventListener('click', () => inlineEdit(sec.querySelector('.pg-name'), g, (v) => run({ type: 'groupRename', from: g, to: v }, 'переименование группы').catch(() => {}), draw));
      const ul = sec.querySelector('ul');
      for (const p of all.filter((x) => x.group === g)) {
        const li = h(`<li><span class="nm">${esc(p.name)}</span><button class="btn subtle grp" title="Перенести в другую группу">${esc(p.group || 'Без группы')} <span class="chev">${ICON.chev}</span></button><button class="icon-btn ren" title="Переименовать">✎</button><button class="icon-btn del" title="Удалить">×</button></li>`);
        li.querySelector('.grp').addEventListener('click', (e) => groupMenu(e.currentTarget, p.group, async (ng) => { await run({ type: 'personGroup', name: p.name, group: ng }, 'смена группы исполнителя').catch(() => {}); draw(); }));
        li.querySelector('.ren').addEventListener('click', () => inlineEdit(li.querySelector('.nm'), p.name, (v) => run({ type: 'personRename', from: p.name, to: v }, 'переименование исполнителя').catch(() => {}), draw));
        li.querySelector('.del').addEventListener('click', async () => { await run({ type: 'personDelete', name: p.name }, 'удаление исполнителя').catch(() => {}); draw(); });
        ul.append(li);
      }
      box.append(sec);
    }
  };
  const add = async () => {
    const v = input.value.trim(); if (!v) return; input.value = '';
    await run({ type: 'personAdd', name: v, group: addGroup }, 'добавление исполнителя').catch(() => {});
    draw(); input.focus();
  };
  wrap.querySelector('.add').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  draw();
  modal('Исполнители', wrap, [{ label: 'Готово', action: closeModal }]);
  input.focus();
}

function showTags() {
  // Для нового тэга предлагаем первый цвет, которого ещё нет у других тэгов
  const freeColor = () => TAG_COLOR_NAMES.find((c) => !(state.board.tags || []).some((t) => state.board.tagColors?.[t] === c)) || TAG_COLOR_NAMES[0];
  let color = freeColor();
  const extra = h('<div class="color-row"><span class="color-label">Новый тэг: выберите цвет, введите название и нажмите Enter</span></div>');
  const drawPicker = () => { extra.querySelector('.swatches')?.remove(); extra.append(swatches(color, (c) => { color = c; })); };
  drawPicker();
  showDirectory({
    extra,
    addPayload: () => ({ color }),
    afterAdd: () => { color = freeColor(); drawPicker(); },
    // Тэг показан той же плашкой, что на карточке; щелчок по ней открывает выбор цвета прямо в строке
    nameHtml: (name) => `<button class="tag tag-btn" style="${tagStyle(name)}" title="Сменить цвет">${esc(name)}</button>`,
    onBadge: (name, li, redraw) => {
      li.querySelector('.tag-btn').addEventListener('click', () => {
        if (li.nextElementSibling?.classList.contains('swatch-li')) { li.nextElementSibling.remove(); return; }
        const row = h('<li class="swatch-li"></li>');
        row.append(swatches(tagColor(name), async (c) => { await run({ type: 'tagColor', name, color: c }, 'смена цвета тэга').catch(() => {}); redraw(); }));
        li.after(row);
      });
    },
    title: 'Тэги', max: 40, placeholder: 'Новый тэг, например «домашние дела»',
    empty: 'Тэгов пока нет. Они хранятся в файле _тэги.md',
    items: () => state.board.tags || [],
    badge: () => '',
    ops: { add: 'tagAdd', rename: 'tagRename', del: 'tagDelete' },
    labels: { add: 'добавление тэга', rename: 'переименование тэга', del: 'удаление тэга' },
  });
}

// ---------- панель задачи ----------
function findTask(file, line) {
  const p = state.board?.projects.find((x) => x.file === file);
  return p && { p, t: p.tasks.find((t) => t.line === line) };
}

function openPanel(file, t) {
  state.panel = { file, line: t.line, lineNo: t.lineNo, stale: false };
  $panel.hidden = false;
  $panel.innerHTML = '';
  buildPanel();
  syncPanel(true);
  renderBoard();
}
function closePanel() {
  flushPanel();
  state.panel = null;
  $panel.hidden = true;
  $panel.innerHTML = '';
  if (state.mode === 'board') $app.querySelectorAll('.trow.selected').forEach((c) => c.classList.remove('selected'));
}

let descTimer = null;
function flushPanel() {
  if (descTimer) { clearTimeout(descTimer); descTimer = null; $panel.querySelector('.desc')?.dispatchEvent(new Event('change')); }
}

function buildPanel() {
  $panel.append(h(`<div class="panel-inner" style="display:contents">
    <div class="panel-top"><span class="crumb"></span><button class="icon-btn close" title="Закрыть (Esc)">✕</button></div>
    <div class="banner" hidden><span>Задача изменена в файле.</span><button class="btn refresh">Обновить</button></div>
    <div class="panel-body">
      <textarea class="title-input" rows="1" maxlength="${TITLE_MAX}" placeholder="Без названия"></textarea>
      <div class="errors" hidden></div>
      <div class="props">
        <div class="label" data-row="status">Статус</div><div class="val" data-row="status"><button class="pick status-pick" title="Сменить статус"><span class="dot status-dot"></span><span class="status-text"></span></button></div>
        <div class="label" data-row="focus">Фокус</div><div class="val" data-row="focus"><button class="pick focus-pick" title="В фокус на сегодня"></button></div>
        <div class="label" data-row="assignee">Исполнитель</div><div class="val" data-row="assignee"><button class="pick assignee-pick" title="Выбрать исполнителя"></button></div>
        <div class="label" data-row="tag">Тэг</div><div class="val" data-row="tag"><button class="pick tag-pick" title="Выбрать тэг"></button></div>
        <div class="label" data-row="created">Создана</div><div class="val" data-row="created"><input data-k="created" placeholder="дд.мм.гггг"><span class="raw" data-raw="created"></span></div>
        <div class="label" data-row="taken">Взята в работу</div><div class="val" data-row="taken"><input data-k="taken" placeholder="дд.мм.гггг"><span class="raw" data-raw="taken"></span></div>
        <div class="label" data-row="waiting">Ждём ответа с</div><div class="val" data-row="waiting"><input data-k="waiting" placeholder="дд.мм.гггг"><span class="raw" data-raw="waiting"></span></div>
        <div class="label" data-row="deadline">Вернуться до</div><div class="val" data-row="deadline"><input data-k="deadline" placeholder="дд.мм.гггг"><span class="raw" data-raw="deadline"></span></div>
        <div class="label" data-row="closed">Закрыта</div><div class="val" data-row="closed"><input data-k="closed" placeholder="дд.мм.гггг"><span class="raw" data-raw="closed"></span></div>
        <div class="label" data-row="cancelled">Отменена</div><div class="val" data-row="cancelled"><input data-k="cancelled" placeholder="дд.мм.гггг"><span class="raw" data-raw="cancelled"></span></div>
        <div class="label" data-row="result">Результат</div><div class="val" data-row="result"><input class="wide" data-f="result" maxlength="300" placeholder="Чем закончилось"></div>
      </div>
      <div class="section-label">Комментарий</div>
      <textarea class="desc" placeholder="Заметки по задаче: что сделано, какие решения приняты."></textarea>
    </div>
    <div class="panel-foot"><span class="file"></span><button class="btn danger del">Удалить</button></div>
  </div>`));
  const cur = () => findTask(state.panel.file, state.panel.line);
  const patch = (pt, label) => { const f = cur(); if (f?.t) updateTask(state.panel.file, f.t, pt, label); };

  $panel.querySelector('.close').addEventListener('click', closePanel);
  $panel.querySelector('.refresh').addEventListener('click', () => relocatePanel(false));

  const title = $panel.querySelector('.title-input');
  const autosize = () => { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
  title.addEventListener('input', autosize);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('change', () => { const f = cur(); const v = title.value.trim(); if (f?.t && v && v !== f.t.title) patch({ title: v }, 'переименование задачи'); });

  $panel.querySelector('.status-pick').addEventListener('click', (e) => { const f = cur(); if (f?.t) statusMenu(e.currentTarget, state.panel.file, f.t); });
  // Исполнитель и тэг выбираются из таких же меню, как в строке задачи
  $panel.querySelector('.assignee-pick').addEventListener('click', (e) => {
    const f = cur(); if (!f?.t) return;
    assigneeMenu(e.currentTarget, f.t.assignee, (v) => patch({ assignee: v }, 'смена исполнителя'));
  });
  $panel.querySelector('.tag-pick').addEventListener('click', (e) => {
    const f = cur(); if (!f?.t) return;
    tagMenu(e.currentTarget, f.t.tag, (v) => patch({ tag: v }, 'смена тэга'));
  });
  $panel.querySelector('.focus-pick').addEventListener('click', () => {
    const f = cur(); if (f?.t) patch({ focus: !f.t.focus }, f.t.focus ? 'снятие фокуса' : 'фокус');
  });
  $panel.querySelectorAll('input[data-k]').forEach((inp) => {
    maskDate(inp);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      const iso = v ? parseRuDate(v) : '';
      if (iso === null) { toast('Дата должна быть в формате ДД.ММ.ГГГГ', true); syncPanel(true); return; }
      patch({ [inp.dataset.k]: iso }, 'изменение даты');
    });
  });

  $panel.querySelectorAll('input[data-f]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    inp.addEventListener('change', () => {
      const f = cur(); const k = inp.dataset.f; const v = inp.value.trim();
      if (f?.t && v !== (f.t[k] || '')) patch({ [k]: v }, 'изменение результата');
    });
  });

  const desc = $panel.querySelector('.desc');
  desc.addEventListener('input', () => { clearTimeout(descTimer); descTimer = setTimeout(() => { descTimer = null; desc.dispatchEvent(new Event('change')); }, 800); });
  desc.addEventListener('change', () => { clearTimeout(descTimer); descTimer = null; const f = cur(); if (f?.t && desc.value !== f.t.description) patch({ description: desc.value }, 'изменение комментария'); });

  $panel.querySelector('.del').addEventListener('click', () => {
    const f = cur(); if (!f?.t) return;
    confirmDialog('Удалить задачу?', `«${f.t.title}» будет перенесена в архив/задачи/${state.panel.file}. Отменить можно через ⌘Z / Ctrl+Z.`, 'Удалить', () => {
      const ref = { line: state.panel.line, lineNo: state.panel.lineNo };
      const file = state.panel.file;
      closePanel();
      run({ type: 'delete', file, ref }, 'удаление задачи').catch(() => {});
    });
  });
}

// Обновляет содержимое панели из свежей доски, не трогая поле, в котором сейчас курсор.
function syncPanel(force = false) {
  if (!state.panel || $panel.hidden) return;
  const f = findTask(state.panel.file, state.panel.line);
  const banner = $panel.querySelector('.banner');
  if (!f?.t) {
    if (!state.pending) { state.panel.stale = true; banner.hidden = false; }
    return;
  }
  state.panel.stale = false;
  banner.hidden = true;
  state.panel.lineNo = f.t.lineNo;
  const { p, t } = f;
  const active = document.activeElement;
  $panel.querySelector('.crumb').textContent = p.title;
  $panel.querySelector('.file').textContent = p.file;
  const title = $panel.querySelector('.title-input');
  if (force || active !== title) { title.value = t.title; title._updateCounter?.(); title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; }
  $panel.querySelector('.status-dot').className = `dot status-dot ${t.status === 'error' ? 'error' : t.status}`;
  $panel.querySelector('.status-text').textContent = t.status === 'error' ? `[${t.char}] — выберите статус` : STATUS_LABEL[t.status];
  $panel.querySelector('.focus-pick').innerHTML = `<span class="star${t.focus ? ' on' : ''}">${ICON.star(t.focus)}</span><span class="${t.focus ? '' : 'faint'}">${t.focus ? 'В фокусе сегодня' : 'Не в фокусе'}</span>`;

  $panel.querySelector('.assignee-pick').innerHTML = t.assignee ? personHtml(t.assignee) : '<span class="faint">—</span>';
  $panel.querySelector('.tag-pick').innerHTML = t.tag ? tagChip(t.tag) : '<span class="faint">—</span>';

  // Поля показываем только там, где они имеют смысл (или уже заполнены)
  const show = {
    waiting: t.status === 'waiting' || !!t.waiting || !!t.deadline,
    deadline: t.status === 'waiting' || !!t.waiting || !!t.deadline,
    closed: t.status === 'closed' || !!t.closed,
    cancelled: t.status === 'cancelled' || !!t.cancelled,
    result: t.status === 'closed',
  };
  $panel.querySelectorAll('.props [data-row]').forEach((el) => { if (el.dataset.row in show) el.hidden = !show[el.dataset.row]; });

  for (const k of ['created', 'taken', 'waiting', 'deadline', 'closed', 'cancelled']) {
    const inp = $panel.querySelector(`input[data-k=${k}]`);
    const raw = $panel.querySelector(`[data-raw=${k}]`);
    const ok = validDate(t[k]);
    if (force || active !== inp) inp.value = ok ? ruDate(t[k]) : '';
    inp.classList.toggle('empty-date', !t[k]);
    raw.textContent = t[k] && !ok ? `в файле: «${t[k]}»` : '';
  }
  for (const k of ['result']) {
    const inp = $panel.querySelector(`input[data-f=${k}]`);
    if (force || active !== inp) inp.value = t[k] || '';
  }
  const desc = $panel.querySelector('.desc');
  if ((force || active !== desc) && !descTimer) desc.value = t.description;

  const errs = $panel.querySelector('.errors');
  errs.hidden = !t.errors.length;
  errs.innerHTML = t.errors.length ? `<b>Ошибка в строке задачи</b><ul>${t.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '';
}

// Ищет задачу после внешней правки: та же позиция или то же название.
function relocatePanel(quiet) {
  if (!state.panel) return;
  const p = state.board.projects.find((x) => x.file === state.panel.file);
  const title = $panel.querySelector('.title-input')?.value.trim();
  const t = p && (p.tasks.find((x) => x.line === state.panel.line) || p.tasks.find((x) => x.lineNo === state.panel.lineNo && x.title === title) || p.tasks.find((x) => x.title === title) || p.tasks.find((x) => x.lineNo === state.panel.lineNo));
  if (!t) { if (!quiet) toast('Задача больше не найдена в файле'); closePanel(); return; }
  state.panel.line = t.line; state.panel.lineNo = t.lineNo;
  syncPanel(true);
  renderBoard();
}

// ---------- клавиатура ----------
document.addEventListener('keydown', (e) => {
  const inField = e.target.closest?.('input, textarea, select');
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z' && !inField && state.mode === 'board') {
    e.preventDefault();
    history(e.shiftKey ? 'redo' : 'undo');
  } else if (mod && e.key.toLowerCase() === 'y' && !inField && state.mode === 'board') {
    e.preventDefault(); history('redo');
  } else if (e.key === 'Escape') {
    if (menuEl) closeMenu();
    else if (!$overlay.hidden) closeModal();
    else if (state.waitFilter && !state.panel && !inField) setWaitFilter(null);
    else if (state.panel && !inField) closePanel();
    else if (inField && state.panel) e.target.blur();
  }
});

window.addEventListener('beforeunload', flushPanel);

// В полночь счётчики «создано/закрыто сегодня» обнуляются: перечитываем доску, когда сменился день
setInterval(() => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (state.mode === 'board' && state.board && state.board.today !== today && !state.pending) loadBoard();
}, 60000);

start().catch((e) => { $app.innerHTML = `<div class="empty"><h2>Не удалось запустить</h2><p>${esc(e.message)}</p></div>`; });
