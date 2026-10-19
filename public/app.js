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
  ppanel: null,              // { file, id } — открытая карточка контрольной точки
  view: (() => { try { return localStorage.getItem('taskboard.view') === 'roadmap' ? 'roadmap' : 'tasks'; } catch { return 'tasks'; } })(),
  rmScale: (() => { try { return ['q', 'h', 'y'].includes(localStorage.getItem('taskboard.rmScale')) ? localStorage.getItem('taskboard.rmScale') : 'q'; } catch { return 'q'; } })(),
  rmZoom: (() => { try { const z = Number(localStorage.getItem('taskboard.rmZoom')); return z > 0 ? z : 1; } catch { return 1; } })(),
  rmNames: (() => { try { return localStorage.getItem('taskboard.rmNames') === '1'; } catch { return false; } })(),
  rmLink: null,              // выбранная связь «a>b»
  rmScroll: null,            // { left, top } — где была карта до перерисовки
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
// Тэг рисуется пастельной заливкой, как в Notion: фон и текст берутся из выбранного цвета тэга
function tagStyle(name) {
  const [bg, fg] = TAG_COLORS[tagColor(name)];
  return `background:${bg};color:${fg}`;
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
// Исполнитель: кружок с первой буквой имени и имя
const avatar = (name) => `<span class="av" aria-hidden="true">${esc([...name.trim()][0]?.toUpperCase() || '?')}</span>`;
const personHtml = (name) => `<span class="person">${avatar(name)}<span class="nm">${esc(name)}</span></span>`;
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
  es.addEventListener('change', () => { clearTimeout(t); t = setTimeout(() => { if (!state.pending && !state.rmDrag && state.mode === 'board') loadBoard(); }, 100); });
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

// Ширина колонок: название тянется на всю свободную ширину, остальные можно менять мышью.
// Ширины хранятся в браузере, одни на все доски.
const COLS = [
  { key: 'st', label: 'Статус', def: 112, min: 70 },
  { key: 'title', label: 'Задача' },
  { key: 'tag', label: 'Тэг', def: 132, min: 60 },
  { key: 'who', label: 'Исполнитель', def: 150, min: 70 },
  { key: 'due', label: 'Срок', def: 150, min: 60 },
];
const COLS_KEY = 'taskboard.cols';
function loadCols() {
  try { return JSON.parse(localStorage.getItem(COLS_KEY) || '{}') || {}; } catch { return {}; }
}
function saveCols(w) {
  try { Object.keys(w).length ? localStorage.setItem(COLS_KEY, JSON.stringify(w)) : localStorage.removeItem(COLS_KEY); } catch {}
}
function applyCols(list, w = loadCols()) {
  for (const c of COLS) if (c.def) list.style.setProperty(`--c-${c.key}`, `${w[c.key] || c.def}px`);
}

function renderColHead(list) {
  const head = h(`<div class="colhead"><span></span>${COLS.map((c) => `<span data-col="${c.key}"><span class="lbl">${c.label}</span>${c.def ? '<i class="grip" title="Потяните, чтобы изменить ширину. Двойной щелчок — по умолчанию"></i>' : ''}</span>`).join('')}<span></span></div>`);
  for (const grip of head.querySelectorAll('.grip')) {
    const col = COLS.find((c) => c.key === grip.parentElement.dataset.col);
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const w = loadCols();
      const startX = e.clientX, startW = grip.parentElement.getBoundingClientRect().width;
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('active');
      document.body.classList.add('col-resizing');
      const move = (ev) => {
        w[col.key] = Math.round(Math.max(col.min, Math.min(600, startW + ev.clientX - startX)));
        applyCols(list, w);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.classList.remove('active');
        document.body.classList.remove('col-resizing');
        if (w[col.key] === col.def) delete w[col.key];
        saveCols(w);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
      grip.addEventListener('pointercancel', up, { once: true });
    });
    grip.addEventListener('dblclick', () => { const w = loadCols(); delete w[col.key]; saveCols(w); applyCols(list, w); });
  }
  return head;
}

function renderBoard() {
  const b = state.board;
  if (!state.collapsed || state.collapsedFor !== b.folder) { loadCollapsed(); state.collapsedFor = b.folder; }
  const scroll = $app.querySelector('.board')?.scrollTop || 0;
  const rmEl = $app.querySelector('.rm');
  if (rmEl && !state.rmResetScroll) state.rmScroll = { left: rmEl.scrollLeft, top: rmEl.scrollTop };
  state.rmResetScroll = false;
  const c = b.counters || { total: 0, created: 0, closed: 0 };
  const ratio = c.created ? `${Math.round((c.closed / c.created) * 100)}%` : '—';
  const isMap = state.view === 'roadmap';

  $app.innerHTML = '';
  const top = h(`<header class="topbar">
    <button class="name" title="${esc(b.folder)}">${esc(b.name)} <span class="chev">${ICON.chev}</span></button>
    <div class="counters">
      <span class="ctr" title="Все незакрытые задачи на доске"><b>${c.total}</b> всего задач</span>
      <span class="ctr" title="Задачи, созданные сегодня"><b>${c.created}</b> создано сегодня</span>
      <span class="ctr" title="Задачи, закрытые сегодня"><b>${c.closed}</b> закрыто сегодня</span>
      <span class="ratio" title="Закрыто сегодня / создано сегодня${c.created ? '' : ' — сегодня ещё ничего не создано'}">${ratio}</span>
    </div>
    ${isMap ? `<span class="seg rm-scale">${Object.entries(RM_SCALES).map(([k, v]) => `<button data-s="${k}" class="${state.rmScale === k ? 'on' : ''}">${v.label}</button>`).join('')}</span>
      <span class="zoom"><button class="icon-btn" data-z="-1" title="Мельче: на экране больше дней">−</button><button class="icon-btn" data-z="1" title="Крупнее: на экране меньше дней">+</button></span>
      <button class="btn rm-today" title="Прокрутить к сегодняшнему дню">Сегодня</button>` : ''}
    <span class="spacer"></span>
    ${!isMap && state.waitFilter ? `<button class="filter-chip" title="Сбросить фильтр (Esc)">Ожидания: ${esc(state.waitFilter)} <span>✕</span></button>` : ''}
    ${isMap ? `<button class="icon-btn rm-plus" title="Новая контрольная точка">${ICON.plus}</button>` : ''}
    <button class="icon-btn burger" title="Меню" aria-label="Меню">${ICON.burger}</button>
  </header>`);
  top.querySelector('.name').addEventListener('click', (e) => showMenu(e.currentTarget, [
    { label: 'Сменить папку…', action: async () => showPicker((await api('/api/state')).recent, b.folder) },
  ]));
  top.querySelector('.filter-chip')?.addEventListener('click', () => setWaitFilter(null));
  top.querySelector('.burger').addEventListener('click', (e) => showMenu(e.currentTarget, [
    ...(isMap ? [] : [{ label: 'Фильтр ожиданий ›', action: (anchor) => waitFilterMenu(anchor) }]),
    { label: 'Новый проект', action: addProject },
    { label: 'Исполнители', action: showPeople },
    { label: 'Тэги', action: showTags },
    { label: 'Префиксы', action: showPrefixes },
    { label: 'Настройки', action: showSettings },
    ...(!isMap && Object.keys(loadCols()).length ? [{ label: 'Ширина колонок по умолчанию', action: () => { saveCols({}); renderBoard(); } }] : []),
    '-',
    ...(isMap ? [{ html: `<span class="menu-check${state.rmNames ? ' on' : ''}"></span><span class="grow">Отображать имена</span>`, action: () => {
      state.rmNames = !state.rmNames;
      try { localStorage.setItem('taskboard.rmNames', state.rmNames ? '1' : '0'); } catch {}
      renderBoard();
    } }] : []),
    { html: `<span class="menu-two"><span>Скачать PDF</span><small>${isMap ? 'дорожная карта: даты, которые видны на экране' : 'есть на вкладке RoadMap'}</small></span>`, action: () => (isMap ? exportPdf() : toast('PDF скачивается с вкладки RoadMap: откройте её внизу')) },
    '-',
    { html: `<span class="menu-version">Версия ${esc((b.version || '').replace(/\.0$/, ''))}</span>`, disabled: true, action: () => {} },
  ]));
  if (isMap) {
    top.querySelector('.rm-scale').addEventListener('click', (e) => {
      const s = e.target.closest('[data-s]')?.dataset.s;
      if (!s || s === state.rmScale) return;
      state.rmScale = s; state.rmZoom = 1; state.rmScroll = null; state.rmResetScroll = true;
      try { localStorage.setItem('taskboard.rmScale', s); localStorage.setItem('taskboard.rmZoom', '1'); } catch {}
      renderBoard();
    });
    // «+» и «−» меняют ширину дня; день в середине экрана остаётся на месте
    top.querySelector('.zoom').addEventListener('click', (e) => {
      const z = Number(e.target.closest('[data-z]')?.dataset.z);
      const el = $app.querySelector('.rm'), L = state.rmGeo;
      if (!z || !el || !L) return;
      const base = L.dw / state.rmZoom;
      const next = Math.min(80 / base, Math.max(1.5 / base, state.rmZoom * (z > 0 ? 1.25 : 0.8)));
      if (Math.abs(next - state.rmZoom) < 1e-6) return toast(z > 0 ? 'Это самый крупный масштаб' : 'Это самый мелкий масштаб');
      state.rmCenter = (el.scrollLeft + (el.clientWidth - RM.LEFT) / 2) / L.dw;
      state.rmZoom = next;
      try { localStorage.setItem('taskboard.rmZoom', String(next)); } catch {}
      renderBoard();
    });
    top.querySelector('.rm-today').addEventListener('click', () => rmScrollToDay(b.today, true));
    top.querySelector('.rm-plus').addEventListener('click', () => newPointDialog(null, b.today));
  }
  $app.append(top);

  if (isMap) {
    $app.append(renderRoadmap());
  } else {
    const board = h('<main class="board"><div class="list"></div></main>');
    const list = board.querySelector('.list');
    if (!b.projects.length) {
      list.append(h(`<div class="empty"><h2>Проектов пока нет</h2><p>Каждый проект — это .md-файл в папке.</p><button class="btn primary">Создать проект</button></div>`));
      list.querySelector('button').addEventListener('click', addProject);
    } else {
      applyCols(list);
      list.append(renderColHead(list));
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

    const input = board.querySelector(state.adding?.focusDue ? '.add-due' : '.add-input');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); input.scrollIntoView({ block: 'nearest' }); }
    if (state.editTitle) {
      const row = [...board.querySelectorAll('.trow')].find((r) => r._ref.file === state.editTitle.file && r._ref.line === state.editTitle.line && r.dataset.group !== 'focus');
      state.editTitle = null;
      if (row) startTitleEdit(row);
    }
  }

  // Вкладки внизу, как листы в Excel
  const tabs = h(`<nav class="tabs"><button data-v="tasks" class="${isMap ? '' : 'on'}">Tasks</button><button data-v="roadmap" class="${isMap ? 'on' : ''}">RoadMap</button></nav>`);
  tabs.addEventListener('click', (e) => { const v = e.target.closest('[data-v]')?.dataset.v; if (v) setView(v); });
  $app.append(tabs);
  if (isMap) rmAfterMount();
}

