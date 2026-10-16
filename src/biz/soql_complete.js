/**
 * SOQL 查询框的**代码提示**（`#soql-query-input` 与 Bulk 的 `#bulk-soql-input`）。
 *
 * 浮层与键盘交互全在 `biz/code_hint.js`（与 Execute Anonymous 共用），这里只提供：
 *   · `compute`：交给 `common/soql_completions.js` —— 它会**扫整条语句**找 `FROM <对象>`，
 *     所以"先写 SELECT、回头再选字段"那种写法人也能拿到字段候选（只看光标前面是拿不到的）；
 *   · `enrich`：按需从 org 补对象名与字段（缓存在 `sf_service`，Apex 提示也吃这份）。
 *
 * 同一个 provider 挂到多个输入框上，但**各自一个浮层**（`soql-hint` / `bulk-soql-hint`）——
 * 两个框可能同时存在，共用一个浮层会互相抢位置。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("SOQLHINT");
import { $ } from "../common/dom.js";
import {
  soqlCompletionsFor,
  applyCompletion,
  effectiveObject
} from "../common/soql_completions.js";
import { STANDARD_OBJECTS } from "../common/apex_symbols.js";
import { attachCodeHint } from "./code_hint.js";
import { sfConn } from "./sf_service.js";

/** org 数据的本地镜像（`compute` 同步读它；`enrich` 负责填） */
const schema = { objects: [], objectsLoaded: false, fields: new Map() };

/** 归一成真实对象名：`X.` 前缀或 `FROM X` 里的对象，可能是别名（`FROM Account a` → `a`） */
function resolveTarget(ctx) {
  const name = effectiveObject(ctx);
  if (!name) return null;
  const lower = String(name).toLowerCase();
  return (
    schema.objects.find((n) => n.toLowerCase() === lower) ||
    Object.keys(STANDARD_OBJECTS).find((n) => n.toLowerCase() === lower) ||
    // 别名映射回对象（`FROM Account a` → `a.` 要拿 Account 的字段）
    (ctx && ctx.alias && String(ctx.alias).toLowerCase() === lower ? ctx.objectName : null)
  );
}

function attachTo(textareaId, popupId) {
  const textarea = $(textareaId);
  if (!textarea) return;

  attachCodeHint(textarea, {
    popupId,
    log: (msg) => log.debug(msg),
    compute: (text, caret) =>
      soqlCompletionsFor(text, caret, {
        sObjects: schema.objects,
        objectFields: Object.fromEntries(schema.fields)
      }),
    applyCompletion,
    enrich: async (ctx) => {
      let changed = false;

      if (!schema.objectsLoaded) {
        schema.objectsLoaded = true;
        const { names } = await sfConn.listSObjectNames();
        if (names.length) {
          schema.objects = names;
          changed = true;
        }
      }

      const target = resolveTarget(ctx);
      if (target && !schema.fields.has(target)) {
        const fields = await sfConn.listObjectFields(target);
        if (fields.length) {
          schema.fields.set(target, fields);
          changed = true;
        }
      }
      return changed;
    }
  });
}

/** 初始化（`app.js` 启动时调一次；幂等） */
export function initSoqlComplete() {
  // 主 SOQL 查询框（section-23）与 Bulk 操作里的 SOQL 框
  attachTo("soql-query-input", "soql-hint");
  attachTo("bulk-soql-input", "bulk-soql-hint");
  log.debug("SOQL 查询框的代码提示已就绪");
}
