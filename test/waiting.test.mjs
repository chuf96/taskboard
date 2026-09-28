import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as md from '../lib/md.mjs';
import * as log from '../lib/log.mjs';

const T = (line) => md.parseTaskLine(line);

test('разбор и порядок полей при записи', () => {
  const t = T('- [?] Смета [вернуться до:: 2026-09-19] [ждём с:: 2026-09-17] [исполнитель:: Олег] [создана:: 2026-09-15] [взята:: 2026-09-16] [x:: 1]');
  assert.equal(t.waiting, '2026-09-17');
  assert.equal(t.deadline, '2026-09-19');
  assert.equal(md.formatTaskLine(t), '- [?] Смета [исполнитель:: Олег] [создана:: 2026-09-15] [взята:: 2026-09-16] [ждём с:: 2026-09-17] [вернуться до:: 2026-09-19] [x:: 1]');
});

test('валидация новых дат', () => {
  const e = md.validateTask(T('- [?] A [ждём с:: 17.09] [вернуться до:: завтра]'), []);
  assert.deepEqual(e, ['Дата «ждём с» в неверном формате: «17.09»', 'Срок «вернуться до» в неверном формате: «завтра»']);
});

test('«ждём с» ставится при каждом входе в ожидание, при выходе оба поля очищаются', () => {
  const a = T('- [/] A [взята:: 2026-09-10]');
  const w1 = md.applyPatch(a, { status: 'waiting' }, '2026-09-17');
  assert.equal(w1.waiting, '2026-09-17');
  const w2 = md.applyPatch(w1, { deadline: '2026-09-20' }, '2026-09-18');
  assert.equal(w2.deadline, '2026-09-20');
  assert.equal(w2.waiting, '2026-09-17', 'правка других полей не трогает «ждём с»');
  const back = md.applyPatch(w2, { status: 'progress' }, '2026-09-19');
  assert.equal(back.waiting, ''); assert.equal(back.deadline, '');
  const again = md.applyPatch(back, { status: 'waiting' }, '2026-09-21');
  assert.equal(again.waiting, '2026-09-21');
  const closed = md.applyPatch(md.applyPatch(again, { deadline: '2026-09-30' }), { status: 'closed' }, '2026-09-22');
  assert.equal(closed.waiting, ''); assert.equal(closed.deadline, '');
  const manual = md.applyPatch(again, { waiting: '2026-09-18' });
  assert.equal(manual.waiting, '2026-09-18');
});

test('правило просрочки', () => {
  const w = (extra) => T(`- [?] A ${extra}`);
  // правило 1: срок указан
  assert.equal(md.isOverdue(w('[вернуться до:: 2026-09-19]'), '2026-09-19'), false, 'в день срока ещё не просрочено');
  assert.equal(md.isOverdue(w('[вернуться до:: 2026-09-19]'), '2026-09-20'), true);
  assert.equal(md.isOverdue(w('[ждём с:: 2026-09-01] [вернуться до:: 2026-09-30]'), '2026-09-20'), false, 'срок есть — правило 2 не применяется');
  assert.equal(md.isOverdue(w('[ждём с:: 2026-09-01] [вернуться до:: завтра]'), '2026-09-20'), false, 'неверный срок — не просрочено');
  // правило 2: срока нет
  assert.equal(md.isOverdue(w('[ждём с:: 2026-09-17]'), '2026-09-19'), false);
  assert.equal(md.isOverdue(w('[ждём с:: 2026-09-17]'), '2026-09-20'), true, 'ровно 3 дня — просрочено');
  assert.equal(md.isOverdue(w('[ждём с:: 2026-09-17]'), '2026-09-20', 5), false, 'настройка дней');
  assert.equal(md.isOverdue(w(''), '2026-12-01'), false, 'нет дат — не просрочено');
  // только «Ожидание ответа»
  assert.equal(md.isOverdue(T('- [/] A [ждём с:: 2026-09-01] [вернуться до:: 2026-09-02]'), '2026-09-20'), false);
});

test('порядок записи: добавления, потом удаления из файла, удаления файлов последними', () => {
  const ch = [
    { path: 'src.md', before: 'aaaa', after: 'a' },
    { path: 'old.md', before: 'x', after: null },
    { path: 'dst.md', before: 'b', after: 'bbbb' },
    { path: 'new.md', before: null, after: 'n' },
  ];
  assert.deepEqual(md.writeOrder(ch).map((c) => c.path), ['new.md', 'dst.md', 'src.md', 'old.md']);
  // отмена: направление считается заново
  assert.deepEqual(md.writeOrder(ch, 'before', 'after').map((c) => c.path), ['old.md', 'src.md', 'dst.md', 'new.md']);
});

test('журнал: ручные правки пишутся, автоматические — нет', () => {
  const snap = (text) => ({ 'A.md': { title: 'A', tasks: md.parseProject(text, 'A.md').tasks } });
  const t = (ev) => ev.map((e) => e.text);
  const s0 = snap('# A\n- [/] Смета [взята:: 2026-09-16]\n');
  const s1 = snap('# A\n- [?] Смета [взята:: 2026-09-16] [ждём с:: 2026-09-17]\n');
  assert.deepEqual(t(log.diffSnapshots(s0, s1)), ['статус: В работе → Ожидание ответа']);
  const s2 = snap('# A\n- [?] Смета [взята:: 2026-09-16] [ждём с:: 2026-09-17] [вернуться до:: 2026-10-01]\n');
  assert.deepEqual(t(log.diffSnapshots(s1, s2)), ['вернуться до: — → 01.10.2026']);
  const s3 = snap('# A\n- [?] Смета [взята:: 2026-09-16] [ждём с:: 2026-09-18] [вернуться до:: 2026-10-01]\n');
  assert.deepEqual(t(log.diffSnapshots(s2, s3)), ['ждём с: 17.09.2026 → 18.09.2026']);
  const s4 = snap('# A\n- [/] Смета [взята:: 2026-09-16]\n');
  assert.deepEqual(t(log.diffSnapshots(s3, s4)), ['статус: Ожидание ответа → В работе']);
});

test('«вернуться до» раньше «ждём с» стирается при ручной правке', () => {
  const w = md.parseTaskLine('- [?] A [ждём с:: 2026-09-17]');
  const bad = md.applyPatch(w, { deadline: '2026-09-16' });
  assert.equal(bad.deadline, ''); assert.equal(bad.rejected, 'deadline');
  const same = md.applyPatch(w, { deadline: '2026-09-17' });
  assert.equal(same.deadline, '2026-09-17'); assert.equal(same.rejected, undefined, 'в тот же день — можно');
  const moved = md.applyPatch(same, { waiting: '2026-09-20' });
  assert.equal(moved.deadline, '', 'перенос «ждём с» позже срока тоже стирает срок'); assert.equal(moved.rejected, 'deadline');
  assert.ok(!md.formatTaskLine(bad).includes('rejected'));
  // правка в файле снаружи — показывается как «Ошибка»
  const ext = md.parseTaskLine('- [?] A [ждём с:: 2026-09-17] [вернуться до:: 2026-09-10]');
  assert.deepEqual(md.validateTask(ext, []), ['Срок «вернуться до» раньше даты «ждём с»']);
});
