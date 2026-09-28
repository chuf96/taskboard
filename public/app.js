// Task Board — интерфейс. Чистый JS без зависимостей.

const STATUSES = [
  { id: 'new', label: 'Новая' },
  { id: 'progress', label: 'В работе' },
  { id: 'waiting', label: 'Ожидание ответа' },
  { id: 'closed', label: 'Закрыто' },
];
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

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
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
    root.querySelector('.picker-foot .grow').textContent = cur.mdCount ? `В папке ${cur.mdCount} .md-файл(ов) — это будут колонки` : 'В папке нет .md-файлов — можно создать проекты позже';
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
function renderBoard() {
  const b = state.board;
  const scroll = $app.querySelector('.board')?.scrollLeft || 0;
  const colScroll = {};
  $app.querySelectorAll('.column').forEach((c) => (colScroll[c.dataset.file] = c.querySelector('.col-body')?.scrollTop || 0));

  $app.innerHTML = '';
  const top = h(`<header class="topbar">
    <button class="name" title="${esc(b.folder)}">${esc(b.name)} <small>▾</small></button>
    <span class="spacer"></span>
    ${state.waitFilter ? `<button class="filter-chip" title="Сбросить фильтр (Esc)">Ожидания: ${esc(state.waitFilter)} <span>✕</span></button>` : ''}
    <button class="icon-btn burger" title="Меню" aria-label="Меню"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 5h12M3 9h12M3 13h12"/></svg></button>
  </header>`);
  top.querySelector('.name').addEventListener('click', (e) => showMenu(e.currentTarget, [
    { label: 'Сменить папку…', action: async () => showPicker((await api('/api/state')).recent, b.folder) },
  ]));
  top.querySelector('.filter-chip')?.addEventListener('click', () => setWaitFilter(null));
  top.querySelector('.burger').addEventListener('click', (e) => showMenu(e.currentTarget, [
    { label: 'Фильтр ожиданий ›', action: (anchor) => waitFilterMenu(anchor) },
    { label: 'Новый проект', action: addProject },
    { label: 'Исполнители', action: showPeople },
    { label: 'Настройки', action: showSettings },
    '-',
    { html: `<span class="menu-version">Версия ${esc((b.version || '').replace(/\.0$/, ''))}</span>`, disabled: true, action: () => {} },
  ]));
  $app.append(top);

  const board = h('<main class="board"></main>');
  if (!b.projects.length) {
    board.append(h(`<div class="empty"><h2>Проектов пока нет</h2><p>Каждый проект — это .md-файл в папке.</p><button class="btn primary">Создать проект</button></div>`));
    board.querySelector('button').addEventListener('click', addProject);
  }
  if (state.waitFilter) {
    const shown = b.projects.filter((p) => p.tasks.some((t) => isWaitingFor(t, state.waitFilter)));
    for (const p of shown) board.append(renderColumn(p));
    if (!shown.length && b.projects.length) {
      board.append(h(`<div class="empty"><h2>У исполнителя ${esc(state.waitFilter)} нет задач в ожидании</h2><button class="btn primary">Сбросить фильтр</button></div>`));
      board.querySelector('.empty button').addEventListener('click', () => setWaitFilter(null));
    }
  } else for (const p of b.projects) board.append(renderColumn(p));
  $app.append(board);
  board.scrollLeft = scroll;
  board.querySelectorAll('.column').forEach((c) => { const body = c.querySelector('.col-body'); if (body) body.scrollTop = colScroll[c.dataset.file] || 0; });

  // Новая задача появляется в конце открытых — прокручиваем к ней
  if (state.revealLast) {
    const last = board.querySelector(`.column[data-file="${CSS.escape(state.revealLast)}"] .open-cards .card:last-child`);
    state.revealLast = null;
    last?.scrollIntoView({ block: 'nearest' });
  }
  const input = board.querySelector('.add-input');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

const isWaitingFor = (t, name) => t.status === 'waiting' && t.assignee === name;

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

function renderColumn(p) {
  const filter = state.waitFilter;
  const open = filter ? p.tasks.filter((t) => isWaitingFor(t, filter)) : p.tasks.filter((t) => t.status !== 'closed' || t.errors.length);
  const closed = filter ? [] : p.tasks.filter((t) => t.status === 'closed' && !t.errors.length);
  const col = h(`<section class="column" data-file="${esc(p.file)}">
    <div class="col-head" draggable="true"><h2 title="${esc(p.title)}">${esc(p.title)}</h2><span class="count">${open.length}</span><button class="icon-btn more" title="Действия">⋯</button></div>
    <div class="col-body"><div class="cards open-cards"></div></div>
    <div class="add-wrap"></div>
  </section>`);
  const body = col.querySelector('.col-body');
  const openCards = col.querySelector('.open-cards');
  for (const t of open) openCards.append(renderCard(p, t));

  const addWrap = col.querySelector('.add-wrap');
  if (filter) addWrap.remove();
  else if (state.adding?.file === p.file) {
    const ta = h(`<textarea class="add-input" rows="2" maxlength="${TITLE_MAX}" placeholder="Название задачи… Enter — добавить, Esc — закрыть"></textarea>`);
    ta.value = state.adding.value;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    ta.addEventListener('input', () => { state.adding.value = ta.value; grow(); });
    requestAnimationFrame(grow);
    const counter = attachCounter(ta, true);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const title = ta.value.trim();
        if (!title) return;
        if (title.length > TITLE_MAX) return;
        // Поле очищаем только после успешного создания — при ошибке текст остаётся.
        run({ type: 'create', file: p.file, title }, 'создание задачи', () => { if (state.adding?.file === p.file) state.adding.value = ''; state.revealLast = p.file; }).catch(() => {});
      } else if (e.key === 'Escape') { state.adding = null; renderBoard(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => {
      if (ta.isConnected && state.adding?.file === p.file && !state.adding.value.trim() && document.activeElement !== ta && !state.pending) { state.adding = null; renderBoard(); }
    }, 150));
    addWrap.append(ta, counter);
  } else {
    const btn = h('<button class="add-task">+ Задача</button>');
    btn.addEventListener('click', () => { state.adding = { file: p.file, value: '' }; renderBoard(); });
    addWrap.append(btn);
  }

  if (closed.length) {
    const isOpen = state.openClosed.has(p.file);
    const tog = h(`<button class="closed-toggle${isOpen ? ' open' : ''}"><span class="chev">›</span> Закрыто (${closed.length})</button>`);
    tog.addEventListener('click', () => { isOpen ? state.openClosed.delete(p.file) : state.openClosed.add(p.file); renderBoard(); });
    body.append(tog);
    if (isOpen) {
      const cc = h('<div class="cards closed-cards"></div>');
      for (const t of closed) cc.append(renderCard(p, t));
      body.append(cc);
    }
  }

  col.querySelector('.more').addEventListener('click', (e) => showMenu(e.currentTarget, [
    { label: 'Переименовать', action: () => renameProject(p) },
    { label: `Архивировать закрытые${closed.length ? ` (${closed.length})` : ''}`, disabled: !closed.length, action: () => run({ type: 'archiveClosed', file: p.file }, 'архивация закрытых') },
    '-',
    { label: 'Архивировать проект', danger: true, action: () => confirmDialog('Архивировать проект?', `Файл «${p.file}» будет перенесён в папку архив/проекты. Его можно вернуть вручную.`, 'Архивировать', () => run({ type: 'archiveProject', file: p.file }, 'архивация проекта')) },
  ]));

  setupColumnDnd(col, p);
  setupCardDrop(col, p);
  return col;
}

