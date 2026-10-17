#!/usr/bin/env node
/**
 * 回归用例覆盖检查：**布局里的每个功能都有对应的渲染用例吗？**
 *
 * ── 为什么需要它 ──
 * 2026-10-17 踩到的事：往布局里加了一个磁贴（View Log），却只跑了
 * `--only=log` 这类子集，没跑全量 —— 于是 `tiles: "25"` / `cmdkEntries: "30"`
 * 这类**写死的计数断言**失效了，一直到下一次全量才暴露（中间几轮验证都是"绿"的）。
 * 人的记忆不可靠，所以把"每个磁贴都得有用例"变成一条命令。
 *
 * 检查三件事（都只看静态文本，不起浏览器）：
 *   ① 每个磁贴 id 都能在 panel-shot 里被点到（`data-tile-id='<id>'`）；
 *   ② 每个磁贴的 step 都有用例断言"真的落到这一页"（`expectActive: "section-<step>"`）；
 *   ③ 「公用功能」（布局里 groups[].id === "tools"）额外要求有整页打开 / 一屏锁的用例。
 *
 * 用法：`npm run check:coverage`（夹具目录不存在时只提示、不判红 —— `.workbuddy/`
 * 是本地开发资产，不入库，CI 里没有它）。
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const LAYOUT = path.join(ROOT, "src/rules/ui_layout.json");
const SHOT = path.join(ROOT, ".workbuddy/skills/nforce-ui-verify/assets/panel-shot.mjs");

const read = (p) => fs.readFileSync(p, "utf8");

if (!fs.existsSync(SHOT)) {
  console.log("· 跳过：未找到渲染用例文件（.workbuddy/ 是本地资产、不入库）");
  console.log("  在 CI 里这是正常的；本地跑 `npm run check:coverage` 才有意义。");
  process.exit(0);
}

const layout = JSON.parse(read(LAYOUT));
const shot = read(SHOT);

/** 布局里的全部磁贴 */
const tiles = [];
for (const group of layout.groups || []) {
  for (const tile of group.tiles || []) {
    const step = Number(tile.step);
    if (step > 0 && tile.id) tiles.push({ step, id: tile.id, group: group.id });
  }
}

/** 「公用功能」那一组（点开即整页） */
const toolIds = new Set(
  ((layout.groups || []).find((g) => g && g.id === "tools") || {}).tiles?.map((t) => t.id) || []
);

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

for (const { step, id, group } of tiles) {
  // ① 能被点到
  check(
    shot.includes(`data-tile-id='${id}'`),
    `磁贴 ${id}（section-${step}）没有渲染用例：panel-shot 里找不到 data-tile-id='${id}'`
  );
  // ② 有"落到这一页"的断言
  check(
    shot.includes(`expectActive: "section-${step}"`),
    `磁贴 ${id}（section-${step}）没有落到该页的断言：找不到 expectActive: "section-${step}"`
  );
  // ③ 公用功能还要有整页打开 + 一屏锁的用例
  if (toolIds.has(id)) {
    const hasOpen =
      shot.includes(`createdTabSection: "${step}"`) || shot.includes(`section=${step}`);
    const hasNoScroll = shot.includes(`section=${step}`);
    check(hasOpen, `公用功能 ${id}（section-${step}）缺「侧边栏点开 → 整页打开」的用例`);
    check(hasNoScroll, `公用功能 ${id}（section-${step}）缺「整页下一屏内（?section=${step}）」的用例`);
  }
  if (group === "tools" && id && !shot.includes(`sweep-`) && !shot.includes(`fullpage-`)) {
    problems.push(`公用功能 ${id} 没有任何 sweep/fullpage 用例`);
  }
}

// 布局里有的功能，index.html 里也得真有这个 section（反过来不查：设置类 section 不占磁贴）
const html = read(path.join(ROOT, "src/index.html"));
for (const { step } of tiles) {
  check(
    html.includes(`id="section-${step}"`),
    `布局登记了 section-${step}，但 src/index.html 里没有这个 section`
  );
}

const total = tiles.length;
if (problems.length) {
  console.log(`✗ 回归用例覆盖不足（${problems.length} 处，共 ${total} 个磁贴）\n`);
  for (const p of problems) console.log("  - " + p);
  console.log("\n改完布局记得同步 .workbuddy/skills/nforce-ui-verify/assets/panel-shot.mjs");
  process.exit(1);
}

console.log(`✓ ${total} 个磁贴都有渲染用例（含「落到该页」断言）`);
console.log(`✓ 其中 ${toolIds.size} 个「公用功能」都有整页打开 + 一屏锁的用例`);
process.exit(0);