function setView(v) {
  if (state.view === v) return;
  closePanel();
  state.view = v; state.adding = null; state.rmLink = null;
  try { localStorage.setItem('taskboard.view', v); } catch {}
  renderBoard();
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
      // Enter в названии переводит к сроку, Enter в сроке создаёт задачу. Срок можно оставить пустым.
      const wrap = h(`<div class="add-row-wrap"><input class="add-input" maxlength="${TITLE_MAX}" placeholder="Название задачи… Enter — к сроку, Esc — закрыть"><input class="add-due" placeholder="срок дд.мм.гггг" title="Срок задачи, необязательно. Enter — добавить"></div>`);
      const inp = wrap.querySelector('.add-input');
      const dueInp = wrap.querySelector('.add-due');
      maskDate(dueInp);
      inp.value = state.adding.value;
      dueInp.value = state.adding.due || '';
      inp.addEventListener('input', () => { state.adding.value = inp.value; });
      dueInp.addEventListener('input', () => { state.adding.due = dueInp.value; });
      const create = () => {
        const title = inp.value.trim();
        if (!title) { inp.focus(); return; }
        const v = dueInp.value.trim();
        const due = v ? parseRuDate(v) : '';
        if (due === null) return toast('Дата должна быть в формате ДД.ММ.ГГГГ', true);
        // Поле очищаем только после успешного создания — при ошибке текст остаётся
        run({ type: 'create', file: p.file, title, due }, 'создание задачи', () => { if (state.adding?.file === p.file) Object.assign(state.adding, { value: '', due: '', focusDue: false }); }).catch(() => {});
      };
      const esc2 = (e) => { e.stopPropagation(); state.adding = null; renderBoard(); };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (inp.value.trim()) { state.adding.focusDue = true; dueInp.focus(); } }
        else if (e.key === 'Escape') esc2(e);
      });
      dueInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); create(); }
        else if (e.key === 'Escape') esc2(e);
      });
      inp.addEventListener('focus', () => { state.adding.focusDue = false; });
      const blur = () => setTimeout(() => {
        const a = document.activeElement;
        if (inp.isConnected && state.adding?.file === p.file && !state.adding.value.trim() && a !== inp && a !== dueInp && !state.pending) { state.adding = null; renderBoard(); }
      }, 150);
      inp.addEventListener('blur', blur);
      dueInp.addEventListener('blur', blur);
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

// Срок задачи: «30 окт»; у «Ожидания» ещё и когда вернуться: «ответ 24 окт; 13 ноя».
// Без срока — серое «нет срока». Красным — просроченное.
const dayMon = (iso) => { const [y, m, d] = iso.split('-'); return `${+d} ${MONTHS[+m - 1]}${y !== state.board.today.slice(0, 4) ? ' ' + y : ''}`; };
function dueCell(t) {
  const today = state.board.today;
  const pt = t.point ? pointById(t.point) : null;
  const dueTxt = validDate(t.due) ? `${pt?.ind ? '≈ ' : ''}${dayMon(t.due)}` : '';
  const dueOver = validDate(t.due) && !isDone(t) && t.due < today;
  const tip = [];
  if (validDate(t.due)) tip.push(`Срок ${ruDate(t.due)}${pt?.ind ? ' (индикативный)' : ''}`);
  if (t.status === 'waiting') {
    let ans = '', over = false;
    if (validDate(t.deadline)) { ans = `ответ ${dayMon(t.deadline)}`; over = t.overdue; tip.unshift(`Вернуться до ${ruDate(t.deadline)}`); }
    else if (t.overdue && validDate(t.waiting)) { ans = `ждём ${daysBetween(t.waiting, today)} дн.`; over = true; tip.unshift(`Ждём ответа с ${ruDate(t.waiting)}`); }
    const txt = [ans, dueTxt].filter(Boolean).join('; ');
    if (txt) return `<button class="ed due${over || dueOver ? ' over' : ''}" data-f="due" title="${esc(tip.join('. '))}">${esc(txt)}</button>`;
  } else if (dueTxt) return `<button class="ed due${dueOver ? ' over' : ''}" data-f="due" title="${esc(tip.join('. '))}">${esc(dueTxt)}</button>`;
  if (isDone(t)) return '';
  return '<button class="ed due none" data-f="due" title="Поставить срок">нет срока</button>';
}

