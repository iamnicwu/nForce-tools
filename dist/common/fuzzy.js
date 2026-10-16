/**
 * 模糊匹配（Spotlight 式搜索的核心算法）
 *
 * ── 为什么单独一个文件、而且零依赖 ──
 *   ① 它是纯函数，能被 jest 直接测（`test/fuzzy.test.js`），不用在 DOM 里验证；
 *   ② 命令面板（`biz/command_palette.js`）要 import 它，而面板也会跑在**注入到客户
 *      Salesforce 页面的贴边浮窗**里 —— 零依赖才不会把 logger / REST 客户端之类的
 *      整条依赖树拖进别人页面。
 *
 * ── 判定分档（从高到低）──
 *   完全相同 > 前缀 > 子串（越靠前分越高）> 子序列（按连贯度与"命中词首"奖励调节）
 *   任何一档都比「不匹配」（返回 null）高，所以调用方只要做一次排序即可。
 *
 * ── 紧凑化（compact）──
 *   所有比较都先做一次"去掉分隔符 + 转小写"：`-` / 空格 / `_` / 括号 / 点号 等
 *   在比较时被跳过。这样 `t4` 能命中 `T-4 Outstanding`（用户不会去敲那个连字符），
 *   而 `lts daily` 里的空格也不会挡住 `LTS 概览`。
 *
 *   **但返回的命中位置始终是原串下标**：`t4` 命中的是 `T`(0) 与 `4`(2)，
 *   中间的 `-` 不会被算进高亮区间 —— 否则搜索框里会出现"高亮盖住连字符"的怪异观感。
 */

/** 比较时视作"词边界"的字符（同时用于 compact 的跳过判定与 isWordStart） */
const SEPARATORS = new Set([
  " ", "\t", "\n", "\r",
  "-", "_", "+", "&", "*", "/", "\\", "|",
  ".", ",", ":", ";", "!", "?", "'", '"', "`",
  "(", ")", "[", "]", "{", "}",
  "（", "）", "【", "】", "《", "》", "、", "·", "，", "。", "：", "；"
]);

function isSeparator(ch) {
  return SEPARATORS.has(ch);
}

/** 字符是否处在"一个词的开头"（原串视角：串首 / 前一个字符是分隔符 / camelCase 边界） */
function isWordStart(src, index) {
  if (index <= 0) return true;
  const prev = src[index - 1];
  if (isSeparator(prev)) return true;
  return /[a-z0-9]/.test(prev) && /[A-Z]/.test(src[index]);
}

/**
 * 紧凑化：去掉分隔符并转小写，同时保留「紧凑串下标 → 原串下标」的映射。
 * @returns {{value: string, map: number[], src: string}}
 */
function compact(text) {
  const src = String(text ?? "");
  const chars = [];
  const map = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (isSeparator(ch)) continue;
    chars.push(ch.toLowerCase());
    map.push(i);
  }
  return { value: chars.join(""), map, src };
}

/** 各档基准分。数值本身不重要，重要的是**档位之间留下足够的间距**，
 *  这样"标签前缀命中"永远排在"描述子串命中"前面，不会被权重抖动翻盘。 */
const SCORE = Object.freeze({
  EQUAL: 1000,
  PREFIX: 860,
  SUBSTRING: 620,
  SUBSTRING_FALLOFF: 6, // 子串每偏离开头一位扣的分
  SUBSTRING_MAX_OFFSET: 10, // 偏移罚分的封顶位数
  SUBSEQUENCE: 320,
  BONUS_WORD_START: 14, // 命中处正好是某个词的开头
  BONUS_CONSECUTIVE: 8, // 与上一个命中相邻
  PENALTY_GAP: 1, // 跳过的字符
  PENALTY_GAP_MAX: 80 // 间隔罚分封顶（否则长描述会被罚到负数）
});

/**
 * 单个字段的匹配得分。
 * @param {string} query 用户的输入
 * @param {string} text 待匹配的文本
 * @returns {{score: number, positions: number[]}|null}
 *          `positions` 是**原串下标**（可含分隔符跳过，见文件头），未命中返回 null。
 *          空查询对任何文本都返回 `{score: 0}`（= 全部保留，排序回落到原顺序）。
 */
