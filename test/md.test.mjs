import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as md from '../lib/md.mjs';

const SAMPLE = `# Ремонт

Заметка, которую нельзя терять.

## Кухня
- [/] Выбрать плитку [исполнитель:: Анна] [создана:: 2026-09-20] [взята:: 2026-09-22]
    Нужна матовая, 30×60.
    - [ ] Съездить в салон

- [ ] Заказать фасады [создана:: 2026-09-25]
- [>] Перенесённая [приоритет:: высокий]

Хвост файла.
`;

test('разбор проекта', () => {
  const p = md.parseProject(SAMPLE, 'Ремонт.md');
  assert.equal(p.title, 'Ремонт');
  assert.equal(p.tasks.length, 3);
  const [a, b, c] = p.tasks;
  assert.equal(a.title, 'Выбрать плитку');
  assert.equal(a.status, 'progress');
  assert.equal(a.assignee, 'Анна');
  assert.equal(a.taken, '2026-09-22');
  assert.equal(a.description, 'Нужна матовая, 30×60.\n- [ ] Съездить в салон');
  assert.equal(b.status, 'new');
  assert.equal(b.description, '');
  assert.equal(c.status, 'error');
  assert.deepEqual(c.extra, ['[приоритет:: высокий]']);
});

test('валидация', () => {
  const p = md.parseProject(SAMPLE, 'x.md');
  assert.deepEqual(md.validateTask(p.tasks[0], ['Анна']), []);
  assert.equal(md.validateTask(p.tasks[0], ['Олег']).length, 1);
  assert.equal(md.validateTask(p.tasks[2], []).length, 1);
  const bad = md.parseTaskLine('- [ ] X [создана:: 25.09.2026]');
  assert.match(md.validateTask(bad, [])[0], /формате/);
  assert.equal(md.isValidDate('2026-02-30'), false);
});

test('обновление сохраняет остальной текст байт-в-байт', () => {
  const t = md.findTask(SAMPLE, { line: '- [ ] Заказать фасады [создана:: 2026-09-25]' });
  const n = md.applyPatch(t, { status: 'progress', assignee: 'Олег' }, '2026-09-26');
  const out = md.replaceBlock(SAMPLE, t, md.taskBlock(n));
  assert.ok(out.includes('- [/] Заказать фасады [исполнитель:: Олег] [создана:: 2026-09-25] [взята:: 2026-09-26]\n'));
  assert.equal(out.replace(/^- \[\/\] Заказать.*\n/m, ''), SAMPLE.replace(/^- \[ \] Заказать.*\n/m, ''));
});

test('автоматические даты', () => {
  const t = md.parseTaskLine('- [ ] A [создана:: 2026-09-01]');
  const p = md.applyPatch(t, { status: 'progress' }, '2026-09-02');
  assert.equal(p.taken, '2026-09-02');
  const c = md.applyPatch(p, { status: 'closed' }, '2026-09-05');
  assert.equal(c.closed, '2026-09-05');
  assert.equal(c.char, 'x');
  const r = md.applyPatch(c, { status: 'progress' }, '2026-09-07');
  assert.equal(r.closed, '');
  assert.equal(r.taken, '2026-09-02', 'дата взятия ставится только при первом переводе');
});

test('неизвестный символ сохраняется при правке других полей', () => {
  const t = md.parseTaskLine('- [-] Отменённая');
  const n = md.applyPatch(t, { assignee: 'Анна' });
  assert.equal(md.formatTaskLine(n), '- [-] Отменённая [исполнитель:: Анна]');
});

test('удаление и вставка блока с описанием', () => {
  const t = md.parseProject(SAMPLE, 'x').tasks[0];
  const { text, block } = md.removeBlock(SAMPLE, t);
  assert.equal(block.length, 3);
  assert.equal(md.parseProject(text, 'x').tasks.length, 2);
  const back = md.insertBlock(text, block, null);
  const tasks = md.parseProject(back, 'x').tasks;
  assert.equal(tasks.at(-1).title, 'Выбрать плитку');
  assert.ok(back.includes('Хвост файла.'));
});

test('вставка в пустой файл', () => {
  const out = md.insertBlock('# Новый\n\n', ['- [ ] Первая']);
  assert.equal(out, '# Новый\n\n- [ ] Первая\n');
});

test('справочник исполнителей', () => {
  assert.deepEqual(md.parsePeople('# Исполнители\n\n- Анна\n- Олег\n- [ ] не человек\n'), ['Анна', 'Олег']);
  assert.equal(md.formatPeople(['Анна', 'Вера'], '# Исполнители\n\n- Анна\n'), '# Исполнители\n\n- Анна\n- Вера\n');
});

test('CRLF сохраняется', () => {
  const src = '# P\r\n\r\n- [ ] A\r\n';
  const t = md.findTask(src, { line: '- [ ] A' });
  const out = md.replaceBlock(src, t, md.taskBlock(md.applyPatch(t, { title: 'B' })));
  assert.equal(out, '# P\r\n\r\n- [ ] B\r\n');
});

test('ID задачи: разбор, запись, следующий номер', () => {
  const t = md.parseTaskLine('- [/] Задача [создана:: 2026-09-27] ^t0042');
  assert.equal(t.title, 'Задача');
  assert.equal(t.id, 't0042');
  assert.equal(md.formatTaskLine(t), '- [/] Задача [создана:: 2026-09-27] ^t0042');
  assert.equal(md.nextTaskId(['- [ ] a ^t0042\n- [ ] b ^t0007', '- [ ] c ^t0100 не в конце']), 't0043');
  assert.equal(md.nextTaskId([]), 't0001');
  assert.equal(md.parseTaskLine('- [ ] Про ^степень в тексте').id, '');
});

