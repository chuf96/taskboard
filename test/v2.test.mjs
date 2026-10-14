import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as md from '../lib/md.mjs';
import * as log from '../lib/log.mjs';

test('фокус: чтение, запись, снятие при закрытии', () => {
  const t = md.parseTaskLine('- [/] Отчёт [исполнитель:: Иван] [фокус:: да] [создана:: 2026-10-01] ^t0001');
  assert.equal(t.focus, true);
  assert.equal(md.formatTaskLine(t), '- [/] Отчёт [исполнитель:: Иван] [фокус:: да] [создана:: 2026-10-01] ^t0001');
  assert.equal(md.parseTaskLine('- [/] Отчёт').focus, false);
  assert.equal(md.parseTaskLine('- [/] Отчёт [фокус:: нет]').focus, false);
  const off = md.applyPatch(t, { focus: false }, '2026-10-14');
  assert.equal(md.formatTaskLine(off), '- [/] Отчёт [исполнитель:: Иван] [создана:: 2026-10-01] ^t0001');
  const on = md.applyPatch(md.parseTaskLine('- [ ] Б'), { focus: true }, '2026-10-14');
  assert.equal(md.formatTaskLine(on), '- [ ] Б [фокус:: да]');
  const closed = md.applyPatch(t, { status: 'closed' }, '2026-10-14');
  assert.equal(closed.focus, false);
});

test('фокус пишется в журнал', () => {
  const a = md.parseTaskLine('- [ ] А ^t0001');
  const b = { ...a, focus: true };
  const ev = log.taskChanges('П', a, b);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'фокус');
  assert.equal(ev[0].text, 'добавлена в фокус');
});

test('группы исполнителей: старый файл без групп читается как раньше', () => {
  const old = '# Исполнители\n\n- Ника\n- Анна\n';
  assert.deepEqual(md.parsePeopleGroups(old), [{ name: 'Ника', group: '' }, { name: 'Анна', group: '' }]);
  assert.deepEqual(md.parsePeople(old), ['Ника', 'Анна']);
  // Запись без групп не меняет файл
  assert.equal(md.formatPeopleGroups(md.parsePeopleGroups(old), old), old);
});

test('группы исполнителей: чтение и запись', () => {
  const text = '# Исполнители\n\nЗаметка.\n\n- Анна\n\n## Риски\n- Иван\n- Петр\n\n## Право\n- Олег\n';
  const g = md.parsePeopleGroups(text);
  assert.deepEqual(g, [{ name: 'Анна', group: '' }, { name: 'Иван', group: 'Риски' }, { name: 'Петр', group: 'Риски' }, { name: 'Олег', group: 'Право' }]);
  assert.deepEqual(md.parsePeople(text), ['Анна', 'Иван', 'Петр', 'Олег']);
  assert.equal(md.formatPeopleGroups(g, text), text);
  const moved = g.map((p) => (p.name === 'Анна' ? { ...p, group: 'Право' } : p));
  assert.equal(md.formatPeopleGroups(moved, text), '# Исполнители\n\nЗаметка.\n\n## Риски\n- Иван\n- Петр\n\n## Право\n- Анна\n- Олег\n');
});
