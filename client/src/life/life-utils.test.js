import test from 'node:test';
import assert from 'node:assert/strict';

// 真实调用形态必须被钉住：生产代码传的是 item => dateLabel(item.createdAt)，
// 所以这里 import 真的 dateLabel，而不是自己造一个行为不同的 lambda。
import { dateLabel } from '../chat/message-utils.js';

import {
  lifeTemplateLabel,
  lifeGeneratorLabel,
  isProactive,
  sortLifeEvents,
  groupLifeByDay,
  summarizeLife,
  safeFormatTime
} from './life-utils.js';

// R-021 V2①：页面顺序与标签此前没有任何断言——它们只存在于 JSX 里，
// 改动不会有测试变红。这些用例把「用户实际看到的顺序与文案」钉住。

test('lifeTemplateLabel 认识白名单模板，未知 id 原样回显而不抛错', () => {
  assert.equal(lifeTemplateLabel({ templateId: 'revisit' }), '回顾');
  assert.equal(lifeTemplateLabel({ templateId: 'tidy' }), '整理');
  assert.equal(lifeTemplateLabel({ templateId: 'noticing' }), '留意');
  // 未来新增模板时：显示原始 id，不假装认识，也不崩
  assert.equal(lifeTemplateLabel({ templateId: 'future_template' }), 'future_template');
  // 缺标记（不是 life tick 写入的 life 断言）
  assert.equal(lifeTemplateLabel(null), '生活事件');
  assert.equal(lifeTemplateLabel({}), '生活事件');
});

test('lifeGeneratorLabel 如实区分模型/规则/回落，未知值返回 null', () => {
  assert.equal(lifeGeneratorLabel({ generator: 'model' }), '由模型生成');
  assert.equal(lifeGeneratorLabel({ generator: 'rule' }), '按规则生成');
  assert.equal(lifeGeneratorLabel({ generator: 'rule_fallback' }), '模型未就绪，按规则生成');
  assert.equal(lifeGeneratorLabel({ generator: 'mystery' }), null);
  assert.equal(lifeGeneratorLabel(null), null);
});

test('isProactive 读标记而不写死（V2① 阶段恒 false，将来开启自动跟随）', () => {
  assert.equal(isProactive({ proactive: true }), true);
  assert.equal(isProactive({ proactive: false }), false);
  assert.equal(isProactive({}), false);
  assert.equal(isProactive(null), false);
});

test('sortLifeEvents 按新→旧排序，而不是依赖上游顺序', () => {
  // server 的 list() 实测不保证顺序，所以顺序由前端自己定。
  const items = [
    { id: 'old', createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'new', createdAt: '2026-09-03T00:00:00.000Z' },
    { id: 'mid', createdAt: '2026-09-02T00:00:00.000Z' }
  ];
  assert.deepEqual(sortLifeEvents(items).map(i => i.id), ['new', 'mid', 'old']);
});

test('sortLifeEvents 不被脏时间戳搅乱（NaN 落到最旧），且不改原数组', () => {
  const items = [
    { id: 'bad', createdAt: 'not-a-date' },
    { id: 'good', createdAt: '2026-09-03T00:00:00.000Z' },
    { id: 'missing' }
  ];
  const snapshot = items.map(i => i.id);
  assert.deepEqual(sortLifeEvents(items).map(i => i.id), ['good', 'bad', 'missing']);
  assert.deepEqual(items.map(i => i.id), snapshot, '原数组必须保持不动');
  assert.deepEqual(sortLifeEvents(null), []);
});

test('groupLifeByDay 按同一天合并，且保持传入顺序', () => {
  // labelOf 收到的是**整条 item**，不是时间字符串。
  // 这条契约曾经写反（实现传 createdAt 字符串、调用方当 item 用），
  // 结果是单元测试全绿而真实页面渲染出「NaN月NaN日」。用例同时钉住调用形态。
  const seen = [];
  const items = [
    { id: 'a', createdAt: '2026-09-03T10:00:00.000Z' },
    { id: 'b', createdAt: '2026-09-03T08:00:00.000Z' },
    { id: 'c', createdAt: '2026-09-02T10:00:00.000Z' }
  ];
  const groups = groupLifeByDay(items, item => {
    seen.push(typeof item);
    return item.createdAt.startsWith('2026-09-03') ? '今天' : '昨天';
  });
  assert.deepEqual(seen, ['object', 'object', 'object'], 'labelOf 必须收到 item 对象');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].day, '今天');
  assert.deepEqual(groups[0].items.map(i => i.id), ['a', 'b']);
  assert.equal(groups[1].day, '昨天');
  assert.deepEqual(groups[1].items.map(i => i.id), ['c']);
});

