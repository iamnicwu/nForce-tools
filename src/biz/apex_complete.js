/**
 * Execute Anonymous 输入框的**代码提示**（Apex 语言）。
 *
 * 浮层与键盘交互全在 `biz/code_hint.js`（与 SOQL 查询框共用），这里只提供两样东西：
 *   · `compute`：把光标交给 `common/apex_completions.js` 算出候选（静态词表打底）；
 *   · `enrich`：按需从 org 补数据 —— sObject 名走一次 describeGlobal，
 *     输入 `Account.` 时按需 describe 拿**真实字段**（都缓存在 `sf_service` 里，两处提示共用）。
 *
 * 数据是**后台补齐**的：先弹静态候选，org 数据回来再刷新一屏，用户不用等；
 * 拿不到（未连接 / 权限不足）就继续用静态兜底，不报错、不重试。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("APEXHINT");
import { $ } from "../common/dom.js";
import { completionsFor, applyCompletion } from "../common/apex_completions.js";
import { STANDARD_OBJECTS } from "../common/apex_symbols.js";
import { attachCodeHint } from "./code_hint.js";
import { sfConn } from "./sf_service.js";

/** 从 org 拿到的数据在本模块留一份**同步可读**的镜像（`compute` 必须是同步的） */
const schema = { objects: [], objectsLoaded: false, fields: new Map() };

/** 把 receiver 归一成一个真实 sObject 名（大小写不敏感，优先用 org 里的写法） */
function resolveSObjectName(receiver) {
  if (!receiver) return null;
  const lower = String(receiver).toLowerCase();
  return (
    schema.objects.find((n) => n.toLowerCase() === lower) ||
    Object.keys(STANDARD_OBJECTS).find((n) => n.toLowerCase() === lower) ||
    null
  );
}

/** 初始化（`app.js` 启动时调一次；幂等） */
export function initApexComplete() {
  const textarea = $("apex-code-input");
  if (!textarea) return;

  attachCodeHint(textarea, {
    popupId: "apex-hint",
    log: (msg) => log.debug(msg),
    compute: (text, caret) =>
      completionsFor(text, caret, {
        sObjects: schema.objects,
        objectFields: Object.fromEntries(schema.fields),
        includeSnippets: true
      }),
    applyCompletion,
    enrich: async (ctx) => {
      let changed = false;

      // ① sObject 名（一次请求；失败也会落一个空值，不再重试）
      if (!schema.objectsLoaded) {
        schema.objectsLoaded = true;
        const { names } = await sfConn.listSObjectNames();
        if (names.length) {
          schema.objects = names;
          changed = true;
        }
      }

      // ② 当前接收者的字段（按对象缓存，缓存在 service 层，SOQL 提示也吃这份）
      const objectName = resolveSObjectName(ctx && ctx.receiver);
      if (objectName && !schema.fields.has(objectName)) {
        const fields = await sfConn.listObjectFields(objectName);
        if (fields.length) {
          schema.fields.set(objectName, fields);
          changed = true;
        }
      }
      return changed;
    }
  });

  log.debug("Execute Anonymous 的代码提示已就绪");
}