function renderRow(p, t, group) {
  const st = shownStatus(t);
  const sel = state.panel && state.panel.file === p.file && state.panel.line === t.line;
  const cls = ['trow', isDone(t) && !t.errors.length ? 'done' : '', t.status === 'cancelled' ? 'cancelled' : '', sel ? 'selected' : ''].filter(Boolean).join(' ');
  const row = h(`<div class="${cls}" data-group="${esc(group)}">
    <button class="star${t.focus ? ' on' : ''}" title="${t.focus ? 'Убрать из фокуса' : 'В фокус на сегодня'}">${ICON.star(t.focus)}</button>
    <button class="ed st" data-f="status" title="Сменить статус"><span class="dot ${STATUS_DOT[st]}"></span><span class="st-label">${STATUS_LABEL[st]}</span></button>
    <span class="cell-title">${t.point ? '<button class="pt-mark" data-f="point" title="Есть контрольная точка на RoadMap. Показать">◆</button>' : ''}<button class="ed title" data-f="title" title="${esc(t.title)}">${esc(t.title || 'Без названия')}</button></span>
    <span class="cell-tag">${t.tag ? `<button class="ed tagpill" data-f="tag" style="${tagStyle(t.tag)}" title="${esc(t.tag)}">${esc(t.tag)}</button>` : '<button class="ed blank" data-f="tag">+ тэг</button>'}</span>
    <span class="cell-who"><button class="ed who${t.assignee ? '' : ' blank'}" data-f="assignee" title="${esc(t.assignee || 'Выбрать исполнителя')}">${t.assignee ? `${avatar(t.assignee)}<span class="nm">${esc(t.assignee)}</span>` : '+ исполнитель'}</button></span>
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
    if (f === 'point') return showPointOnMap(t.point);
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
  const person = (p) => ({ html: `${avatar(p.name)}<span class="grow">${esc(p.name)}</span>`, active: current === p.name, action: () => onPick(p.name) });
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

// Срок в строке: «Срок» и, у «Ожидания», «Вернуться до». Enter сохраняет.
function duePopover(anchor, file, t) {
  const waiting = t.status === 'waiting' || !!t.deadline;
  const el = h(`<div class="popover-form">
    <span class="pop-label">Срок</span>
    <input class="field due-in" placeholder="дд.мм.гггг">
    ${waiting ? '<span class="pop-label">Вернуться до (ждём ответа)</span><input class="field dl-in" placeholder="дд.мм.гггг">' : ''}
    <div class="pop-actions"><button class="btn primary save">Сохранить</button></div>
  </div>`);
  const dueIn = el.querySelector('.due-in'), dlIn = el.querySelector('.dl-in');
  for (const [inp, v] of [[dueIn, t.due], [dlIn, t.deadline]]) { if (!inp) continue; maskDate(inp); inp.value = validDate(v) ? ruDate(v) : ''; }
  const save = () => {
    const patch = {};
    for (const [inp, k] of [[dueIn, 'due'], [dlIn, 'deadline']]) {
      if (!inp) continue;
      const v = inp.value.trim();
      const iso = v ? parseRuDate(v) : '';
      if (iso === null) return toast('Дата должна быть в формате ДД.ММ.ГГГГ', true);
      if (iso !== (t[k] || '')) patch[k] = iso;
    }
    closeMenu();
    if (Object.keys(patch).length) setTaskDates(file, t, patch);
  };
  el.querySelectorAll('input').forEach((inp) => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }));
  el.querySelector('.save').addEventListener('click', save);
  showPopover(anchor, el);
  dueIn.focus(); dueIn.select();
}

// Смена срока задачи. Если у задачи есть контрольная точка с реальным сроком, это её сдвиг: сначала спрашиваем здоровье.
function setTaskDates(file, t, patch, label = 'изменение срока') {
  const pt = t.point ? pointById(t.point) : null;
  if ('due' in patch && pt) {
    if (!patch.due) return toast('У задачи есть контрольная точка на RoadMap: срок обязателен', true);
    if (!pt.ind && !pt.closed && patch.due !== pt.plan) {
      return healthDialog(pt, pt.plan, patch.due, (health) => updateTask(file, t, patch, label, { health }));
    }
  }
  updateTask(file, t, patch, label);
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

function updateTask(file, t, patch, label = 'изменение задачи', extra = {}) {
  const ref = state.panel && state.panel.file === file && state.panel.line === t.line ? state.panel : { file, line: t.line, lineNo: t.lineNo };
  const isPanel = ref === state.panel;
  return run({ type: 'update', file, ref: { line: ref.line, lineNo: ref.lineNo }, patch, ...extra }, label, (r) => {
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
  $overlay._cancel = null;
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
function closeModal() {
  $overlay.hidden = true; $overlay.innerHTML = '';
  const c = $overlay._cancel; $overlay._cancel = null; c?.();
}
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
  state.ppanel = null;
  state.panel = { file, line: t.line, lineNo: t.lineNo, stale: false };
  $panel.hidden = false;
  $panel.innerHTML = '';
  buildPanel();
  syncPanel(true);
  renderBoard();
}
function closePanel() {
  flushPanel();
  const hadPoint = !!state.ppanel;
  state.ppanel = null;
  if (hadPoint && state.mode === 'board') $app.querySelectorAll('.dia.sel').forEach((d) => d.classList.remove('sel'));
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
        <div class="label" data-row="due">Срок</div><div class="val" data-row="due"><input data-k="due" placeholder="дд.мм.гггг"><span class="raw" data-raw="due"></span></div>
        <div class="label" data-row="rm">RoadMap</div><div class="val" data-row="rm"><button class="pick rm-pick"></button></div>
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
  // Контрольная точка из задачи: только при сроке и исполнителе, дальше они синхронизированы
  $panel.querySelector('.rm-pick').addEventListener('click', () => {
    const f = cur(); if (!f?.t) return;
    if (f.t.point) return showPointOnMap(f.t.point);
    if (!validDate(f.t.due)) return toast('Сначала поставьте задаче срок', true);
    if (!f.t.assignee) return toast('Сначала выберите исполнителя', true);
    const file = state.panel.file;
    run({ type: 'pointFromTask', file, ref: { line: state.panel.line, lineNo: state.panel.lineNo } }, 'контрольная точка из задачи', (r) => {
      if (r.task && state.panel) { state.panel.line = r.task.line; state.panel.lineNo = r.task.lineNo; }
      toast('Точка добавлена на RoadMap. Срок, название и владелец синхронизированы с задачей');
    }).catch(() => {});
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
      if (inp.dataset.k === 'due') {
        const f = cur(); if (!f?.t || iso === (f.t.due || '')) return;
        if (f.t.point && !iso) { toast('У задачи есть контрольная точка на RoadMap: срок обязателен', true); syncPanel(true); return; }
        return setTaskDates(state.panel.file, f.t, { due: iso });
      }
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
  if (state.ppanel && !$panel.hidden) return syncPointPanel();
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

  const rmPick = $panel.querySelector('.rm-pick');
  const canPoint = validDate(t.due) && !!t.assignee;
  rmPick.innerHTML = t.point ? '<span class="pt-mark">◆</span>Показать на RoadMap'
    : `<span class="pt-mark${canPoint ? '' : ' off'}">◆</span><span class="${canPoint ? '' : 'faint'}">Добавить на RoadMap</span>${canPoint ? '' : `<span class="faint small">${validDate(t.due) ? 'нужен исполнитель' : 'нужен срок'}</span>`}`;
  rmPick.title = t.point ? 'Открыть контрольную точку на дорожной карте' : canPoint ? 'Срок, название и владелец будут синхронизированы с задачей' : 'Контрольную точку можно сделать из задачи со сроком и исполнителем';
  for (const k of ['due', 'created', 'taken', 'waiting', 'deadline', 'closed', 'cancelled']) {
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

// ---------- дорожная карта ----------
// Дорожки — проекты с разделом «## RoadMap», точки — строки этого раздела. Всё рисуется заново из доски.
const RM = { LEFT: 210, LANE_H: 38, ROW: 40, HEAD: 70 };
const RM_SCALES = { q: { months: 3, min: 12, label: 'Квартал' }, h: { months: 6, min: 7, label: 'Полгода' }, y: { months: 12, min: 3, label: 'Год' } };
const HEALTH = {
  g: { label: 'По плану', c: '#4dab9a', bg: '#dbeee8' },
  y: { label: 'Есть риски', c: '#e5a24e', bg: '#fbecd6' },
  r: { label: 'Есть проблема', c: '#e16f64', bg: '#fbe1de' },
};
const RM_C = { closed: '#c9c7c2', closedBar: '#ecebe8', link: '#b9b6af', bad: '#f0b27a', rel: '#eaf2fb', relInk: '#2f6faa', weekend: '#faf9f7', line: '#ebeae7', line2: '#f3f2ef', accent: '#2383e2', ink: '#37352f', muted: '#787774', faint: '#a5a29c', weFaint: '#cbc8c2' };
const MON_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const signedDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / dayMs);
const isoWeek = (ms) => { const d = new Date(ms); const dn = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - dn); const y0 = Date.UTC(d.getUTCFullYear(), 0, 1); return Math.ceil(((d - y0) / dayMs + 1) / 7); };
const shownDate = (p) => (validDate(p.closed) ? p.closed : p.plan);
const shiftOf = (p) => (p.ind || !validDate(p.orig) ? 0 : signedDays(p.orig, shownDate(p)));
const fmtShift = (n) => `${n > 0 ? '+' : '−'}${Math.abs(n)} дн.`;

function allPoints() {
  const out = [];
  for (const p of state.board?.projects || []) for (const x of p.points || []) out.push({ ...x, file: p.file, project: p.title });
  return out;
}
const pointById = (id) => allPoints().find((x) => x.id === id) || null;
const prefixOf = (code) => (state.board.prefixes || []).find((x) => x.code === code) || null;
function prefixColors(code) {
  const p = prefixOf(code);
  if (TAG_COLORS[p?.color]) return TAG_COLORS[p.color];
  let n = 0;
  for (const ch of code) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_COLORS[TAG_COLOR_NAMES[n % TAG_COLOR_NAMES.length]];
}
const preStyle = (code) => { const [bg, fg] = prefixColors(code); return `background:${bg};color:${fg}`; };
const preChip = (code) => (code ? `<span class="pre" style="${preStyle(code)}" title="${esc(prefixOf(code)?.name || code)}">${esc(code)}</span>` : '');
const findTaskById = (id) => {
  for (const p of state.board.projects) { const t = p.tasks.find((x) => x.id === id); if (t) return { p, t }; }
  return null;
};

// Период карты: с первого дня текущего квартала до конца следующего года; раздвигается под точки
function rmPeriod() {
  const today = state.board.today;
  const y = +today.slice(0, 4), q = Math.floor((+today.slice(5, 7) - 1) / 3) * 3;
  const quarter = Date.UTC(y, q, 1);
  let start = quarter, end = Date.UTC(y + 2, 0, 1);
  for (const p of allPoints()) for (const d of [p.start, p.orig, p.plan, p.closed]) {
    if (!validDate(d)) continue;
    const dd = new Date(toUTC(d));
    if (dd < start) start = Date.UTC(dd.getUTCFullYear(), Math.floor(dd.getUTCMonth() / 3) * 3, 1);
    if (dd >= end) end = Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth() + 2, 1);
  }
  start = Math.max(start, Date.UTC(y - 1, q, 1));
  return { start, end, quarter };
}

// Разметка: ширина дня по масштабу (период масштаба целиком помещается в окно), дорожки и строки точек
function rmLayout(viewW, scale = state.rmScale) {
  const sc = RM_SCALES[scale];
  const { start, end, quarter } = rmPeriod();
  const n = Math.round((end - start) / dayMs);
  const qd = new Date(quarter);
  const visible = Math.round((Date.UTC(qd.getUTCFullYear(), qd.getUTCMonth() + sc.months, 1) - quarter) / dayMs);
  const dw = Math.min(80, Math.max(1.5, Math.max(sc.min, (viewW - RM.LEFT - 12) / visible) * (state.rmZoom || 1)));
  const X = (iso) => ((toUTC(iso) - start) / dayMs) * dw + dw / 2;
  const all = allPoints().filter((x) => validDate(shownDate(x)));
  const lanes = [];
  let y = 0;
  for (const p of state.board.projects) {
    if (!p.roadmap) continue;
    const pts = all.filter((x) => x.file === p.file).sort((a, b) => toUTC(shownDate(a)) - toUTC(shownDate(b)) || a.id.localeCompare(b.id));
    const coll = state.collapsed.has('rm:' + p.file);
    const hh = coll ? RM.LANE_H : RM.LANE_H + Math.max(1, pts.length) * RM.ROW + 8;
    pts.forEach((x, i) => { x.y = y + (coll ? RM.LANE_H / 2 : RM.LANE_H + i * RM.ROW + RM.ROW / 2); x.coll = coll; });
    lanes.push({ p, y, h: hh, pts, coll });
    y += hh;
  }
  const byId = new Map();
  for (const l of lanes) for (const x of l.pts) byId.set(x.id, x);
  return { start, end, quarter, n, dw, X, W: n * dw, lanes, byId, height: y };
}

// Полосы работ, связи и стрелки сдвига — общий слой для экрана и PDF
function rmOverlay(L, forPdf = false) {
  let svg = '';
  for (const p of L.byId.values()) {
    const sd = shownDate(p);
    if (p.coll || !validDate(p.start) || p.start >= sd) continue;
    const xs = L.X(p.start) - L.dw / 2, x = L.X(sd);
    svg += `<rect x="${xs}" y="${p.y - 6}" width="${Math.max(0, x - xs)}" height="12" rx="6" fill="${p.closed ? RM_C.closedBar : HEALTH[p.health].bg}"/>`;
  }
  for (const b of L.byId.values()) for (const aId of b.after || []) {
    const a = L.byId.get(aId);
    if (!a) continue;
    const x1 = L.X(shownDate(a)), y1 = a.y, x2 = L.X(shownDate(b)), y2 = b.y;
    const bad = toUTC(shownDate(b)) < toUTC(shownDate(a));
    const mx = (x1 + x2) / 2, k = Math.abs(x2 - x1) * 0.15 + 20;
    const d = `M${x1 + 9},${y1} C${mx + k},${y1} ${mx - k},${y2} ${x2 - 9},${y2}`;
    const key = `${aId}>${b.id}`;
    const sel = !forPdf && state.rmLink === key;
    svg += `<path d="${d}" fill="none" stroke="${sel ? RM_C.accent : bad ? RM_C.bad : RM_C.link}" stroke-width="${sel ? 2.2 : 1.6}" stroke-dasharray="5 4"/>`;
    if (!forPdf) svg += `<path class="hit" data-link="${esc(key)}" d="${d}" fill="none" stroke="transparent" stroke-width="12"/>`;
  }
  // Стрелка сдвига лежит прямо на полосе работ: от первоначального срока к ромбу, дни над ней
  for (const p of L.byId.values()) {
    const sh = shiftOf(p);
    if (p.coll || !sh) continue;
    const x0 = L.X(p.orig), x1 = L.X(shownDate(p)), yy = p.y, dir = Math.sign(x1 - x0), col = sh > 0 ? HEALTH.r.c : HEALTH.g.c;
    const xe = x1 - dir * 11;
    svg += `<line x1="${x0}" y1="${yy - 8}" x2="${x0}" y2="${yy + 8}" stroke="${col}" stroke-width="1.5"/>`;
    svg += `<line x1="${x0}" y1="${yy}" x2="${xe}" y2="${yy}" stroke="${col}" stroke-width="1.6"/>`;
    svg += `<path d="M${xe},${yy} l${-dir * 6},-4 v8 z" fill="${col}"/>`;
    svg += `<text x="${(x0 + xe) / 2}" y="${yy - 7}" text-anchor="middle" font-size="11" font-weight="600" fill="${col}">${fmtShift(sh)}</text>`;
  }
  return svg;
}

function renderRoadmap() {
  const b = state.board;
  const L = rmLayout(document.documentElement.clientWidth);
  state.rmGeo = L;
  const rel = Object.fromEntries((b.releases || []).map((r) => [r.date, r.name]));
  let head = '', bg = '';
  for (let i = 0; i < L.n; i++) {
    const ms = L.start + i * dayMs, d = new Date(ms), iso = isoOf(ms), x = i * L.dw;
    const dow = d.getUTCDay(), we = dow === 0 || dow === 6;
    if (d.getUTCDate() === 1 || i === 0) {
      const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() - d.getUTCDate() + 1;
      head += `<div class="cell m" style="left:${x}px;width:${dim * L.dw}px">${MON_FULL[d.getUTCMonth()]}${d.getUTCMonth() === 0 || i === 0 ? ' ' + d.getUTCFullYear() : ''}</div>`;
      bg += `<div class="bg mo" style="left:${x}px"></div>`;
    }
    if (dow === 1) {
      const wn = isoWeek(ms), ww = 7 * L.dw;
      head += `<div class="cell w" style="left:${x}px;width:${ww}px" title="Неделя ${wn}">${ww >= 34 ? 'Н' + wn : ww >= 16 ? wn : ''}</div>`;
      if (d.getUTCDate() !== 1) bg += `<div class="bg wk" style="left:${x}px"></div>`;
    }
    if (we && L.dw >= 6) bg += `<div class="bg we" style="left:${x}px;width:${L.dw}px"></div>`;
    if (rel[iso]) {
      bg += `<div class="bg rel" style="left:${x}px;width:${Math.max(L.dw, 4)}px"></div>`;
      head += `<div class="rel" data-day="${iso}" style="left:${x + L.dw / 2}px" title="Плановый релиз ${esc(rel[iso])}, ${ruDate(iso)}. Щелчок: изменить или снять">${esc(rel[iso])}</div>`;
    }
    head += `<div class="cell d${we ? ' we' : ''}${iso === b.today ? ' today' : ''}" data-day="${iso}" style="left:${x}px;width:${L.dw}px${L.dw < 18 ? ';font-size:9.5px;letter-spacing:-.3px' : ''}" title="${ruDate(iso)}. Щелчок отмечает плановый релиз">${L.dw >= 12 ? d.getUTCDate() : ''}</div>`;
  }
  const tms = toUTC(b.today);
  if (tms >= L.start && tms < L.end) bg += `<div class="bg today" style="left:${L.X(b.today) - 1}px"></div>`;

  let pts = '';
  for (const p of L.byId.values()) {
    const x = L.X(shownDate(p)), col = p.closed ? RM_C.closed : HEALTH[p.health].c;
    const sel = state.ppanel?.id === p.id;
    pts += `<div class="prow" style="top:${p.y - RM.ROW / 2}px;height:${RM.ROW}px">`;
    pts += `<div class="dia${p.ind ? ' ind' : ''}${sel ? ' sel' : ''}${p.closed ? ' closed' : ''}" data-pt="${p.id}" style="left:${x}px;top:${RM.ROW / 2}px;${p.ind ? '' : `background:${col}`}" title="${esc(p.title)}${p.closed ? '' : '. Потяните, чтобы сдвинуть срок'}"></div>`;
    if (!p.closed) pts += `<div class="knob" data-knob="${p.id}" style="left:${x + 16}px;top:${RM.ROW / 2}px" title="Потяните к другой точке, чтобы связать"></div>`;
    if (!p.coll) {
      const ox = shiftOf(p) ? L.X(p.orig) : x;
      const lx = Math.max(x, ox) + 24;
      pts += `<div class="ptl${p.closed ? ' closed' : ''}${p.errors?.length ? ' err' : ''}" data-ptl="${p.id}" style="left:${lx}px;top:${RM.ROW / 2}px"${p.errors?.length ? ` title="${esc(p.errors.join('. '))}"` : ''}>${preChip(p.pre)}<span class="t">${esc(p.title)}</span>${p.ind ? '<span class="ind" title="Индикативный срок">≈</span>' : ''}<span class="who">${avatar(p.owner || '?')}${esc(p.owner)}</span></div>`;
    }
    pts += '</div>';
  }

  let lanesL = '', seps = '';
  for (const l of L.lanes) {
    const can = l.pts.every((x) => x.closed);
    lanesL += `<div class="lane-l${l.coll ? ' coll' : ''}" data-lane="${esc(l.p.file)}" style="height:${l.h}px"><span class="chev">${ICON.chev}</span><span class="ln" title="${esc(l.p.title)}">${esc(l.p.title)}</span><span class="n">${l.pts.length}</span><button class="x${can ? '' : ' off'}" data-rmlane="${esc(l.p.file)}" title="${can ? 'Убрать проект с дорожной карты. Закрытые точки уйдут в архив' : 'Убрать можно, когда все точки закрыты'}">Убрать</button></div>`;
    seps += `<div class="lane-sep" style="top:${l.y + l.h - 1}px"></div>`;
    if (!l.pts.length && !l.coll) seps += `<div class="lane-hint" style="top:${l.y + RM.LANE_H + 8}px;left:${Math.max(12, L.X(b.today) + 14)}px">Двойной щелчок по дню создаёт точку</div>`;
  }
  const free = b.projects.filter((p) => !p.roadmap);
  lanesL += `<button class="add-lane"${free.length || !b.projects.length ? '' : ' hidden'}>${ICON.plus} Проект</button>`;
  if (!L.lanes.length) seps += `<div class="lane-hint big" style="top:16px;left:${Math.max(12, L.X(b.today) + 14)}px">${b.projects.length ? 'Добавьте проект на карту кнопкой «+ Проект» слева или создайте точку кнопкой (+) вверху' : 'Сначала создайте проект на вкладке Tasks'}</div>`;
  const BH = Math.max(L.height + 36, document.documentElement.clientHeight - 54 - 36 - RM.HEAD - 2);

  const wrap = h(`<main class="rm${state.rmNames ? ' names' : ''}"><div class="rm-inner" style="width:${RM.LEFT + L.W}px">
    <div class="rm-head"><div class="corner" style="width:${RM.LEFT}px;height:${RM.HEAD}px">Проекты</div><div class="hc" style="width:${L.W}px;height:${RM.HEAD}px">${head}</div></div>
    <div class="rm-body"><div class="labels" style="width:${RM.LEFT}px;min-height:${BH}px">${lanesL}</div>
      <div class="canvas" style="width:${L.W}px;height:${BH}px">${bg}${seps}<svg class="ov" width="${L.W}" height="${BH}">${rmOverlay(L)}</svg>${pts}</div></div>
  </div></main>`);
  setupRoadmapEvents(wrap, L);
  return wrap;
}

function rmAfterMount() {
  const el = $app.querySelector('.rm'), L = state.rmGeo;
  if (!el || !L) return;
  if (state.rmFocus) {
    const p = L.byId.get(state.rmFocus);
    state.rmFocus = null;
    if (p) {
      el.scrollLeft = Math.max(0, L.X(shownDate(p)) - (el.clientWidth - RM.LEFT) / 2);
      el.scrollTop = Math.max(0, p.y - el.clientHeight / 2 + RM.HEAD);
      return;
    }
  }
  if (state.rmScroll) { el.scrollLeft = state.rmScroll.left; el.scrollTop = state.rmScroll.top; }
  if (state.rmCenter != null) { el.scrollLeft = Math.max(0, state.rmCenter * L.dw - (el.clientWidth - RM.LEFT) / 2); state.rmCenter = null; }
  else if (!state.rmScroll) el.scrollLeft = Math.max(0, L.X(isoOf(L.quarter)) - L.dw / 2);
}
function rmScrollToDay(iso, smooth) {
  const el = $app.querySelector('.rm'), L = state.rmGeo;
  if (el && L) el.scrollTo({ left: Math.max(0, L.X(iso) - 160), behavior: smooth ? 'smooth' : 'auto' });
}

function setupRoadmapEvents(wrap, L) {
  const canvas = wrap.querySelector('.canvas');
  const dayAt = (clientX) => { const r = canvas.getBoundingClientRect(); const i = Math.max(0, Math.min(L.n - 1, Math.floor((clientX - r.left) / L.dw))); return isoOf(L.start + i * dayMs); };
  const laneAt = (clientY) => { const y = clientY - canvas.getBoundingClientRect().top; return L.lanes.find((l) => y >= l.y && y < l.y + l.h) || null; };

  wrap.addEventListener('click', (e) => {
    if (state.rmJustDragged) { state.rmJustDragged = false; return; }
    const day = e.target.closest('.hc [data-day]');
    if (day) return releaseDialog(day.dataset.day);
    const rmBtn = e.target.closest('[data-rmlane]');
    if (rmBtn) {
      if (rmBtn.classList.contains('off')) return toast('Убрать проект с карты можно, когда все его точки закрыты');
      return laneRemoveDialog(rmBtn.dataset.rmlane);
    }
    const lane = e.target.closest('.lane-l');
    if (lane) return toggleCollapsed('rm:' + lane.dataset.lane);
    const add = e.target.closest('.add-lane');
    if (add) return laneMenu(add);
    const hit = e.target.closest('[data-link]');
    if (hit) { state.rmLink = hit.dataset.link; renderBoard(); return toast('Связь выбрана. Backspace удаляет её'); }
    const lbl = e.target.closest('[data-ptl]');
    if (lbl) { const p = L.byId.get(lbl.dataset.ptl); if (p) openPointPanel(p.file, p.id); return; }
    if (state.rmLink) { state.rmLink = null; renderBoard(); }
  });

  wrap.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.canvas') || e.target.closest('.dia, .knob, .ptl, [data-link]')) return;
    const lane = laneAt(e.clientY);
    newPointDialog(lane?.p.file || null, dayAt(e.clientX));
  });

  // Ромб тянется — сдвиг срока; кружок тянется к другой точке — связь
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const dia = e.target.closest('.dia'), knob = e.target.closest('.knob');
    if (!dia && !knob) return;
    e.preventDefault();
    const p = L.byId.get((dia || knob).dataset.pt || knob.dataset.knob);
    if (!p) return;
    const sx = e.clientX;
    let moved = false;
    if (dia) {
      if (p.closed) { dia.addEventListener('pointerup', () => openPointPanel(p.file, p.id), { once: true }); return; }
      dia.setPointerCapture(e.pointerId);
      state.rmDrag = true;
      const x0 = parseFloat(dia.style.left);
      const tip = h('<div class="drag-tip"></div>');
      const mv = (ev) => {
        if (Math.abs(ev.clientX - sx) > 3) moved = true;
        if (!moved) return;
        dia.classList.add('dragging');
        dia.style.left = x0 + ev.clientX - sx + 'px';
        const nd = dayAt(ev.clientX), sh = signedDays(p.plan, nd);
        tip.textContent = `${ruDate(nd)}${sh ? ` (${fmtShift(sh)})` : ''}`;
        if (!tip.isConnected) document.body.append(tip);
        tip.style.left = ev.clientX + 14 + 'px'; tip.style.top = ev.clientY - 30 + 'px';
      };
      dia.addEventListener('pointermove', mv);
      const up = (ev) => {
        dia.removeEventListener('pointermove', mv);
        tip.remove();
        state.rmDrag = false;
        if (!moved) return openPointPanel(p.file, p.id);
        state.rmJustDragged = true;
        setTimeout(() => { state.rmJustDragged = false; }, 0);
        const nd = dayAt(ev.clientX);
        if (nd === p.plan) return renderBoard();
        movePoint(p, nd);
      };
      dia.addEventListener('pointerup', up, { once: true });
      dia.addEventListener('pointercancel', () => { dia.removeEventListener('pointermove', mv); tip.remove(); state.rmDrag = false; renderBoard(); }, { once: true });
    } else {
      knob.setPointerCapture(e.pointerId);
      state.rmDrag = true;
      const svg = canvas.querySelector('svg');
      const r = canvas.getBoundingClientRect();
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const x1 = L.X(shownDate(p)) + 9, y1 = p.y;
      for (const [k, v] of Object.entries({ x1, y1, x2: x1, y2: y1, stroke: RM_C.accent, 'stroke-width': 1.6, 'stroke-dasharray': '5 4' })) line.setAttribute(k, v);
      svg.append(line);
      knob.classList.add('on');
      const mv = (ev) => { line.setAttribute('x2', ev.clientX - r.left); line.setAttribute('y2', ev.clientY - r.top); };
      knob.addEventListener('pointermove', mv);
      knob.addEventListener('pointerup', (ev) => {
        knob.removeEventListener('pointermove', mv);
        state.rmDrag = false;
        const t = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el.classList?.contains('dia'));
        const q = t && L.byId.get(t.dataset.pt);
        line.remove(); knob.classList.remove('on');
        if (!q || q.id === p.id) return;
        if (q.after.includes(p.id) || p.after.includes(q.id)) return toast('Эти точки уже связаны');
        const bad = toUTC(shownDate(q)) < toUTC(shownDate(p));
        run({ type: 'linkAdd', from: p.id, to: q.id }, 'связь точек', () => toast(bad ? `Связь создана. «${q.title}» стоит раньше «${p.title}», поэтому связь оранжевая` : 'Связь создана')).catch(() => {});
      }, { once: true });
    }
  });
}

function movePoint(p, nd) {
  if (p.ind) return run({ type: 'pointUpdate', file: p.file, id: p.id, patch: { plan: nd } }, 'индикативный срок точки', () => toast(`Индикативный срок: ${ruDate(nd)}. Сдвиг не считается`)).catch(() => {});
  healthDialog(p, p.plan, nd, (health) => run({ type: 'pointUpdate', file: p.file, id: p.id, patch: { plan: nd, health } }, 'сдвиг контрольной точки', () => {
    toast(p.task ? 'Сдвиг записан. Срок связанной задачи в Tasks тоже изменился' : 'Сдвиг записан в журнал');
  }).catch(() => {}), () => renderBoard());
}

// Сдвиг реального срока требует нового здоровья. Esc или «Отмена» отменяют сдвиг.
function healthDialog(p, from, to, onPick, onCancel) {
  const n = signedDays(from, to);
  const wrap = h(`<div class="health-dlg"><p>Срок сдвинут: ${ruDate(from)} → ${ruDate(to)} (${fmtShift(n)}). Выберите здоровье точки заново. Esc отменяет сдвиг.</p>
    <div class="hbtns">${Object.entries(HEALTH).map(([k, v]) => `<button class="hbtn${p.health === k ? ' cur' : ''}" data-h="${k}"><span class="hdot" style="background:${v.c}"></span>${v.label}</button>`).join('')}</div></div>`);
  modal(`Здоровье точки «${p.title}»`, wrap, [{ label: 'Отмена', action: () => closeModal() }]);
  $overlay._cancel = onCancel || null;
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-h]');
    if (!b) return;
    $overlay._cancel = null;
    closeModal();
    onPick(b.dataset.h);
  });
  // Фокус не на кнопке: иначе Enter, которым подтвердили дату, сразу выбрал бы здоровье
  wrap.tabIndex = -1;
  wrap.focus();
}

function releaseDialog(iso) {
  const cur = (state.board.releases || []).find((r) => r.date === iso);
  const wrap = h('<div class="release-dlg"><p>Номер или название релиза. Колонка дня подсветится на карте.</p><input class="field" maxlength="30" placeholder="Например, 3.1"></div>');
  const input = wrap.querySelector('input');
  input.value = cur?.name || '';
  const set = (name, label) => { closeModal(); run({ type: 'releaseSet', date: iso, name }, label).catch(() => {}); };
  const save = () => { const v = input.value.trim(); if (!v) return cur ? set('', 'снятие релиза') : closeModal(); if (v !== cur?.name) set(v, 'плановый релиз'); else closeModal(); };
  modal(`Плановый релиз ${ruDate(iso)}`, wrap, [
    ...(cur ? [{ label: 'Снять релиз', cls: 'danger', action: () => set('', 'снятие релиза') }] : []),
    { label: 'Отмена', action: closeModal },
    { label: cur ? 'Сохранить' : 'Отметить', cls: 'primary', action: save },
  ]);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  input.focus(); input.select();
}

function laneMenu(anchor) {
  const free = state.board.projects.filter((p) => !p.roadmap);
  showMenu(anchor, [
    ...free.map((p) => ({ html: `<span class="grow">${esc(p.title)}</span><span class="menu-count">${p.tasks.filter(isOpenTask).length}</span>`, action: () => run({ type: 'laneAdd', file: p.file }, 'проект на дорожной карте').catch(() => {}) })),
    ...(free.length ? ['-'] : []),
    { label: 'Новый проект…', action: addProject },
  ]);
}

function laneRemoveDialog(file) {
  const p = state.board.projects.find((x) => x.file === file);
  if (!p) return;
  const n = (p.points || []).length;
  confirmDialog('Убрать проект с дорожной карты?', `Раздел RoadMap уберётся из файла «${file}». ${n ? `Закрытые точки (${n}) перейдут в архив/задачи/${file}.` : 'Точек на дорожке нет.'} Задачи проекта не меняются.`, 'Убрать', () => run({ type: 'laneRemove', file }, 'проект убран с дорожной карты').catch(() => {}));
}

// Новая точка: проект, префикс, название (код префикса можно написать в начале), владелец, старт, срок
function newPointDialog(file, iso) {
  const b = state.board;
  if (!b.projects.length) return toast('Сначала создайте проект на вкладке Tasks', true);
  const lanes = b.projects.filter((p) => p.roadmap), others = b.projects.filter((p) => !p.roadmap);
  file = file || lanes[0]?.file || b.projects[0].file;
  const groups = [...new Set((b.peopleGroups || []).map((p) => p.group))];
  const ownerOpts = groups.length > 1 || groups[0]
    ? groups.map((g) => `<optgroup label="${esc(g || 'Без группы')}">${b.peopleGroups.filter((p) => p.group === g).map((p) => `<option>${esc(p.name)}</option>`).join('')}</optgroup>`).join('')
    : b.people.map((n) => `<option>${esc(n)}</option>`).join('');
  const wrap = h(`<div class="pt-form">
    <label class="fl"><span>Проект</span><select class="field" name="file">${[...lanes, ...others].map((p) => `<option value="${esc(p.file)}"${p.file === file ? ' selected' : ''}>${esc(p.title)}${p.roadmap ? '' : ' (появится на карте)'}</option>`).join('')}</select></label>
    <div class="fl"><span>Префикс</span><div class="prechips"><button type="button" class="none on" data-pre="">Без префикса</button>${(b.prefixes || []).map((x) => `<button type="button" data-pre="${esc(x.code)}" style="${preStyle(x.code)}" title="${esc(x.name)}">${esc(x.code)}</button>`).join('')}</div></div>
    <label class="fl"><span>Название</span><input class="field" name="title" maxlength="120" placeholder="Можно начать с кода: «dev Синяя кнопка»"></label>
    <label class="fl"><span>Краткое описание</span><input class="field" name="desc" maxlength="300" placeholder="Что должно быть готово к сроку"></label>
    <label class="fl"><span>Владелец</span><select class="field" name="owner"><option value="">Выберите…</option>${ownerOpts}</select></label>
    <div class="fl-row"><label class="fl"><span>Старт работ, если известен</span><input class="field" name="start" placeholder="дд.мм.гггг"></label><label class="fl"><span>Срок</span><input class="field" name="plan" placeholder="дд.мм.гггг"></label></div>
    <label class="chk"><input type="checkbox" name="ind"> Индикативный срок <span class="faint">примерный, сдвиги не считаются</span></label>
  </div>`);
  const f = (n) => wrap.querySelector(`[name="${n}"]`);
  maskDate(f('start')); maskDate(f('plan'));
  f('plan').value = iso ? ruDate(iso) : '';
  let pre = '';
  const setPre = (v) => { pre = v; wrap.querySelectorAll('[data-pre]').forEach((x) => x.classList.toggle('on', x.dataset.pre === v)); };
  wrap.querySelector('.prechips').addEventListener('click', (e) => { const x = e.target.closest('[data-pre]'); if (x) { setPre(x.dataset.pre); f('title').focus(); } });
  // Быстрый ввод: код префикса в начале названия становится префиксом
  f('title').addEventListener('input', () => {
    const m = f('title').value.match(/^\[?([A-Za-zА-Яа-яЁё]+)\]?\s/);
    const x = m && (b.prefixes || []).find((y) => y.code.toLowerCase() === m[1].toLowerCase());
    if (x) { setPre(x.code); f('title').value = f('title').value.slice(m[0].length); }
  });
  const m = modal('Новая контрольная точка', wrap, [{ label: 'Отмена', action: closeModal }, { label: 'Создать', cls: 'primary', action: () => submit() }]);
  const okBtn = m.querySelector('.actions .primary');
  const check = () => { okBtn.disabled = !(f('title').value.trim() && f('owner').value && parseRuDate(f('plan').value || '')); };
  wrap.addEventListener('input', check); wrap.addEventListener('change', check); check();
  const submit = () => {
    if (okBtn.disabled) return toast('Заполните название, владельца и срок', true);
    const start = f('start').value.trim() ? parseRuDate(f('start').value) : '';
    if (start === null) return toast('Старт работ: дата в формате ДД.ММ.ГГГГ', true);
    const op = { type: 'pointCreate', file: f('file').value, pre, title: f('title').value.trim(), desc: f('desc').value.trim(), owner: f('owner').value, start, plan: parseRuDate(f('plan').value), ind: f('ind').checked };
    closeModal();
    run(op, 'новая контрольная точка', (r) => { if (r.point) state.rmFocus = r.point.id; toast(`Точка «${op.title}» создана`); }).catch(() => {});
  };
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); submit(); } });
  f('title').focus();
}

function showPointOnMap(id) {
  const p = pointById(id);
  if (!p) return toast('Контрольная точка не найдена', true);
  closePanel();
  state.view = 'roadmap'; state.rmFocus = id; state.rmScroll = null; state.rmResetScroll = true; state.adding = null;
  try { localStorage.setItem('taskboard.view', 'roadmap'); } catch {}
  if (state.collapsed.delete('rm:' + p.file)) { try { localStorage.setItem(collapseKey(), JSON.stringify([...state.collapsed])); } catch {} }
  renderBoard();
  openPointPanel(p.file, id);
}

// ---------- карточка контрольной точки ----------
function openPointPanel(file, id) {
  flushPanel();
  state.panel = null;
  state.ppanel = { file, id, hist: null };
  $panel.hidden = false;
  $panel.innerHTML = '';
  $app.querySelectorAll('.trow.selected').forEach((c) => c.classList.remove('selected'));
  $app.querySelectorAll('.dia').forEach((d) => d.classList.toggle('sel', d.dataset.pt === id));
  syncPointPanel(true);
}

function syncPointPanel(force = false) {
  const pp = state.ppanel;
  if (!pp) return;
  let p = pointById(pp.id);
  if (!p) { if (!state.pending) { toast('Контрольной точки больше нет'); closePanel(); } return; }
  pp.file = p.file;
  // Не перерисовываем, пока в карточке что-то печатают
  if (!force && $panel.contains(document.activeElement) && document.activeElement.matches('input, textarea')) { pp.dirty = true; return; }
  pp.dirty = false;
  const scroll = $panel.querySelector('.panel-body')?.scrollTop || 0;
  buildPointPanel(p);
  $panel.querySelector('.panel-body').scrollTop = scroll;
  loadPointHistory(p.id);
}

async function loadPointHistory(id) {
  try {
    const { items } = await api('/api/history?id=' + encodeURIComponent(id));
    if (state.ppanel?.id !== id) return;
    state.ppanel.hist = items;
    drawPointHistory();
  } catch {}
}
function drawPointHistory() {
  const ul = $panel.querySelector('.phist');
  const items = state.ppanel?.hist;
  if (!ul || !items) return;
  ul.innerHTML = items.length ? items.map((x) => `<li><span class="when">${esc(ruDate(x.date).slice(0, 5))} ${esc(x.time)}</span>${esc(x.text)}</li>`).join('') : '<li class="faint">Пока ничего не менялось</li>';
}

function buildPointPanel(p) {
  const sh = shiftOf(p);
  const tk = p.task ? findTaskById(p.task) : null;
  const pref = p.pre ? prefixOf(p.pre) : null;
  $panel.innerHTML = '';
  $panel.append(h(`<div class="panel-inner" style="display:contents">
    <div class="panel-top"><span class="crumb">${esc(p.project)} · контрольная точка</span><button class="icon-btn close" title="Закрыть (Esc)">✕</button></div>
    <div class="panel-body">
      <textarea class="title-input" rows="1" maxlength="120" placeholder="Название точки"></textarea>
      <div class="errors"${p.errors?.length ? '' : ' hidden'}>${p.errors?.length ? `<b>Ошибка в строке точки</b><ul>${p.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}</div>
      <div class="props">
        <div class="label">Статус</div><div class="val"><span class="seg small"><button data-st="open" class="${p.closed ? '' : 'on'}">Открыта</button><button data-st="closed" class="${p.closed ? 'on' : ''}">Закрыта</button></span></div>
        ${p.closed ? '<div class="label">Дата закрытия</div><div class="val"><input data-pk="closed" placeholder="дд.мм.гггг"></div>' : ''}
        <div class="label">Здоровье</div><div class="val hrow">${Object.entries(HEALTH).map(([k, v]) => `<button class="hp${p.health === k ? ' on' : ''}" data-hh="${k}" style="background:${v.bg};color:${v.c}" title="${p.health === k ? 'Текущее здоровье' : 'Сменить здоровье'}"><span class="hdot" style="background:${v.c}"></span>${v.label}</button>`).join('')}</div>
        <div class="label">Префикс</div><div class="val"><button class="pick pre-pick" title="Сменить префикс">${p.pre ? `${preChip(p.pre)}<span class="muted">${esc(pref?.name || '')}</span>` : '<span class="faint">нет</span>'}</button></div>
        <div class="label">Владелец</div><div class="val"><button class="pick owner-pick" title="Сменить владельца">${p.owner ? personHtml(p.owner) : '<span class="faint">не выбран</span>'}</button></div>
        <div class="label">Старт работ</div><div class="val"><input data-pk="start" placeholder="не указан"></div>
        <div class="label">Срок</div><div class="val"><input data-pk="plan" placeholder="дд.мм.гггг"><label class="chk"><input type="checkbox" class="ind-chk"${p.ind ? ' checked' : ''}> Индикативный</label></div>
        ${!p.ind && validDate(p.orig) ? `<div class="label">Первоначальный срок</div><div class="val static">${ruDate(p.orig)}</div>
        <div class="label">Сдвиги</div><div class="val static"><span>${p.shifts || 0}${sh ? `, всего <b style="color:${sh > 0 ? HEALTH.r.c : HEALTH.g.c}">${fmtShift(sh)}</b> от первоначального` : ''}</span></div>` : ''}
        <div class="label">Задача</div><div class="val">${tk ? `<button class="pick task-pick" title="Открыть задачу в Tasks. Срок, название, владелец и закрытие синхронизированы"><span class="pt-mark">◆</span><span class="nm">${esc(tk.t.title)}</span></button>` : `<span class="static faint">${p.task ? 'задача в архиве' : 'не связана'}</span>`}</div>
      </div>
      <div class="section-label">Описание</div>
      <textarea class="desc pdesc" placeholder="Что должно быть готово к сроку"></textarea>
      <div class="section-label">История</div>
      <ul class="phist"></ul>
    </div>
    <div class="panel-foot"><span class="file">${esc(p.file)}</span><button class="btn danger del">Удалить точку</button></div>
  </div>`));
  const upd = (patch, label, after) => run({ type: 'pointUpdate', file: p.file, id: p.id, patch }, label, after).catch(() => syncPointPanel(true));
  $panel.querySelector('.close').addEventListener('click', closePanel);

  const title = $panel.querySelector('.title-input');
  title.value = p.title;
  const autosize = () => { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
  requestAnimationFrame(autosize);
  title.addEventListener('input', autosize);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('change', () => { const v = title.value.trim(); if (v && v !== p.title) upd({ title: v }, 'название точки'); else if (!v) title.value = p.title; });
  title.addEventListener('blur', () => { if (state.ppanel?.dirty) setTimeout(() => syncPointPanel(), 0); });

  $panel.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', () => {
    const st = b.dataset.st;
    if ((st === 'closed') === !!p.closed) return;
    upd({ status: st }, st === 'closed' ? 'закрытие точки' : 'открытие точки', () => toast(st === 'closed' ? (p.task ? 'Точка закрыта, связанная задача тоже закрыта' : 'Точка закрыта') : 'Точка снова открыта'));
  }));
  $panel.querySelectorAll('[data-hh]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.hh === p.health) return;
    upd({ health: b.dataset.hh }, 'здоровье точки', () => toast('Здоровье изменено, записано в журнал'));
  }));
  $panel.querySelector('.pre-pick').addEventListener('click', (e) => showMenu(e.currentTarget, [
    ...(state.board.prefixes || []).map((x) => ({ html: `${preChip(x.code)}<span class="grow">${esc(x.name)}</span>`, active: p.pre === x.code, action: () => upd({ pre: x.code }, 'префикс точки') })),
    '-',
    { html: '<span class="faint">Без префикса</span>', active: !p.pre, action: () => upd({ pre: '' }, 'префикс точки') },
  ]));
  $panel.querySelector('.owner-pick').addEventListener('click', (e) => assigneeMenu(e.currentTarget, p.owner, (v) => {
    if (!v) return toast('У контрольной точки обязательно есть владелец', true);
    if (v !== p.owner) upd({ owner: v }, 'владелец точки', () => p.task && toast('Исполнитель связанной задачи тоже сменился'));
  }));
  $panel.querySelectorAll('input[data-pk]').forEach((inp) => {
    const k = inp.dataset.pk;
    maskDate(inp);
    inp.value = validDate(p[k]) ? ruDate(p[k]) : '';
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    inp.addEventListener('blur', () => { if (state.ppanel?.dirty) setTimeout(() => syncPointPanel(), 0); });
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      const iso = v ? parseRuDate(v) : '';
      if (iso === null) { toast('Дата должна быть в формате ДД.ММ.ГГГГ', true); return syncPointPanel(true); }
      if (iso === (p[k] || '')) return;
      if (k === 'start') return upd({ start: iso }, 'старт работ');
      if (!iso) { toast(k === 'plan' ? 'Срок обязателен' : 'Укажите дату закрытия', true); return syncPointPanel(true); }
      if (k === 'closed') return upd({ closed: iso }, 'дата закрытия точки');
      if (p.ind || p.closed) return upd({ plan: iso }, 'срок точки');
      healthDialog(p, p.plan, iso, (health) => upd({ plan: iso, health }, 'сдвиг контрольной точки', () => toast(p.task ? 'Сдвиг записан. Срок связанной задачи в Tasks тоже изменился' : 'Сдвиг записан в журнал')), () => syncPointPanel(true));
    });
  });
  $panel.querySelector('.ind-chk').addEventListener('change', (e) => {
    const on = e.target.checked;
    upd({ ind: on }, on ? 'индикативный срок' : 'реальный срок', () => toast(on ? 'Срок индикативный: сдвиги не показываются' : `Срок реальный, сдвиги отображаются. Первоначальный срок: ${ruDate(p.plan)}`));
  });
  $panel.querySelector('.task-pick')?.addEventListener('click', () => {
    const f = findTaskById(p.task);
    if (!f) return;
    setView('tasks');
    openPanel(f.p.file, f.t);
    $app.querySelector('.trow.selected')?.scrollIntoView({ block: 'center' });
  });
  const desc = $panel.querySelector('.desc');
  desc.value = p.desc || '';
  desc.addEventListener('input', () => { clearTimeout(descTimer); descTimer = setTimeout(() => { descTimer = null; desc.dispatchEvent(new Event('change')); }, 800); });
  desc.addEventListener('change', () => { clearTimeout(descTimer); descTimer = null; if (desc.value.trim() !== (p.desc || '').trim()) upd({ desc: desc.value }, 'описание точки'); });
  desc.addEventListener('blur', () => { if (state.ppanel?.dirty) setTimeout(() => syncPointPanel(), 0); });
  $panel.querySelector('.del').addEventListener('click', () => confirmDialog('Удалить контрольную точку?', `«${p.title}» и её связи исчезнут с карты.${p.task ? ' Задача в Tasks останется.' : ''} Отменить можно через ⌘Z / Ctrl+Z.`, 'Удалить', () => {
    closePanel();
    run({ type: 'pointDelete', file: p.file, id: p.id }, 'удаление точки').catch(() => {});
  }));
  drawPointHistory();
}