test('groupLifeByDay 未传 labelOf 时不抛错（回落空标签）', () => {
  const groups = groupLifeByDay([{ id: 'a', createdAt: '2026-09-03T00:00:00.000Z' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].day, '');
});

// --- P1 回归：真实调用形态（item => dateLabel(item.createdAt)）--------------
// 审计发现的盲区：单测此前**从未 import 过 dateLabel**，只用自己的 lambda，
// 于是「实现传 item、调用方按 item 用」的错配与「非法时间串」都测不到。

test('groupLifeByDay + 真实 dateLabel：非法时间串不抛异常，且不污染正常项', () => {
  // 实测澄清：dateLabel 对非法值**不抛**，返回「NaN月NaN日」（见下条断言）。
  // 真正会抛 RangeError 的是 Intl 那一路（formatTime），由 safeFormatTime 兜。
  const items = [
    { id: 'bad', createdAt: 'not-a-date' },
    { id: 'good', createdAt: new Date().toISOString() }
  ];
  let groups;
  assert.doesNotThrow(() => {
    groups = groupLifeByDay(items, item => dateLabel(item?.createdAt));
  });
  assert.equal(groups.length, 2, '脏值自成一组');
  assert.equal(groups[0].items[0].id, 'bad');
  assert.equal(groups[1].day, '今天');
  assert.equal(groups[1].items[0].id, 'good');
});

test('safeFormatTime：Intl 对非法时间抛 RangeError，必须被兜住（否则整应用白屏）', () => {
  // 前置事实：真实 formatTime 的实现就是 Intl.DateTimeFormat.format，
  // 非法时间会抛 RangeError: Invalid time value。
  const intlFormatter = value => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  assert.throws(() => intlFormatter('not-a-date'), RangeError, '前置事实：Intl 对非法时间确实抛错');

  assert.equal(safeFormatTime('not-a-date', intlFormatter), '时间未知', '非法值必须回落到兜底文案');
  assert.equal(safeFormatTime(undefined, intlFormatter), '时间未知');
  // 正常值必须原样透传，不能被兜底吃掉
  const good = new Date().toISOString();
  assert.equal(safeFormatTime(good, intlFormatter), intlFormatter(good));
});

test('safeFormatTime：formatter 缺失或自身抛错时回落，不向外抛', () => {
  assert.equal(safeFormatTime('2026-09-30T00:00:00Z', undefined), '时间未知');
  assert.equal(safeFormatTime('2026-09-30T00:00:00Z', () => { throw new Error('boom'); }), '时间未知');
  assert.equal(safeFormatTime('2026-09-30T00:00:00Z', () => 'Invalid Date'), '时间未知');
  assert.equal(safeFormatTime('2026-09-30T00:00:00Z', () => ''), '时间未知');
  assert.equal(safeFormatTime('x', () => 42), '时间未知', '非字符串结果一律回落');
});

test('groupLifeByDay：labelOf 返回非字符串时回落兜底标签', () => {
  const groups = groupLifeByDay(
    [{ id: 'a', createdAt: '2026-09-03T00:00:00.000Z' }],
    () => undefined
  );
  assert.equal(groups[0].day, '未知日期');
});

test('groupLifeByDay + 真实 dateLabel：缺失 createdAt 不崩（走 today 分支由调用方兜）', () => {
  // 生产代码传的是 item => dateLabel(item?.createdAt)，缺字段时 dateLabel(undefined)
  // 落到 new Date(undefined) —— 这里钉住它至少不抛 RangeError。
  const groups = groupLifeByDay(
    [{ id: 'a', createdAt: new Date().toISOString() }, { id: 'b' }],
    item => dateLabel(item?.createdAt)
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[1].items[0].id, 'b');
});

test('summarizeLife 空列表返回 null（让调用方决定空状态文案）', () => {
  assert.equal(summarizeLife([]), null);
  assert.equal(summarizeLife(null), null);
});

test('summarizeLife 统计总数、最新时间与模型生成条数', () => {
  const items = [
    { createdAt: '2026-09-01T00:00:00.000Z', marker: { generator: 'rule' } },
    { createdAt: '2026-09-03T00:00:00.000Z', marker: { generator: 'model' } },
    { createdAt: '2026-09-02T00:00:00.000Z', marker: { generator: 'model' } }
  ];
  const s = summarizeLife(items);
  assert.equal(s.total, 3);
  assert.equal(s.newest, '2026-09-03T00:00:00.000Z');
  assert.equal(s.modelCount, 2);
});
