// Оформление проектов: иконка из галереи и её цвет.
// Хранится в _board.json → icons: { "Работа.md": { icon: "briefcase", color: "синий" } }.
// Проект без записи — без иконки (в интерфейсе кружок с первой буквой), так старые доски работают как раньше.
import { PROJECT_ICONS } from '../public/icons.js';
import { TAG_COLOR_NAMES } from './md.mjs';

export const ICON_IDS = new Set(PROJECT_ICONS.map((x) => x.id));
export const isIcon = (id) => ICON_IDS.has(id);
export const isColor = (c) => TAG_COLOR_NAMES.includes(c);

// Цвет по умолчанию — по названию файла, как у тэгов без цвета
export function defaultColor(file) {
  let h = 0;
  for (const ch of String(file)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_COLOR_NAMES[h % TAG_COLOR_NAMES.length];
}

// Из сырого _board.json → только корректные записи; неизвестные иконки отбрасываются, неизвестный цвет заменяется
export function normalizeIcons(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [file, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || !isIcon(v.icon)) continue;
    out[file] = { icon: v.icon, color: isColor(v.color) ? v.color : defaultColor(file) };
  }
  return out;
}

// Новая карта иконок: icon = null снимает иконку
export function withIcon(icons, file, icon, color) {
  const next = { ...normalizeIcons(icons) };
  if (icon === null || icon === undefined || icon === '') { delete next[file]; return next; }
  if (!isIcon(icon)) throw new Error('Неизвестная иконка');
  if (color !== undefined && color !== null && color !== '' && !isColor(color)) throw new Error('Неизвестный цвет');
  next[file] = { icon, color: isColor(color) ? color : (next[file]?.color || defaultColor(file)) };
  return next;
}

export function renameIconKey(icons, from, to) {
  const next = { ...normalizeIcons(icons) };
  if (next[from]) { next[to] = next[from]; delete next[from]; }
  return next;
}

export function dropIcon(icons, file) {
  const next = { ...normalizeIcons(icons) };
  delete next[file];
  return next;
}