// ---------- справочник префиксов ----------
function showPrefixes() {
  const freeColor = () => TAG_COLOR_NAMES.find((c) => !(state.board.prefixes || []).some((x) => x.color === c)) || TAG_COLOR_NAMES[0];
  let color = freeColor();
  const wrap = h(`<div class="prefix-dlg">
    <p class="dlg-hint" style="margin:0 0 10px !important">Короткий код этапа. На карте он стоит перед названием точки. В окне новой точки код можно написать в начале названия: «dev Синяя кнопка».</p>
    <ul class="people-list"></ul>
    <div class="color-row"><span class="color-label">Новый префикс: цвет, код и расшифровка</span></div>
    <div class="add-row"><input class="field code" maxlength="12" placeholder="Код, например UAT" style="width:150px;flex:none"><input class="field name" maxlength="60" placeholder="Расшифровка"><button class="btn primary">Добавить</button></div>
  </div>`);
  const list = wrap.querySelector('ul');
  const extra = wrap.querySelector('.color-row');
  const drawPicker = () => { extra.querySelector('.swatches')?.remove(); extra.append(swatches(color, (c) => { color = c; })); };
  const draw = () => {
    list.innerHTML = '';
    const items = state.board.prefixes || [];
    if (!items.length) list.append(h('<li><span class="nm faint">Префиксов нет. Они хранятся в файле _префиксы.md</span></li>'));
    for (const x of items) {
      const li = h(`<li><button class="pre pre-btn" style="${preStyle(x.code)}" title="Сменить цвет">${esc(x.code)}</button><span class="nm">${esc(x.name || '')}</span><button class="icon-btn ren" title="Изменить расшифровку">✎</button><button class="icon-btn del" title="Удалить">×</button></li>`);
      li.querySelector('.pre-btn').addEventListener('click', () => {
        if (li.nextElementSibling?.classList.contains('swatch-li')) { li.nextElementSibling.remove(); return; }
        const row = h('<li class="swatch-li"></li>');
        row.append(swatches(TAG_COLORS[x.color] ? x.color : '', async (c) => { await run({ type: 'prefixUpdate', code: x.code, color: c }, 'цвет префикса').catch(() => {}); draw(); }));
        li.after(row);
      });
      li.querySelector('.ren').addEventListener('click', () => {
        const inp = h(`<input class="field" maxlength="60" value="${esc(x.name || '')}">`);
        li.querySelector('.nm').replaceWith(inp);
        inp.focus(); inp.select();
        let done = false;
        const save = async () => { if (done) return; done = true; const v = inp.value.trim(); if (v !== (x.name || '')) await run({ type: 'prefixUpdate', code: x.code, name: v }, 'расшифровка префикса').catch(() => {}); draw(); };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); done = true; draw(); } });
        inp.addEventListener('blur', save);
      });
      li.querySelector('.del').addEventListener('click', async () => { await run({ type: 'prefixDelete', code: x.code }, 'удаление префикса').catch(() => {}); draw(); });
      list.append(li);
    }
  };
  const code = wrap.querySelector('.code'), name = wrap.querySelector('.name');
  const add = async () => {
    const c = code.value.trim();
    if (!c) return code.focus();
    await run({ type: 'prefixAdd', code: c, name: name.value.trim(), color }, 'добавление префикса').then(() => { code.value = ''; name.value = ''; color = freeColor(); drawPicker(); }).catch(() => {});
    draw(); code.focus();
  };
  wrap.querySelector('.add-row .btn').addEventListener('click', add);
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.focus(); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  drawPicker();
  draw();
  modal('Префиксы', wrap, [{ label: 'Готово', action: closeModal }]);
  code.focus();
}

