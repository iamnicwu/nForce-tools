/**
 * 单元测试: src/common/fuzzy.js
 *
 * 这块算法是「全局搜索」的唯一判据来源 —— 排序错了不会报错，只会让用户
 * 想搜的东西排在第八个（甚至搜不到），所以每一档判定都要有断言。
 *
 * 重点覆盖三件事：
 *   ① 四个档位（相同 / 前缀 / 子串 / 子序列）的相对高低；
 *   ② 紧凑化：`t4` 必须命中 `T-4 Outstanding`；
 *   ③ 返回的 positions 是**原串下标**（高亮时不能把连字符一起涂上）。
 */

describe('fuzzy.js - 模糊匹配', () => {
  const { fuzzyScore, bestFieldScore, rankByFuzzy } = require('../src/common/fuzzy.js');

  describe('fuzzyScore() - 档位', () => {
    test('完全相同得满分，且位置覆盖整串（忽略分隔符）', () => {
      const hit = fuzzyScore('t4list', 't4-list');
      expect(hit.score).toBe(1000);
      // 原串是 t4-list（7 个字符）：命中原下标 0,1,3,4,5,6（跳过 2 的连字符）
      expect(hit.positions).toEqual([0, 1, 3, 4, 5, 6]);
    });

    test('前缀 > 子串 > 子序列', () => {
      const prefix = fuzzyScore('out', 'Outstanding T-4');
      const substring = fuzzyScore('stand', 'Outstanding T-4');
      const subsequence = fuzzyScore('otd', 'Outstanding T-4');
      expect(prefix).not.toBeNull();
      expect(substring).not.toBeNull();
      expect(subsequence).not.toBeNull();
      expect(prefix.score).toBeGreaterThan(substring.score);
      expect(substring.score).toBeGreaterThan(subsequence.score);
    });

    test('子串越靠前分越高', () => {
      const head = fuzzyScore('data', 'data 分析工具');
      const tail = fuzzyScore('data', '批量数据处理 data');
      expect(head.score).toBeGreaterThan(tail.score);
    });

    test('紧凑化：t4 命中 T-4 Outstanding，位置是 0 与 2', () => {
      const hit = fuzzyScore('t4', 'T-4 Outstanding');
      expect(hit).not.toBeNull();
      expect(hit.positions).toEqual([0, 2]);
      expect(hit.score).toBeGreaterThanOrEqual(860);
    });

    test('大小写不敏感', () => {
      expect(fuzzyScore('VVIP', 'vvip 客户订单').score).toBe(
        fuzzyScore('vvip', 'VVIP 客户订单').score
      );
    });

    test('中文关键词按字符匹配', () => {
      const hit = fuzzyScore('午餐', '随机挑选午餐');
      expect(hit).not.toBeNull();
      expect(hit.positions).toEqual([4, 5]);
    });

    test('不匹配返回 null（字符集不够时一律 null）', () => {
      expect(fuzzyScore('zzz', 'T-4 Outstanding')).toBeNull();
      expect(fuzzyScore('t4z', 'T-4 Outstanding')).toBeNull();
      // 顺序必须一致：子序列要求按原串先后命中。
      // `out4` 的 o/u/t 都在串里，但 `4` 出现在它们**前面** → 仍然不匹配。
      expect(fuzzyScore('out4', 'T-4 Outstanding')).toBeNull();
    });

    test('空查询对任何文本都得 0 分（表示"全部保留"）', () => {
      expect(fuzzyScore('', '任意文本')).toEqual({ score: 0, positions: [] });
      expect(fuzzyScore('   ', '任意文本')).toEqual({ score: 0, positions: [] });
    });

    test('空文本不匹配（空查询除外）', () => {
      expect(fuzzyScore('a', '')).toBeNull();
      expect(fuzzyScore('a', null)).toBeNull();
    });
  });

  describe('bestFieldScore() - 多字段取最优', () => {
    const fields = [
      { text: 'T-4 Outstanding', weight: 1 },
      { text: 'T-4 connectivity 清单', weight: 0.45 }
    ];

    test('命中标题时记录命中的是哪个字段', () => {
      const best = bestFieldScore('outstanding', fields);
      expect(best.field).toBe(fields[0]);
      expect(best.positions.length).toBe('outstanding'.length);
    });

    test('只有描述命中时也要能命中（权重低但不为 0）', () => {
      const best = bestFieldScore('connectivity', fields);
      expect(best.field).toBe(fields[1]);
    });

    test('全都不命中返回 null', () => {
      expect(bestFieldScore('zzz', fields)).toBeNull();
    });

    test('weight <= 0 的字段被跳过', () => {
      expect(bestFieldScore('abc', [{ text: 'abc', weight: 0 }])).toBeNull();
    });
  });

  describe('rankByFuzzy() - 排序', () => {
    const items = [
      { label: 'Bulk 操作', desc: '批量作业管理' },
      { label: 'T-4 Outstanding', desc: 'T-4 connectivity 清单' },
      { label: '批量导入', desc: 'CSV/Excel 批量写入' }
    ];
    const fieldsOf = (it) => [
      { text: it.label, weight: 1 },
      { text: it.desc, weight: 0.45 }
    ];

    test('空查询不做重排（调用方靠这个把常用功能排在前面）', () => {
      const hits = rankByFuzzy('', items, fieldsOf);
      expect(hits.map((h) => h.item.label)).toEqual(items.map((i) => i.label));
      expect(hits.every((h) => h.score === 0)).toBe(true);
    });

    test('标题命中排在描述命中前面（同一批条目里）', () => {
      const hits = rankByFuzzy('批量', items, fieldsOf);
      // 「批量导入」是标题命中（前缀，权重 1）；「Bulk 操作」只在描述里出现（权重 0.45）
      expect(hits.map((h) => h.item.label)).toEqual(['批量导入', 'Bulk 操作']);
      expect(hits.map((h) => h.index)).toEqual([2, 0]);
    });

    test('同分时保持原数组顺序（稳定排序 = 常用功能天然优先）', () => {
      const same = [
        { label: '甲功能', desc: '同名描述' },
        { label: '乙功能', desc: '同名描述' }
      ];
      const hits = rankByFuzzy('同名描述', same, fieldsOf);
      expect(hits.map((h) => h.item.label)).toEqual(['甲功能', '乙功能']);
      expect(hits[0].score).toBe(hits[1].score);
    });

    test('标题命中排在描述命中前面', () => {
      const hits = rankByFuzzy('t4', items, fieldsOf);
      expect(hits[0].item.label).toBe('T-4 Outstanding');
    });

    test('不匹配的条目被过滤掉', () => {
      const hits = rankByFuzzy('zzz', items, fieldsOf);
      expect(hits).toEqual([]);
    });

    test('返回的 index 是原数组下标（用于稳定排序与高亮回查）', () => {
      const hits = rankByFuzzy('t4', items, fieldsOf);
      expect(hits.map((h) => h.index)).toEqual([1]);
    });
  });
});
