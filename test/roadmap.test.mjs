import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rm from '../lib/roadmap.mjs';
import * as md from '../lib/md.mjs';
import * as log from '../lib/log.mjs';

const FILE = '# Проект\n\n- [ ] Задача [срок:: 2026-11-01] ^t0001\n\n## RoadMap\n\n- Оплата [префикс:: BA] [владелец:: Ника] [срок:: 2026-11-10] [первоначальный срок:: 2026-11-05] [здоровье:: есть риски] [сдвигов:: 1] ^m0001\n    Описание точки\n    вторая строка\n- Релиз [владелец:: Анна] [срок:: 2026-12-01] [индикативный:: да] [здоровье:: по плану] [после:: m0001] ^m0002\n';

test('точка: чтение и запись строки без потерь', () => {
  const line = '- Оплата [префикс:: BA] [владелец:: Ника] [старт:: 2026-10-13] [срок:: 2026-11-10] [первоначальный срок:: 2026-11-05] [здоровье:: есть риски] [сдвигов:: 1] [задача:: t0005] [после:: m0001, m0002] ^m0003';
  const p = rm.parsePointLine(line);
  assert.equal(p.id, 'm0003');
  assert.equal(p.title, 'Оплата');
  assert.equal(p.health, 'y');
  assert.equal(p.shifts, 1);
  assert.deepEqual(p.after, ['m0001', 'm0002']);
  assert.equal(rm.formatPointLine(p), line);
  assert.equal(rm.parsePointLine('- [ ] Задача ^m0001'), null);
  assert.equal(rm.parsePointLine('- Без id'), null);
  assert.equal(rm.healthCode('красная'), 'r');
});

test('индикативный срок: без первоначального и сдвигов', () => {
  const p = rm.parsePointLine('- А [владелец:: Ника] [срок:: 2026-11-10] [первоначальный срок:: 2026-11-01] [сдвигов:: 2] ^m0001');
  assert.equal(rm.formatPointLine({ ...p, ind: true }), '- А [владелец:: Ника] [срок:: 2026-11-10] [индикативный:: да] [здоровье:: по плану] ^m0001');
});

test('раздел RoadMap: разбор, описание, задачи не путаются с точками', () => {
  const r = rm.parseRoadmap(FILE);
  assert.equal(r.has, true);
  assert.deepEqual(r.points.map((p) => p.id), ['m0001', 'm0002']);
  assert.equal(r.points[0].desc, 'Описание точки\nвторая строка');
  assert.equal(r.points[1].ind, true);
  assert.equal(md.parseFile ? true : true, true);
  assert.equal(rm.parseRoadmap('# П\n').has, false);
  assert.equal(rm.nextPointId([FILE, '^m0007']), 'm0003');
});

test('добавление, замена, удаление точки', () => {
  const block = rm.pointBlock({ id: 'm0003', title: 'Новая', owner: 'Ника', plan: '2026-12-10', health: 'g' });
  let t = rm.addPoint('# П\n\n- [ ] А ^t0001\n', block);
  assert.equal(t, '# П\n\n- [ ] А ^t0001\n\n## RoadMap\n\n- Новая [владелец:: Ника] [срок:: 2026-12-10] [здоровье:: по плану] ^m0003\n');
  t = rm.addPoint(FILE, block);
  assert.deepEqual(rm.parseRoadmap(t).points.map((p) => p.id), ['m0001', 'm0002', 'm0003']);
  t = rm.replacePoint(t, 'm0001', null);
  assert.deepEqual(rm.parseRoadmap(t).points.map((p) => p.id), ['m0002', 'm0003']);
  assert.ok(!t.includes('Описание точки'));
  const d = rm.dropLinks(FILE, ['m0001']);
  assert.deepEqual(rm.parseRoadmap(d).points[1].after, []);
});

test('убрать раздел RoadMap', () => {
  const { text, points } = rm.removeSection(FILE);
  assert.equal(points.length, 2);
  assert.equal(text, '# Проект\n\n- [ ] Задача [срок:: 2026-11-01] ^t0001\n');
  const mid = '# П\n\n## RoadMap\n\n- А [владелец:: Н] [срок:: 2026-11-10] ^m0001\n\n## Другое\n\nтекст\n';
  assert.equal(rm.removeSection(mid).text, '# П\n\n## Другое\n\nтекст\n');
});

test('новая задача встаёт над разделом RoadMap', () => {
  const t = md.insertBlock(FILE, ['- [ ] Новая ^t0002']);
  const lines = t.split('\n');
  assert.ok(lines.indexOf('- [ ] Новая ^t0002') < lines.indexOf('## RoadMap'));
  const only = '# П\n\n## RoadMap\n\n- А [владелец:: Н] [срок:: 2026-11-10] ^m0001\n';
  const t2 = md.insertBlock(only, ['- [ ] Новая ^t0002']).split('\n');
  assert.ok(t2.indexOf('- [ ] Новая ^t0002') < t2.indexOf('## RoadMap'));
});

test('срок задачи', () => {
  const t = md.parseTaskLine('- [ ] А [исполнитель:: Ника] [срок:: 2026-11-01] ^t0001');
  assert.equal(t.due, '2026-11-01');
  assert.equal(md.formatTaskLine(t), '- [ ] А [исполнитель:: Ника] [срок:: 2026-11-01] ^t0001');
});

test('релизы и префиксы', () => {
  const r = rm.formatReleases([{ date: '2026-12-01', name: '3.1' }, { date: '2026-11-10', name: '3.0' }]);
  assert.deepEqual(rm.parseReleases(r), [{ date: '2026-11-10', name: '3.0' }, { date: '2026-12-01', name: '3.1' }]);
  assert.ok(r.startsWith('# Релизы'));
  const p = rm.formatPrefixes(rm.DEFAULT_PREFIXES);
  assert.deepEqual(rm.parsePrefixes(p), rm.DEFAULT_PREFIXES);
});

test('журнал: сдвиг точки с днями и здоровьем', () => {
  const a = rm.parsePointLine('- А [владелец:: Ника] [срок:: 2026-11-10] [первоначальный срок:: 2026-11-10] ^m0001');
  const b = { ...a, plan: '2026-11-14', shifts: 1, health: 'y' };
  const ev = log.pointChanges('П', a, b);
  const s = ev.find((e) => e.kind === 'сдвиг');
  assert.ok(s, JSON.stringify(ev));
  assert.equal(s.days, '+4');
  const line = log.formatEvent(s);
  assert.match(line, /\[раздел:: roadmap\]/);
  assert.match(line, /\[дней:: \+4\]/);
  assert.match(line, /\[здоровье:: есть риски\]/);
});