export function fuzzyScore(query, text) {
  const q = compact(query);
  if (!q.value) return { score: 0, positions: [] };

  const t = compact(text);
  if (!t.value) return null;

  // ① 完全相同（`t4list` 命中 `t4-list` 也算）
  if (t.value === q.value) return { score: SCORE.EQUAL, positions: t.map.slice() };

  // ② 前缀
  if (t.value.startsWith(q.value)) {
    return { score: SCORE.PREFIX, positions: t.map.slice(0, q.value.length) };
  }

  // ③ 子串（越靠前分越高）
  const at = t.value.indexOf(q.value);
  if (at >= 0) {
    return {
      score: SCORE.SUBSTRING - Math.min(at, SCORE.SUBSTRING_MAX_OFFSET) * SCORE.SUBSTRING_FALLOFF,
      positions: t.map.slice(at, at + q.value.length)
    };
  }

  // ④ 子序列：贪心前进，按"连贯度 + 词首"加减分
  let qi = 0;
  let prev = -1;
  let score = SCORE.SUBSEQUENCE;
  const positions = [];
  for (let ti = 0; ti < t.value.length && qi < q.value.length; ti++) {
    if (t.value[ti] !== q.value[qi]) continue;

    const originalIndex = t.map[ti];
    if (prev >= 0) {
      const gap = ti - prev - 1;
      score += gap === 0
        ? SCORE.BONUS_CONSECUTIVE
        : -Math.min(gap, SCORE.PENALTY_GAP_MAX) * SCORE.PENALTY_GAP;
    }
    if (isWordStart(t.src, originalIndex)) score += SCORE.BONUS_WORD_START;

    positions.push(originalIndex);
    prev = ti;
    qi++;
  }
  if (qi < q.value.length) return null; // 有字符没匹配上

  return { score: Math.max(1, score), positions };
}

/**
 * 多字段取最优：条目通常有「标题 / 描述 / 分组 / id / 别名关键词」多个可匹配字段，
 * 取加权后的最高分，并记录**是哪个字段命中的**（渲染时只有那个字段能高亮）。
 *
 * @param {string} query
 * @param {Array<{text: string, weight: number}>} fields
 * @returns {{score: number, field: object, positions: number[], text: string}|null}
 */
export function bestFieldScore(query, fields) {
  let best = null;
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field || !field.text || !(field.weight > 0)) continue;
    const hit = fuzzyScore(query, field.text);
    if (!hit) continue;
    const score = hit.score * field.weight;
    if (!best || score > best.score) {
      best = { score, field, positions: hit.positions, text: field.text };
    }
  }
  return best;
}

/**
 * 排序版：给一批条目做模糊过滤 + 排序。
 *
 * 空查询**不做任何重排**（按传入顺序原样返回）—— 命令面板依赖这一点把「常用功能」
 * 排在前面：调用方只要按需要的顺序构造数组即可，算法不额外发明顺序。
 *
 * @param {string} query
 * @param {Array} items
 * @param {(item: any) => Array<{text: string, weight: number}>} fieldsOf
 * @returns {Array<{item: any, index: number, score: number, field: object|null,
 *                  positions: number[], text: string}>}
 */
export function rankByFuzzy(query, items, fieldsOf) {
  const list = Array.isArray(items) ? items : [];
  const needle = String(query ?? "").trim();

  if (!needle) {
    return list.map((item, index) => ({
      item, index, score: 0, field: null, positions: [], text: ""
    }));
  }

  const hits = [];
  list.forEach((item, index) => {
    const best = bestFieldScore(needle, fieldsOf(item));
    if (!best) return;
    hits.push({
      item,
      index,
      score: best.score,
      field: best.field,
      positions: best.positions,
      text: best.text
    });
  });

  // 同分时按原顺序（`index`）—— 常用功能/布局顺序因此天然成为 tie-breaker
  hits.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return hits;
}
