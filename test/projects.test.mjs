import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pj from '../lib/projects.mjs';
import { PROJECT_ICONS, iconSvg } from '../public/icons.js';

test('галерея: уникальные id, у каждой иконки есть название и тело', () => {
  const ids = PROJECT_ICONS.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 40);
  for (const x of PROJECT_ICONS) { assert.ok(x.title); assert.match(x.body, /^<(path|rect|circle|ellipse)/); }
  assert.match(iconSvg('home'), /^<svg[^>]+viewBox="0 0 24 24"/);
  assert.equal(iconSvg('нет такой'), '');
});

test('normalizeIcons: старый _board.json без icons — пусто; мусор отбрасывается', () => {
  assert.deepEqual(pj.normalizeIcons(undefined), {});
  assert.deepEqual(pj.normalizeIcons([]), {});
  const n = pj.normalizeIcons({ 'А.md': { icon: 'home', color: 'синий' }, 'Б.md': { icon: 'нет' }, 'В.md': 'home', 'Г.md': { icon: 'star', color: 'кислотный' } });
  assert.deepEqual(Object.keys(n), ['А.md', 'Г.md']);
  assert.equal(n['А.md'].color, 'синий');
  assert.ok(pj.isColor(n['Г.md'].color));
});

test('withIcon: установка, смена цвета, снятие', () => {
  let m = pj.withIcon({}, 'Работа.md', 'briefcase', 'синий');
  assert.deepEqual(m, { 'Работа.md': { icon: 'briefcase', color: 'синий' } });
  m = pj.withIcon(m, 'Работа.md', 'code');
  assert.deepEqual(m['Работа.md'], { icon: 'code', color: 'синий' }, 'цвет сохраняется при смене иконки');
  const d = pj.withIcon({}, 'Дом.md', 'home');
  assert.equal(d['Дом.md'].color, pj.defaultColor('Дом.md'));
  assert.deepEqual(pj.withIcon(m, 'Работа.md', null), {});
  assert.throws(() => pj.withIcon({}, 'А.md', 'нет'), /иконка/);
  assert.throws(() => pj.withIcon({}, 'А.md', 'home', 'кислотный'), /цвет/);
});

test('переименование и архивация проекта переносят/убирают иконку', () => {
  const m = { 'Старое.md': { icon: 'home', color: 'синий' }, 'Другое.md': { icon: 'star', color: 'жёлтый' } };
  const r = pj.renameIconKey(m, 'Старое.md', 'Новое.md');
  assert.deepEqual(Object.keys(r).sort(), ['Другое.md', 'Новое.md']);
  assert.deepEqual(r['Новое.md'], m['Старое.md']);
  assert.deepEqual(Object.keys(pj.dropIcon(m, 'Другое.md')), ['Старое.md']);
});
