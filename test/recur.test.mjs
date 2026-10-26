import test from 'node:test';
import assert from 'node:assert/strict';
import * as rc from '../lib/recur.mjs';
import * as md from '../lib/md.mjs';

const week = (o) => ({ id: 'r0001', title: 'Рутина', file: 'Работа.md', assignee: '', tag: '', kind: 'week', days: [1, 2, 3, 4, 5], every: 1, day: 1, start: '2026-10-26', paused: false, last: '', ...o });

test('день недели: 26.10.2026 — понедельник', () => {
  assert.equal(rc.weekday('2026-10-26'), 1);
  assert.equal(rc.weekday('2026-11-01'), 7);
});

test('по будням: выпадает на пн–пт, не на выходные и не раньше начала', () => {
  const r = week();
  assert.ok(rc.occursOn(r, '2026-10-30'));
  assert.ok(!rc.occursOn(r, '2026-10-31'));
  assert.ok(!rc.occursOn(r, '2026-10-23'));
});

test('по понедельникам раз в 2 недели от недели начала', () => {
  const r = week({ days: [1], every: 2, start: '2026-10-28' });
  assert.ok(!rc.occursOn(r, '2026-10-26'), 'до начала');
  assert.ok(!rc.occursOn(r, '2026-11-02'));
  assert.ok(rc.occursOn(r, '2026-11-09'));
  assert.ok(rc.occursOn(r, '2026-11-23'));
  assert.equal(rc.nextOccurrence(r, '2026-10-26'), '2026-11-09');
});

test('31 числа: в коротком месяце в последний день', () => {
  const r = week({ kind: 'month', day: 31, days: [], start: '2026-01-01' });
  assert.ok(rc.occursOn(r, '2026-11-30'));
  assert.ok(!rc.occursOn(r, '2026-11-29'));
  assert.ok(rc.occursOn(r, '2027-02-28'));
  assert.ok(rc.occursOn(r, '2026-12-31'));
});

test('dueToday: пауза и уже созданное за сегодня пропускаются', () => {
  const rules = [week(), week({ id: 'r0002', paused: true }), week({ id: 'r0003', last: '2026-10-26' }), week({ id: 'r0004', last: '2026-10-23' })];
  assert.deepEqual(rc.dueToday(rules, '2026-10-26').map((r) => r.id), ['r0001', 'r0004']);
});

test('правила пишутся и читаются обратно, заголовок файла сохраняется', () => {
  const rules = [week({ assignee: 'Ника', last: '2026-10-26' }), week({ id: 'r0002', title: 'Отчёт', kind: 'month', day: 15, days: [], paused: true })];
  const text = rc.formatRules(rules, '');
  assert.match(text, /^# Регулярные задачи/);
  assert.match(text, /- Рутина \[проект:: Работа\.md\] \[исполнитель:: Ника\] \[дни:: пн, вт, ср, чт, пт\] \[каждые:: 1\] \[с:: 2026-10-26\] \[создано по:: 2026-10-26\] \^r0001/);
  assert.deepEqual(rc.parseRules(text), rules.map((r) => ({ ...r, every: r.kind === 'month' ? 1 : r.every })));
  const again = rc.formatRules(rc.parseRules(text).slice(1), 'Мои заметки\n\n' + text);
  assert.match(again, /^Мои заметки/);
  assert.equal(rc.parseRules(again).length, 1);
});

test('ID правил не повторяются, даже если правило удалено, а задачи остались', () => {
  assert.equal(rc.nextRuleId(['- А [проект:: x.md] ^r0002', '- [ ] Задача [регулярная:: r0007] ^t0001']), 'r0008');
});

test('задача хранит ссылку на правило', () => {
  const t = md.parseTaskLine('- [ ] Рутина [срок:: 2026-10-26] [регулярная:: r0001] ^t0005');
  assert.equal(t.recur, 'r0001');
  assert.equal(md.formatTaskLine(t), '- [ ] Рутина [срок:: 2026-10-26] [регулярная:: r0001] ^t0005');
});

test('описание повтора', () => {
  assert.equal(rc.describe(week()), 'по будням');
  assert.equal(rc.describe(week({ days: [1], every: 2 })), 'пн, раз в 2 нед.');
  assert.equal(rc.describe(week({ kind: 'month', day: 15 })), '15 числа каждого месяца');
});