// ---------- PDF ----------
// Весь период карты в текущем масштабе: SVG со встроенным шрифтом → картинка → JPEG → одна страница PDF
let fontCss = null;
async function rmFontCss() {
  if (fontCss) return fontCss;
  const b64 = async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const [cyr, lat] = await Promise.all([b64('fonts/inter-cyr.woff2'), b64('fonts/inter-lat.woff2')]);
  fontCss = `@font-face{font-family:"InterPdf";font-weight:400 700;src:url(data:font/woff2;base64,${cyr}) format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:"InterPdf";font-weight:400 700;src:url(data:font/woff2;base64,${lat}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`;
  return fontCss;
}

function rmPdfSvg(L, W, H, TOP, fonts, i0, i1) {
  const b = state.board;
  const rel = Object.fromEntries((b.releases || []).map((r) => [r.date, r.name]));
  const ctx = document.createElement('canvas').getContext('2d');
  const measure = (txt, font) => { ctx.font = `${font} Inter, sans-serif`; return ctx.measureText(txt).width; };
  const T = (x, y, txt, a = '') => `<text x="${x}" y="${y}" ${a}>${esc(txt)}</text>`;
  const BH = H - TOP - RM.HEAD;
  let head = '', bg = '';
  for (let i = i0; i < i1; i++) {
    const ms = L.start + i * dayMs, d = new Date(ms), iso = isoOf(ms), x = i * L.dw;
    const dow = d.getUTCDay(), we = dow === 0 || dow === 6;
    if (d.getUTCDate() === 1 || i === i0) {
      head += `<line x1="${x}" y1="0" x2="${x}" y2="46" stroke="${RM_C.line}"/>` + T(x + 6, 17, `${MON_FULL[d.getUTCMonth()]}${d.getUTCMonth() === 0 || i === i0 ? ' ' + d.getUTCFullYear() : ''}`, `font-size="12.5" font-weight="600" fill="${RM_C.ink}"`);
      bg += `<line x1="${x}" y1="0" x2="${x}" y2="${BH}" stroke="${RM_C.line}"/>`;
    }
    if (dow === 1) {
      const ww = 7 * L.dw, wn = isoWeek(ms);
      head += `<line x1="${x}" y1="24" x2="${x}" y2="46" stroke="${RM_C.line}"/>`;
      if (ww >= 16) head += T(x + 4, 40, ww >= 34 ? 'Н' + wn : String(wn), `font-size="11.5" fill="${RM_C.muted}"`);
      if (d.getUTCDate() !== 1) bg += `<line x1="${x}" y1="0" x2="${x}" y2="${BH}" stroke="${RM_C.line2}"/>`;
    }
    if (we && L.dw >= 6) bg += `<rect x="${x}" y="0" width="${L.dw}" height="${BH}" fill="${RM_C.weekend}"/>`;
    if (rel[iso]) bg += `<rect x="${x}" y="0" width="${Math.max(L.dw, 4)}" height="${BH}" fill="${RM_C.rel}"/>`;
    if (iso === b.today) head += `<rect x="${x + 1}" y="47" width="${Math.max(L.dw - 2, 2)}" height="22" rx="4" fill="${RM_C.accent}"/>`;
    if (L.dw >= 12) head += T(x + L.dw / 2, 62, String(d.getUTCDate()), `font-size="${L.dw >= 18 ? 11 : 9.5}" text-anchor="middle" fill="${iso === b.today ? '#fff' : we ? RM_C.weFaint : RM_C.faint}"${iso === b.today ? ' font-weight="600"' : ''}`);
    if (rel[iso]) {
      const w = measure(rel[iso], '600 11px') + 10, cx = x + L.dw / 2;
      head += `<rect x="${cx - w / 2}" y="47" width="${w}" height="22" rx="5" fill="${RM_C.relInk}"/>` + T(cx, 62, rel[iso], 'font-size="11" font-weight="600" text-anchor="middle" fill="#fff"');
    }
  }
  if (toUTC(b.today) >= L.start && toUTC(b.today) < L.end) bg += `<rect x="${L.X(b.today) - 1}" y="0" width="2" height="${BH}" fill="${RM_C.accent}"/>`;

  let pts = '', lanes = '';
  for (const p of L.byId.values()) {
    const x = L.X(shownDate(p)), col = p.closed ? RM_C.closed : HEALTH[p.health].c;
    pts += `<rect x="-8" y="-8" width="16" height="16" rx="3" transform="translate(${x},${p.y}) rotate(45)" ${p.ind ? `fill="#fff" stroke="${RM_C.muted}" stroke-width="1.5" stroke-dasharray="3 2"` : `fill="${col}" stroke="#fff" stroke-width="2"`}/>`;
    if (p.coll) continue;
    let lx = Math.max(x, shiftOf(p) ? L.X(p.orig) : x) + 24;
    const chipW = p.pre ? measure(p.pre, '600 11.5px') + 19 : 0;
    const nameW = state.rmNames && p.owner ? measure(p.owner, '400 12.5px') + 32 : 0;
    const fullW = chipW + measure(p.title, '500 13px') + (p.ind ? 20 : 0) + nameW;
    pts += `<rect x="${lx - 4}" y="${p.y - 12}" width="${fullW + 8}" height="24" rx="4" fill="#fff" fill-opacity=".82"/>`;
    if (p.pre) {
      const [cbg, cfg] = prefixColors(p.pre);
      const w = measure(p.pre, '600 11.5px') + 12;
      pts += `<rect x="${lx}" y="${p.y - 10}" width="${w}" height="20" rx="4" fill="${cbg}"/>` + T(lx + 6, p.y + 4, p.pre, `font-size="11.5" font-weight="600" fill="${cfg}"`);
      lx += w + 7;
    }
    pts += T(lx, p.y + 4.5, p.title, `font-size="13" font-weight="500" fill="${p.closed ? RM_C.faint : RM_C.ink}"${p.closed ? ' text-decoration="line-through"' : ''}`);
    lx += measure(p.title, '500 13px') + 7;
    if (p.ind) { pts += T(lx, p.y + 4.5, '≈', `font-size="12" fill="${RM_C.muted}"`); lx += 20; }
    if (nameW) pts += `<circle cx="${lx + 9}" cy="${p.y}" r="9" fill="#efe9e3"/>` + T(lx + 9, p.y + 3.5, [...p.owner][0].toUpperCase(), 'font-size="10" font-weight="600" text-anchor="middle" fill="#64473a"') + T(lx + 23, p.y + 4.5, p.owner, `font-size="12.5" fill="${RM_C.muted}"`);
  }
  for (const l of L.lanes) {
    const w = Math.min(measure(l.p.title, '600 14px'), RM.LEFT - 60);
    lanes += T(14, l.y + 24, l.p.title, `font-size="14" font-weight="600" fill="${RM_C.ink}"`) + T(14 + w + 8, l.y + 24, String(l.pts.length), `font-size="12.5" font-weight="500" fill="${RM_C.faint}"`);
    lanes += `<line x1="0" y1="${l.y + l.h - 0.5}" x2="${W}" y2="${l.y + l.h - 0.5}" stroke="${RM_C.line}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>${fonts} text{font-family:"InterPdf",sans-serif}</style>
<rect width="${W}" height="${H}" fill="#fff"/>
${T(16, 30, `RoadMap · ${b.name}`, `font-size="18" font-weight="700" fill="${RM_C.ink}"`)}
${T(W - 16, 30, `${ruDate(isoOf(L.start + i0 * dayMs))} – ${ruDate(isoOf(L.start + (i1 - 1) * dayMs))}`, `font-size="13" text-anchor="end" fill="${RM_C.muted}"`)}
<defs><clipPath id="cb"><rect x="0" y="0" width="${(i1 - i0) * L.dw}" height="${BH}"/></clipPath><clipPath id="ch"><rect x="0" y="0" width="${(i1 - i0) * L.dw}" height="${RM.HEAD}"/></clipPath></defs>
<g transform="translate(${RM.LEFT},${TOP + RM.HEAD})"><g clip-path="url(#cb)"><g transform="translate(${-i0 * L.dw},0)">${bg}${rmOverlay(L, true)}${pts}</g></g></g>
<g transform="translate(0,${TOP + RM.HEAD})"><rect x="0" y="0" width="${RM.LEFT}" height="${BH}" fill="#fff"/>${lanes}<line x1="${RM.LEFT - 0.5}" y1="0" x2="${RM.LEFT - 0.5}" y2="${BH}" stroke="${RM_C.line}"/></g>
<g transform="translate(0,${TOP})"><rect x="0" y="0" width="${W}" height="${RM.HEAD}" fill="#fff"/><g transform="translate(${RM.LEFT},0)"><g clip-path="url(#ch)"><g transform="translate(${-i0 * L.dw},0)">${head}</g></g></g>
${T(16, 64, 'Проекты', `font-size="12" fill="${RM_C.faint}"`)}<line x1="0" y1="${RM.HEAD - 0.5}" x2="${W}" y2="${RM.HEAD - 0.5}" stroke="${RM_C.line}"/><line x1="${RM.LEFT - 0.5}" y1="0" x2="${RM.LEFT - 0.5}" y2="${RM.HEAD}" stroke="${RM_C.line}"/></g>
</svg>`;
}

function makePdf(jpeg, iw, ih, W, H) {
  const k = Math.min(0.75, 14400 / W, 14400 / H); // 1 px = 0,75 pt; страница PDF не больше 200 дюймов
  const pw = (W * k).toFixed(2), ph = (H * k).toFixed(2);
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let len = 0;
  const push = (x) => { const u = typeof x === 'string' ? enc.encode(x) : x; parts.push(u); len += u.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n${body}\nendobj\n`); };
  push('%PDF-1.4\n'); push(new Uint8Array([37, 226, 227, 207, 211, 10]));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = len;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg); push('\nendstream\nendobj\n');
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

async function exportPdf() {
  const b = state.board;
  toast('Готовлю PDF…');
  try {
    await document.fonts.ready;
    // В PDF попадают те даты, которые сейчас видны на экране, в текущем масштабе
    const el = $app.querySelector('.rm'), L = state.rmGeo;
    if (!el || !L) return;
    const i0 = Math.max(0, Math.round(el.scrollLeft / L.dw));
    const viewPx = Math.min(el.clientWidth, document.documentElement.clientWidth - 12) - RM.LEFT; // как в rmLayout
    const i1 = Math.min(L.n, i0 + Math.max(1, Math.round(viewPx / L.dw)));
    const TOP = 48;
    const W = Math.ceil(RM.LEFT + (i1 - i0) * L.dw), H = Math.ceil(TOP + RM.HEAD + Math.max(L.height + 24, 80));
    const svg = rmPdfSvg(L, W, H, TOP, await rmFontCss(), i0, i1);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    await new Promise((r) => setTimeout(r, 120)); // шрифт внутри SVG успевает примениться
    const k = Math.max(0.5, Math.min(2, 16000 / W, 16000 / H, Math.sqrt(100e6 / (W * H))));
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * k); cv.height = Math.round(H * k);
    const cx = cv.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
    cx.drawImage(img, 0, 0, cv.width, cv.height);
    const jpeg = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
    const pdf = makePdf(new Uint8Array(await jpeg.arrayBuffer()), cv.width, cv.height, W, H);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(pdf);
    a.download = `RoadMap ${ruDate(isoOf(L.start + i0 * dayMs))}-${ruDate(isoOf(L.start + (i1 - 1) * dayMs))}.pdf`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) { toast('Не удалось собрать PDF: ' + e.message, true); }
}

let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.mode === 'board' && state.view === 'roadmap' && !state.rmDrag) renderBoard(); }, 150); });

// ---------- клавиатура ----------
document.addEventListener('keydown', (e) => {
  const inField = e.target.closest?.('input, textarea, select');
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z' && !inField && state.mode === 'board') {
    e.preventDefault();
    history(e.shiftKey ? 'redo' : 'undo');
  } else if (mod && e.key.toLowerCase() === 'y' && !inField && state.mode === 'board') {
    e.preventDefault(); history('redo');
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && state.view === 'roadmap' && state.rmLink && !inField && $overlay.hidden && state.mode === 'board') {
    // Выбранная связь на карте удаляется клавишей Backspace
    e.preventDefault();
    const [from, to] = state.rmLink.split('>');
    state.rmLink = null;
    run({ type: 'linkDelete', from, to }, 'удаление связи', () => toast('Связь удалена')).catch(() => {});
  } else if (e.key === 'Escape') {
    if (menuEl) closeMenu();
    else if (!$overlay.hidden) closeModal();
    else if (state.waitFilter && !state.panel && !inField) setWaitFilter(null);
    else if (state.rmLink && !inField) { state.rmLink = null; renderBoard(); }
    else if ((state.panel || state.ppanel) && !inField) closePanel();
    else if (inField && (state.panel || state.ppanel)) e.target.blur();
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