function renderCard(p, t) {
  const st = shownStatus(t);
  const sel = state.panel && state.panel.file === p.file && state.panel.line === t.line;
  const card = h(`<article class="card${t.status === 'closed' ? ' closed' : ''}${t.errors.length ? ' has-error' : ''}${t.overdue && !t.errors.length ? ' overdue' : ''}${sel ? ' selected' : ''}" draggable="true">
    <div class="title">${esc(t.title || 'Без названия')}</div>
    <div class="meta">
      <button class="pill ${st}" title="Сменить статус">${STATUS_LABEL[st]}</button>
      ${t.assignee ? `<span class="person"><span class="avatar">${esc(initials(t.assignee))}</span>${esc(t.assignee)}</span>` : ''}
      <span class="when">${esc(whenText(t))}</span>
    </div>
  </article>`);
  card._ref = { file: p.file, line: t.line, lineNo: t.lineNo };
  card.addEventListener('click', (e) => { if (!e.target.closest('.pill')) openPanel(p.file, t); });
  card.querySelector('.pill').addEventListener('click', (e) => { e.stopPropagation(); statusMenu(e.currentTarget, p.file, t); });
  card.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    drag = { kind: 'card', ref: card._ref };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', t.title);
    setTimeout(() => card.classList.add('dragging'), 0);
  });
  card.addEventListener('dragend', () => { card.classList.remove('dragging'); clearDrop(); drag = null; });
  return card;
}

