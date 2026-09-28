import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as md from '../lib/md.mjs';
import * as log from '../lib/log.mjs';

const snap = (files) => Object.fromEntries(Object.entries(files).map(([f, text]) => {
  const p = md.parseProject(text, f); return [f, { title: p.title, tasks: p.tasks }];
}));
const texts = (ev) => ev.map((e) => [e.project, e.task, e.text].filter(Boolean).join(' | '));

test('закрытие с результатом: ID и поля Dataview в строке, результат под событием', () => {
  const a = snap({ 'Р.md': '# Ремонт\n- [/] Плитка [создана:: 2026-09-01] [взята:: 2026-09-02] ^t0042\n    берём матовую\n' });
  const b = snap({ 'Р.md': '# Ремонт\n- [x] Плитка [создана:: 2026-09-01] [взята:: 2026-09-02] [закрыта:: 2026-09-25] [результат:: купили матовую] ^t0042\n    берём матовую\n' });
  const ev = log.diffSnapshots(a, b);
  assert.deepEqual(texts(ev), ['Ремонт | Плитка | статус: В работе → Закрыто']);
  const line = log.formatEvent(ev[0], new Date(2026, 8, 25, 14, 5));
  assert.equal(line, '- 14:05 · Ремонт · «Плитка» · статус: В работе → Закрыто [id:: t0042] [событие:: статус] [из:: progress] [в:: closed] [результат:: купили матовую]');
  assert.ok(!line.includes('берём'), 'комментарий в журнал не пишется');
});

test('результат, добавленный после закрытия, — отдельное событие; внешняя правка помечена полем', () => {
  const a = snap({ 'Р.md': '# Р\n- [x] A [закрыта:: 2026-09-25] ^t0001\n' });
  const b = snap({ 'Р.md': '# Р\n- [x] A [закрыта:: 2026-09-25] [результат:: сделано] ^t0001\n' });
  const ev = log.diffSnapshots(a, b, ' (вне борда)', true);
  assert.equal(log.formatEvent(ev[0], new Date(2026, 8, 25, 9, 0)), '- 09:00 · Р · «A» · результат: сделано (вне борда) [id:: t0001] [событие:: результат] [в:: сделано] [источник:: вне борда]');
});

test('ID сопоставляет задачу даже после переименования и переноса', () => {
  const a = snap({ 'A.md': '# A\n- [ ] Старое имя ^t0005\n', 'B.md': '# B\n' });
  const b = snap({ 'A.md': '# A\n', 'B.md': '# B\n- [ ] Новое имя ^t0005\n' });
  const ev = log.diffSnapshots(a, b);
  assert.ok(ev.some((e) => e.kind === 'перенос' && e.id === 't0005' && e.from === 'A' && e.to === 'B'), JSON.stringify(ev));
});

test('правка комментария без закрытия не логируется', () => {
  const a = snap({ 'Р.md': '# Р\n- [/] A\n    старое\n' });
  const b = snap({ 'Р.md': '# Р\n- [/] A\n    новое\n' });
  assert.deepEqual(log.diffSnapshots(a, b), []);
});

test('создание, переименование, исполнитель, удаление, перенос', () => {
  const a = snap({ 'A.md': '# A\n- [ ] Раз\n- [ ] Два\n- [ ] Три\n', 'B.md': '# B\n' });
  const b = snap({ 'A.md': '# A\n- [ ] Раз новый [исполнитель:: Олег]\n- [ ] Четыре\n', 'B.md': '# B\n- [ ] Три\n' });
  const t = texts(log.diffSnapshots(a, b, ' (вне борда)'));
  assert.ok(t.includes('A | Раз новый | название: «Раз» → «Раз новый» (вне борда)'), t);
  assert.ok(t.includes('A | Раз новый | исполнитель: — → Олег (вне борда)'), t);
  assert.ok(t.includes('B | Три | перенесена из «A» (вне борда)'), t);
  assert.ok(t.some((x) => x.startsWith('A | ') && x.includes('Четыре') || x.includes('Два')), t);
});

test('автоматические даты не пишутся отдельной строкой, ручные — пишутся', () => {
  const a = snap({ 'A.md': '# A\n- [ ] X [создана:: 2026-09-01]\n' });
  const b = snap({ 'A.md': '# A\n- [/] X [создана:: 2026-09-01] [взята:: 2026-09-25]\n' });
  assert.deepEqual(texts(log.diffSnapshots(a, b)), ['A | X | статус: Новая → В работе']);
  const c = snap({ 'A.md': '# A\n- [/] X [создана:: 2026-08-30] [взята:: 2026-09-25]\n' });
  assert.deepEqual(texts(log.diffSnapshots(b, c)), ['A | X | дата создания: 01.09.2026 → 30.08.2026']);
});

test('исполнители', () => {
  assert.deepEqual(texts(log.diffPeople(['А', 'Б'], ['А', 'В'])), ['Исполнители | добавлен: В', 'Исполнители | удалён: Б']);
});