test('результат: только у закрытой задачи, стираются при переоткрытии', () => {
  const t = md.parseTaskLine('- [/] X ^t0001');
  assert.equal(md.applyPatch(t, { result: 'рано' }).result, '');
  const c = md.applyPatch(t, { status: 'closed', result: 'Готово [финал]\nвсё' }, '2026-09-27');
  assert.equal(md.formatTaskLine(c), '- [x] X [закрыта:: 2026-09-27] [результат:: Готово (финал) всё] ^t0001');
  const r = md.applyPatch(c, { status: 'progress' });
  assert.equal(r.result, '');
});

test('тэг: разбор, запись после исполнителя, проверка по справочнику', () => {
  const t = md.parseTaskLine('- [ ] Помыть посуду [исполнитель:: Ника] [тэг:: домашние дела] [создана:: 2026-10-03] ^t0001');
  assert.equal(t.tag, 'домашние дела');
  assert.equal(md.formatTaskLine(md.applyPatch(t, { tag: '' })), '- [ ] Помыть посуду [исполнитель:: Ника] [создана:: 2026-10-03] ^t0001');
  assert.equal(md.formatTaskLine(t), '- [ ] Помыть посуду [исполнитель:: Ника] [тэг:: домашние дела] [создана:: 2026-10-03] ^t0001');
  assert.deepEqual(md.validateTask(t, ['Ника'], ['домашние дела']), []);
  assert.deepEqual(md.validateTask(t, ['Ника'], ['работа']), ['Тэга «домашние дела» нет в справочнике']);
});

test('счётчики дня: всего незакрытых, создано и закрыто сегодня с учётом архива, без удалённых', () => {
  const p = (l) => md.parseTaskLine(l);
  const board = [p('- [ ] a [создана:: 2026-10-03]'), p('- [?] b [создана:: 2026-10-01]'), p('- [x] c [создана:: 2026-10-03] [закрыта:: 2026-10-03]'), p('- [x] d [создана:: 2026-09-01] [закрыта:: 2026-09-02]')];
  const archived = [p('- [x] e [создана:: 2026-10-02] [закрыта:: 2026-10-03]'), p('- [ ] f [создана:: 2026-10-03] [удалена:: 2026-10-03]')];
  assert.deepEqual(md.dayCounters(board, archived, '2026-10-03'), { total: 2, created: 2, closed: 2 });
});

test('статистика: сегодня пересчитывается, прошлые строки не меняются, пропуски восстанавливаются по датам', () => {
  const p = (l) => md.parseTaskLine(l);
  const board = [p('- [ ] a [создана:: 2026-10-01]'), p('- [x] b [создана:: 2026-09-30] [закрыта:: 2026-10-02]')];
  const first = md.updateStats('', board, [], '2026-10-02');
  assert.deepEqual([...md.parseStats(first)], [['2026-09-30', { total: 1, created: 1, closed: 0 }], ['2026-10-01', { total: 2, created: 1, closed: 0 }], ['2026-10-02', { total: 1, created: 0, closed: 1 }]]);
  const edited = first.replace('| 2026-10-01 | 2 | 1 | 0 |', '| 2026-10-01 | 7 | 7 | 7 |');
  const next = md.parseStats(md.updateStats(edited, board, [], '2026-10-04'));
  assert.deepEqual(next.get('2026-10-01'), { total: 7, created: 7, closed: 7 });
  assert.deepEqual(next.get('2026-10-03'), { total: 1, created: 0, closed: 0 });
  assert.deepEqual(next.get('2026-10-04'), { total: 1, created: 0, closed: 0 });
});

test('справочник тэгов: цвет в [цвет:: …], неизвестный цвет игнорируется', () => {
  const text = '# Тэги\n\n- дом [цвет:: зелёный]\n- работа\n- хобби [цвет:: неон]\n';
  assert.deepEqual(md.parseTags(text), [{ name: 'дом', color: 'зелёный' }, { name: 'работа', color: '' }, { name: 'хобби', color: '' }]);
  assert.equal(md.formatTags([{ name: 'дом', color: 'синий' }, { name: 'работа', color: '' }], text), '# Тэги\n\n- дом [цвет:: синий]\n- работа\n');
});

test('статус «Отменена»: [-], дата отмены, не входит во «всего задач»', () => {
  const t = md.parseTaskLine('- [/] X [создана:: 2026-10-01] [взята:: 2026-10-02] ^t0001');
  const c = md.applyPatch(t, { status: 'cancelled' }, '2026-10-03');
  assert.equal(md.formatTaskLine(c), '- [-] X [создана:: 2026-10-01] [взята:: 2026-10-02] [отменена:: 2026-10-03] ^t0001');
  assert.equal(md.parseTaskLine(md.formatTaskLine(c)).status, 'cancelled');
  assert.equal(md.applyPatch(c, { status: 'progress' }).cancelled, '');
  assert.deepEqual(md.dayCounters([c, md.parseTaskLine('- [ ] Y [создана:: 2026-10-03]')], [], '2026-10-03'), { total: 1, created: 1, closed: 0 });
  assert.equal(md.totalAt([c], '2026-10-02'), 1);
  assert.equal(md.totalAt([c], '2026-10-03'), 0);
});