function statusMenu(anchor, file, t) {
  showMenu(anchor, STATUSES.map((s) => ({
    html: `<span class="pill ${s.id}">${s.label}</span>`,
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

// ---------- перетаскивание ----------
let drag = null;
let dropMarker = null;
function clearDrop() {
  dropMarker?.remove(); dropMarker = null;
  document.querySelectorAll('.drag-over-col').forEach((c) => c.classList.remove('drag-over-col'));
}

function setupCardDrop(col, p) {
  const body = col.querySelector('.col-body');
  const findBefore = (container, y) => [...container.querySelectorAll('.card:not(.dragging)')].find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;
  body.addEventListener('dragover', (e) => {
    if (drag?.kind !== 'card') return;
    e.preventDefault();
    const container = e.target.closest('.cards') || col.querySelector('.open-cards');
    const before = findBefore(container, e.clientY);
    if (!dropMarker) dropMarker = h('<div class="drop-line"></div>');
    if (before) container.insertBefore(dropMarker, before); else container.append(dropMarker);
    dropMarker._before = before; dropMarker._file = p.file; dropMarker._container = container;
  });
  body.addEventListener('dragleave', (e) => { if (!body.contains(e.relatedTarget)) { dropMarker?.remove(); dropMarker = null; } });
  body.addEventListener('drop', (e) => {
    if (drag?.kind !== 'card' || !dropMarker) return;
    e.preventDefault();
    let before = dropMarker._before?._ref || null;
    // Сброс в конец открытых задач: вставляем перед первой закрытой, чтобы задача не ушла в хвост
    if (!before && dropMarker._container.classList.contains('open-cards')) {
      const proj = state.board.projects.find((x) => x.file === p.file);
      const closedT = proj.tasks.find((t) => t.status === 'closed' && !t.errors.length && t.line !== drag.ref.line);
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

function setupColumnDnd(col, p) {
  const head = col.querySelector('.col-head');
  head.addEventListener('dragstart', (e) => {
    drag = { kind: 'col', file: p.file };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', p.title);
    setTimeout(() => col.classList.add('dragging'), 0);
  });
  head.addEventListener('dragend', () => { col.classList.remove('dragging'); clearDrop(); drag = null; });
  col.addEventListener('dragover', (e) => {
    if (drag?.kind !== 'col' || drag.file === p.file) return;
    e.preventDefault();
    document.querySelectorAll('.drag-over-col').forEach((c) => c !== col && c.classList.remove('drag-over-col'));
    col.classList.add('drag-over-col');
  });
  col.addEventListener('drop', (e) => {
    if (drag?.kind !== 'col' || drag.file === p.file) return;
    e.preventDefault();
    const files = state.board.projects.map((x) => x.file).filter((f) => f !== drag.file);
    const r = col.getBoundingClientRect();
    const idx = files.indexOf(p.file) + (e.clientX > r.left + r.width / 2 ? 1 : 0);
    files.splice(idx, 0, drag.file);
    clearDrop();
    run({ type: 'reorderProjects', order: files }, 'порядок колонок').catch(() => {});
  });
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
  menuEl.style.left = Math.min(r.left, innerWidth - mw - 8) + 'px';
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

function showPeople() {
  const wrap = h('<div><ul class="people-list"></ul><div class="add-row"><input class="field" placeholder="Имя нового исполнителя"><button class="btn primary">Добавить</button></div></div>');
  const list = wrap.querySelector('ul');
  const draw = () => {
    list.innerHTML = '';
    if (!state.board.people.length) list.append(h('<li><span class="nm" style="color:var(--faint)">Справочник пуст. Имена хранятся в файле _исполнители.md</span></li>'));
    for (const name of state.board.people) {
      const li = h(`<li><span class="avatar">${esc(initials(name))}</span><span class="nm">${esc(name)}</span><button class="icon-btn ren" title="Переименовать">✎</button><button class="icon-btn del" title="Удалить">×</button></li>`);
      li.querySelector('.ren').addEventListener('click', () => {
        const inp = h(`<input class="field" value="${esc(name)}">`);
        li.querySelector('.nm').replaceWith(inp);
        inp.focus(); inp.select();
        let done = false;
        const save = async () => {
          if (done) return;
          done = true;
          const v = inp.value.trim();
          if (v && v !== name) await run({ type: 'personRename', from: name, to: v }, 'переименование исполнителя').catch(() => {});
          draw();
        };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') draw(); });
        inp.addEventListener('blur', save);
      });
      li.querySelector('.del').addEventListener('click', async () => { await run({ type: 'personDelete', name }, 'удаление исполнителя').catch(() => {}); draw(); });
      list.append(li);
    }
  };
  const input = wrap.querySelector('input');
  const add = async () => { const v = input.value.trim(); if (!v) return; input.value = ''; await run({ type: 'personAdd', name: v }, 'добавление исполнителя').catch(() => {}); draw(); input.focus(); };
  wrap.querySelector('.add-row button').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  draw();
  modal('Исполнители', wrap, [{ label: 'Готово', action: closeModal }]);
  input.focus();
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
  if (state.mode === 'board') $app.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
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
        <div class="label">Статус</div><div class="val"><button class="pill status-pill"></button></div>
        <div class="label">Исполнитель</div><div class="val"><select class="assignee"></select></div>
        <div class="label">Создана</div><div class="val"><input data-k="created" placeholder="дд.мм.гггг"><span class="raw" data-raw="created"></span></div>
        <div class="label">Взята в работу</div><div class="val"><input data-k="taken" placeholder="дд.мм.гггг"><span class="raw" data-raw="taken"></span></div>
        <div class="label">Ждём ответа с</div><div class="val"><input data-k="waiting" placeholder="дд.мм.гггг"><span class="raw" data-raw="waiting"></span></div>
        <div class="label">Вернуться до</div><div class="val"><input data-k="deadline" placeholder="дд.мм.гггг"><span class="raw" data-raw="deadline"></span></div>
        <div class="label">Закрыта</div><div class="val"><input data-k="closed" placeholder="дд.мм.гггг"><span class="raw" data-raw="closed"></span></div>
        <div class="label closed-only">Результат</div><div class="val closed-only"><input class="wide" data-f="result" maxlength="300" placeholder="Чем закончилось"></div>
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

  $panel.querySelector('.status-pill').addEventListener('click', (e) => { const f = cur(); if (f?.t) statusMenu(e.currentTarget, state.panel.file, f.t); });
  $panel.querySelector('.assignee').addEventListener('change', (e) => patch({ assignee: e.target.value }, 'смена исполнителя'));
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
  const sp = $panel.querySelector('.status-pill');
  sp.className = `pill status-pill ${t.status === 'error' ? 'error' : t.status}`;
  sp.textContent = t.status === 'error' ? `[${t.char}] — выберите статус` : STATUS_LABEL[t.status];

  const sel = $panel.querySelector('.assignee');
  const people = [...state.board.people];
  sel.innerHTML = '<option value="">—</option>' + people.map((n) => `<option>${esc(n)}</option>`).join('') +
    (t.assignee && !people.includes(t.assignee) ? `<option>${esc(t.assignee)}</option>` : '');
  sel.value = t.assignee;

  for (const k of ['created', 'taken', 'waiting', 'deadline', 'closed']) {
    const inp = $panel.querySelector(`input[data-k=${k}]`);
    const raw = $panel.querySelector(`[data-raw=${k}]`);
    const ok = validDate(t[k]);
    if (force || active !== inp) inp.value = ok ? ruDate(t[k]) : '';
    inp.classList.toggle('empty-date', !t[k]);
    raw.textContent = t[k] && !ok ? `в файле: «${t[k]}»` : '';
  }
  $panel.querySelectorAll('.closed-only').forEach((el) => { el.hidden = t.status !== 'closed'; });
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

start().catch((e) => { $app.innerHTML = `<div class="empty"><h2>Не удалось запустить</h2><p>${esc(e.message)}</p></div>`; });
