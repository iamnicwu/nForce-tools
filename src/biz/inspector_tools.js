/**
 * Inspector Tools —— 从 Salesforce Inspector Reloaded (build/) 移植的四大功能模块
 *
 *  - section-23  SOQL 数据导出（Data Export）
 *  - section-24  批量数据导入（Data Import）
 *  - section-25  Metadata 检索 / 打包下载
 *  - section-26  事件监听（Event Monitor，CometD streaming）
 *
 * 与原版差异：
 *  - 原版 sfConn 基于 cookie + XHR，这里统一改用 src/biz/sf_service.js 的
 *    jsforce 连接（globalConn），会话管理完全复用 nForce-tools 现有逻辑。
 *  - 原版 React UI 改写为本项目的 vanilla JS + antd 风格。
 *  - Event Monitor 的 CometD 库取自 build/general/lib/cometd（已复制到
 *    src/lib/js/cometd），握手 / 订阅 / Replay 逻辑与原版一致。
 */
import { createLogger } from "../common/logger.js";
const logSoql = createLogger("SOQL");
const logImport = createLogger("IMPORT");
const logMeta = createLogger("META");
const logEvent = createLogger("EVENT");
import { sfConn } from "./sf_service.js";
import { appState } from "./state.js";
import { showNotification, escapeHtml } from "../common/utils.js";

const SOQL_MAX_RECORDS = 50000; // Data Export 单次查询的记录数上限（安全阀）
const IMPORT_MAX_BATCH = 10000; // Data Import 单次导入的总行数上限
const EVENT_LOG_MAX = 200;      // Event Monitor 界面最多保留的事件条数

/** 当前生效的 jsforce 连接（连接建立后 sfConn.connection 即被赋值） */
function getConn() {
  const conn = sfConn.connection || null;
  if (!conn) {
    throw new Error("尚未连接 Salesforce，请先在「连接设置」中完成连接");
  }
  return conn;
}

/** 从 describe 结果里挑出可编辑字段列表（过滤掉组合字段等噪音） */
function pickFieldNames(describeResult) {
  return (describeResult.fields || [])
    .map(f => f.name)
    .filter(Boolean);
}

/* ======================================================================
 * section-23  SOQL 数据导出 (Data Export)
 * ==================================================================== */

let soqlRecords = [];
let soqlColumns = [];

/** 懒加载：进入 section-23 时拉取 sObject 列表填充 datalist */
export async function loadSoqlObjects() {
  const datalist = document.getElementById("soql-object-list");
  if (!datalist || datalist.childElementCount > 0) return;
  try {
    const conn = getConn();
    const global = await conn.describeGlobal();
    datalist.innerHTML = global.sobjects
      .map(s => `<option value="${escapeHtml(s.name)}"></option>`)
      .join("");
  } catch (e) {
    logSoql.warn("加载对象列表失败:", e);
  }
}

/** 对象名失焦 / 变化时，加载该对象的字段 datalist 用于 SOQL 补全 */
export async function loadSoqlFields() {
  const objectInput = document.getElementById("soql-object-input");
  const datalist = document.getElementById("soql-field-list");
  if (!objectInput || !datalist) return;
  const objName = objectInput.value.trim();
  if (!objName) { datalist.innerHTML = ""; return; }
  try {
    const conn = getConn();
    const describe = await conn.sobject(objName).describe();
    datalist.innerHTML = pickFieldNames(describe)
      .map(n => `<option value="${escapeHtml(n)}"></option>`)
      .join("");
  } catch (e) {
    logSoql.warn("加载字段列表失败:", e);
  }
}

/** 保存 / 读取查询历史（chrome.storage.local，最多 20 条） */
const SOQL_HISTORY_KEY = "soql_history";
export async function loadSoqlHistory() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get([SOQL_HISTORY_KEY], res =>
        resolve(Array.isArray(res && res[SOQL_HISTORY_KEY]) ? res[SOQL_HISTORY_KEY] : []));
    } catch (e) { resolve([]); }
  });
}
async function saveSoqlHistory(soql) {
  const list = await loadSoqlHistory();
  const next = [soql, ...list.filter(q => q !== soql)].slice(0, 20);
  try { chrome.storage.local.set({ [SOQL_HISTORY_KEY]: next }, () => {}); } catch (e) { /* ignore */ }
  renderSoqlHistory(next);
}
export function renderSoqlHistory(list) {
  const select = document.getElementById("soql-history-select");
  if (!select) return;
  select.innerHTML = `<option value="">-- 查询历史 --</option>` +
    (list || []).map(q => `<option value="${escapeHtml(q)}">${escapeHtml(q.length > 80 ? q.slice(0, 80) + "…" : q)}</option>`).join("");
}

/** 供 app.js 初始化时回填历史下拉 */
export async function initSoqlHistory() {
  renderSoqlHistory(await loadSoqlHistory());
}

/** 执行 SOQL：jsforce query + 自动 queryMore，带记录数上限保护 */
export async function runSoqlQuery() {
  const textarea = document.getElementById("soql-query-input");
  const resultInfo = document.getElementById("soql-result-info");
  const tableHost = document.getElementById("soql-result-table");
  const exportBox = document.getElementById("soql-export-actions");
  const queryAll = document.getElementById("soql-query-all");
  if (!textarea) return;

  const soql = textarea.value.trim().replace(/;\s*$/, "");
  if (!soql) { showNotification("请输入 SOQL 查询语句", "warning"); return; }
  if (!/^select\s/i.test(soql)) { showNotification("只支持 SELECT 查询", "warning"); return; }

  const conn = getConn();
  resultInfo.textContent = "查询中…";
  tableHost.innerHTML = "";
  exportBox.style.display = "none";
  soqlRecords = [];
  soqlColumns = [];

  try {
    const fetcher = queryAll && queryAll.checked ? "queryAll" : "query";
    let result = await conn[fetcher](soql);
    soqlRecords.push(...result.records);
    // queryMore 轮询直到取完（或达到安全上限）
    while (!result.done && soqlRecords.length < SOQL_MAX_RECORDS && result.nextRecordsUrl) {
      result = await conn.request(result.nextRecordsUrl);
      soqlRecords.push(...result.records);
    }

    // 去掉 jsforce 的 attributes 元数据列
    soqlRecords = soqlRecords.map(r => { const { attributes, ...rest } = r; return rest; });
    const colSet = new Set();
    soqlRecords.forEach(r => Object.keys(r).forEach(k => colSet.add(k)));
    soqlColumns = [...colSet];

    await saveSoqlHistory(soql);
    renderSoqlResults();
    resultInfo.textContent = `共 ${soqlRecords.length} 条记录` +
      (soqlRecords.length >= SOQL_MAX_RECORDS ? "（已达单次查询上限）" : "");
    if (soqlRecords.length > 0) exportBox.style.display = "flex";
    showNotification(`查询完成，共 ${soqlRecords.length} 条记录`, "success");
  } catch (e) {
    logSoql.error("查询失败:", e);
    resultInfo.textContent = "";
    showNotification("查询失败：" + (e.message || e), "error");
  }
}

/** 结果表格渲染（与现有 unified-table 风格一致的轻量实现） */
export function renderSoqlResults() {
  const tableHost = document.getElementById("soql-result-table");
  if (!tableHost) return;
  if (!soqlRecords.length) { tableHost.innerHTML = ""; return; }
  const maxRows = 500; // 界面最多渲染 500 行，导出不受影响
  const head = `<thead><tr>${soqlColumns.map(c =>
    `<th style="padding:8px 12px;background:var(--bg-tertiary);border-bottom:1px solid var(--border-color);font-weight:500;color:var(--text-secondary);font-size:var(--fs-sm);white-space:nowrap;text-align:left;">${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${soqlRecords.slice(0, maxRows).map(r =>
    `<tr>${soqlColumns.map(c =>
      `<td style="padding:6px 12px;border-bottom:1px solid var(--border-light);font-size:var(--fs-sm);white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(String(r[c] ?? ""))}">${escapeHtml(String(r[c] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody>`;
  tableHost.innerHTML = `<div style="overflow:auto;max-height:480px;">
        <table style="border-collapse:collapse;min-width:100%;">${head}${body}</table>
    </div>
    ${soqlRecords.length > maxRows ? `<p style="color:var(--text-secondary);font-size:var(--fs-xs);margin-top:8px;">表格仅预览前 ${maxRows} 行，导出将包含全部 ${soqlRecords.length} 行。</p>` : ""}`;
}

/** 导出查询结果：xlsx 直接下载，csv 手工拼装（避免公式注入风险） */
export function exportSoqlResults(format) {
  if (!soqlRecords.length) { showNotification("没有可导出的数据，请先执行查询", "warning"); return; }
  try {
    if (format === "xlsx") {
      const ws = XLSX.utils.json_to_sheet(soqlRecords, { header: soqlColumns });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Result");
      XLSX.writeFile(wb, `soql_export_${Date.now()}.xlsx`);
    } else {
      const escCell = v => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [soqlColumns.join(",")]
        .concat(soqlRecords.map(r => soqlColumns.map(c => escCell(r[c])).join(",")))
        .join("\r\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `soql_export_${Date.now()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    showNotification("导出成功", "success");
  } catch (e) {
    logSoql.error("导出失败:", e);
    showNotification("导出失败：" + (e.message || e), "error");
  }
}

/* ======================================================================
 * section-24  批量数据导入 (Data Import)
 * ==================================================================== */

const importState = {
  rows: [],        // 原始行（含表头键）
  columns: [],     // 文件列名
  objectName: "",
  describe: null,  // 对象 describe 结果
  mapping: {},     // 文件列 -> SF 字段 API 名
  op: "insert",
  extIdField: ""
};

/** 选择文件后解析（.csv / .xlsx 均走 XLSX 解析，保持零新增依赖） */
export async function handleImportFileChange(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
    showNotification("请上传 CSV 或 Excel 文件", "error");
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", raw: false });
    const sheetName = wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
    if (!rows.length) { showNotification("文件中没有数据行", "error"); return; }
    if (rows.length > IMPORT_MAX_BATCH) { showNotification(`单次最多导入 ${IMPORT_MAX_BATCH} 行`, "error"); return; }
    importState.rows = rows;
    importState.columns = Object.keys(rows[0]);
    document.getElementById("import-file-info").textContent =
      `${file.name} · ${importState.columns.length} 列 · ${rows.length} 行`;
    renderImportMapping();
    showNotification("文件解析成功，请确认字段映射", "success");
  } catch (e) {
    logImport.error("文件解析失败:", e);
    showNotification("文件解析失败：" + (e.message || e), "error");
  }
}

/** 对象名变化时重新 describe 并刷新映射下拉 */
export async function handleImportObjectChange() {
  const objectInput = document.getElementById("import-object-input");
  if (!objectInput) return;
  const objName = objectInput.value.trim();
  importState.objectName = objName;
  importState.describe = null;
  if (!objName) { renderImportMapping(); return; }
  try {
    const conn = getConn();
    importState.describe = await conn.sobject(objName).describe();
    renderImportMapping();
  } catch (e) {
    showNotification("对象描述获取失败：" + (e.message || e), "error");
  }
}

/** 渲染列映射表：文件每列一个下拉，默认同名自动匹配 */
export function renderImportMapping() {
  const host = document.getElementById("import-mapping-container");
  const wrapper = document.getElementById("import-mapping-wrapper");
  if (!host || !wrapper) return;
  if (!importState.columns.length) { wrapper.style.display = "none"; host.innerHTML = ""; return; }
  wrapper.style.display = "block";

  const sfFields = importState.describe
    ? (importState.describe.fields || []).map(f => ({ name: f.name, label: f.label, type: f.type, nillable: f.nillable }))
    : [];
  const op = document.getElementById("import-op-select").value;
  const needExtId = op === "upsert";
  const extIdHtml = needExtId ? `
        <div class="form-group" style="margin-bottom: 1rem;">
            <label style="display:block;margin-bottom:0.5rem;font-weight:500;">External ID 字段（upsert 必填）</label>
            <select id="import-extid-field" class="ant-input" style="max-width:360px;">
                <option value="Id">Id</option>
                ${sfFields.filter(f => f.nillable === false).map(f => `<option value="${escapeHtml(f.name)}">${escapeHtml(f.name)} (${escapeHtml(f.label)})</option>`).join("")}
            </select>
        </div>` : "";

  // 默认映射：文件列名与字段 API 名相同（忽略大小写）即自动匹配
  importState.mapping = {};
  const fieldNames = sfFields.map(f => f.name);
  importState.columns.forEach(col => {
    const hit = fieldNames.find(n => n.toLowerCase() === col.toLowerCase());
    if (hit) importState.mapping[col] = hit;
  });

  host.innerHTML = `
        ${extIdHtml}
        <div style="overflow:auto;max-height:320px;border:1px solid var(--border-color);border-radius:4px;">
            <table style="width:100%;border-collapse:collapse;">
                <thead><tr>
                    <th style="padding:8px 12px;background:var(--bg-tertiary);border-bottom:1px solid var(--border-color);text-align:left;font-weight:500;">文件列</th>
                    <th style="padding:8px 12px;background:var(--bg-tertiary);border-bottom:1px solid var(--border-color);text-align:left;font-weight:500;">Salesforce 字段</th>
                    <th style="padding:8px 12px;background:var(--bg-tertiary);border-bottom:1px solid var(--border-color);text-align:left;font-weight:500;">示例值</th>
                </tr></thead>
                <tbody>
                ${importState.columns.map(col => {
                  const sample = String(importState.rows[0][col] ?? "");
                  const options = sfFields.length
                    ? [`<option value="">-- 忽略该列 --</option>`]
                      .concat(sfFields.map(f =>
                        `<option value="${escapeHtml(f.name)}" ${importState.mapping[col] === f.name ? "selected" : ""}>${escapeHtml(f.name)} (${escapeHtml(f.label)})</option>`))
                      .join("")
                    : `<option value="${escapeHtml(col)}">${escapeHtml(col)}（连接后自动识别字段）</option>`;
                  return `<tr>
                        <td style="padding:6px 12px;border-bottom:1px solid var(--border-light);font-size:var(--fs-sm);">${escapeHtml(col)}</td>
                        <td style="padding:6px 12px;border-bottom:1px solid var(--border-light);font-size:var(--fs-sm);">
                            <select class="ant-input import-mapping-select" data-column="${escapeHtml(col)}" style="width:100%;">${options}</select>
                        </td>
                        <td style="padding:6px 12px;border-bottom:1px solid var(--border-light);font-size:var(--fs-sm);color:var(--text-secondary);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(sample)}</td>
                    </tr>`;
                }).join("")}
                </tbody>
            </table>
        </div>`;

  host.querySelectorAll(".import-mapping-select").forEach(sel => {
    sel.addEventListener("change", () => {
      const col = sel.getAttribute("data-column");
      if (sel.value) importState.mapping[col] = sel.value;
      else delete importState.mapping[col];
    });
  });
}

/** 按映射把原始行转换成 Salesforce 记录数组 */
function buildImportRecords() {
  const usedCols = importState.columns.filter(c => importState.mapping[c]);
  return importState.rows.map(row => {
    const rec = {};
    usedCols.forEach(col => {
      let v = row[col];
      if (v === "") v = null;
      rec[importState.mapping[col]] = v;
    });
    return rec;
  });
}

/** 执行导入：分批调用 jsforce，聚合每条记录结果 */
export async function runDataImport() {
  const resultHost = document.getElementById("import-result-container");
  const resultInfo = document.getElementById("import-result-info");
  const runBtn = document.getElementById("run-import-btn");
  if (!importState.rows.length) { showNotification("请先上传数据文件", "warning"); return; }
  if (!importState.objectName) { showNotification("请输入目标对象 API 名称", "warning"); return; }
  if (!importState.describe) { showNotification("请先获取对象字段描述", "warning"); return; }
  const op = document.getElementById("import-op-select").value;
  const batchSize = Math.max(1, Math.min(200, parseInt(document.getElementById("import-batch-size").value, 10) || 200));
  const extIdField = (document.getElementById("import-extid-field") || {}).value || "Id";

  const records = buildImportRecords();
  if (!records.length || !Object.keys(records[0]).length) {
    showNotification("字段映射为空，请至少映射一列", "warning");
    return;
  }
  // delete 操作只需要 Id
  if (op === "delete" && !records[0].hasOwnProperty("Id")) {
    showNotification("delete 操作的文件必须包含映射到 Id 的列", "warning");
    return;
  }

  const conn = getConn();
  runBtn.disabled = true;
  resultInfo.textContent = "执行中… 0%";
  resultHost.innerHTML = "";

  const sobj = conn.sobject(importState.objectName);
  const results = [];
  let processed = 0;
  const startTime = Date.now();

  try {
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      let batchResults;
      if (op === "insert") batchResults = await sobj.insert(batch, { allowRecursive: true });
      else if (op === "update") batchResults = await sobj.update(batch, { allowRecursive: true });
      else if (op === "upsert") batchResults = await sobj.upsert(batch, extIdField, { allowRecursive: true });
      else if (op === "delete") batchResults = await sobj.destroy(batch.map(r => r.Id), { allowRecursive: true });
      else throw new Error("未知操作类型：" + op);
      (Array.isArray(batchResults) ? batchResults : [batchResults]).forEach((r, idx) => {
        results.push({
          row: i + idx + 1,
          id: (r && (r.id || r.Id)) || "",
          success: !!(r && r.success),
          errors: r && Array.isArray(r.errors) ? r.errors.map(e => (e && (e.message || e.errorCode)) || String(e)).join("; ") : (r && !r.success ? String(r.message || JSON.stringify(r.errors || r)) : "")
        });
      });
      processed += batch.length;
      resultInfo.textContent = `执行中… ${Math.round(processed / records.length * 100)}%（${processed}/${records.length}）`;
    }

    const okCount = results.filter(r => r.success).length;
    const failResults = results.filter(r => !r.success);
    resultInfo.textContent = `完成：成功 ${okCount} 条，失败 ${failResults.length} 条，耗时 ${Math.round((Date.now() - startTime) / 1000)} 秒`;
    renderImportErrors(failResults);
    showNotification(`导入完成：成功 ${okCount}，失败 ${failResults.length}`, failResults.length ? "warning" : "success");
  } catch (e) {
    logImport.error("执行失败:", e);
    resultInfo.textContent = "执行失败";
    showNotification("导入失败：" + (e.message || e), "error");
  } finally {
    runBtn.disabled = false;
  }
}

let importFailResults = [];
function renderImportErrors(fails) {
  const resultHost = document.getElementById("import-result-container");
  importFailResults = fails;
  if (!fails.length) { resultHost.innerHTML = ""; return; }
  resultHost.innerHTML = `
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
            <button type="button" id="export-import-errors-btn" class="ant-btn ant-btn-default ant-btn-sm">
                <i class="fas fa-file-excel"></i> 导出失败明细
            </button>
        </div>
        <div style="overflow:auto;max-height:360px;border:1px solid var(--error-border);border-radius:4px;">
            <table style="width:100%;border-collapse:collapse;">
                <thead><tr>
                    <th style="padding:8px 12px;background:var(--error-bg);border-bottom:1px solid var(--error-border);text-align:left;font-weight:500;">行号</th>
                    <th style="padding:8px 12px;background:var(--error-bg);border-bottom:1px solid var(--error-border);text-align:left;font-weight:500;">记录 ID</th>
                    <th style="padding:8px 12px;background:var(--error-bg);border-bottom:1px solid var(--error-border);text-align:left;font-weight:500;">错误信息</th>
                </tr></thead>
                <tbody>${fails.slice(0, 300).map(r =>
                  `<tr>
                        <td style="padding:6px 12px;border-bottom:1px solid var(--border-light);font-size:var(--fs-sm);">${r.row}</td>
                        <td style="padding:6px 12px;border-bottom:1px solid var(--border-light);font-size:var(--fs-sm);">${escapeHtml(r.id)}</td>
                        <td style="padding:6px 12px;border-bottom:1px solid var(--border-light);font-size:var(--fs-sm);color:var(--error-strong);">${escapeHtml(r.errors)}</td>
                    </tr>`).join("")}</tbody>
            </table>
        </div>
        ${fails.length > 300 ? `<p style="color:var(--text-secondary);font-size:var(--fs-xs);margin-top:8px;">表格仅展示前 300 条失败记录，导出包含全部。</p>` : ""}`;
  document.getElementById("export-import-errors-btn").addEventListener("click", exportImportErrors);
}

function exportImportErrors() {
  if (!importFailResults.length) return;
  const ws = XLSX.utils.json_to_sheet(importFailResults);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Errors");
  XLSX.writeFile(wb, `import_errors_${Date.now()}.xlsx`);
  showNotification("失败明细已导出", "success");
}

/* ======================================================================
 * section-25  Metadata 检索 / 打包下载
 * ==================================================================== */

let metadataListResults = [];

/** 拉取 Metadata API 类型清单（describe）填充下拉 */
export async function loadMetadataTypes() {
  const select = document.getElementById("metadata-type-select");
  if (!select) return;
  try {
    const conn = getConn();
    const res = await conn.metadata.describe(appState.metadata_api_version || undefined);
    const types = res.metadataObjects
      .filter(t => t.xmlName)
      .sort((a, b) => a.xmlName.localeCompare(b.xmlName));
    select.innerHTML = types.map(t =>
      `<option value="${escapeHtml(t.xmlName)}">${escapeHtml(t.xmlName)}${t.inFolder ? "（按文件夹）" : ""}</option>`).join("");
    showNotification(`已加载 ${types.length} 种 Metadata 类型`, "success");
  } catch (e) {
    logMeta.error("类型加载失败:", e);
    showNotification("Metadata 类型加载失败：" + (e.message || e), "error");
  }
}

/** 按类型列出成员（相当于 Setup 里的组件清单） */
export async function listMetadataMembers() {
  const select = document.getElementById("metadata-type-select");
  const folderInput = document.getElementById("metadata-folder-input");
  const infoEl = document.getElementById("metadata-list-info");
  const tableHost = document.getElementById("metadata-members-table");
  if (!select || !select.value) { showNotification("请先加载并选择 Metadata 类型", "warning"); return; }
  const query = [{ type: select.value }];
  if (folderInput && folderInput.value.trim()) query[0].folder = folderInput.value.trim();

  try {
    const conn = getConn();
    infoEl.textContent = "检索中…";
    tableHost.innerHTML = "";
    let res = await conn.metadata.list(query);
    if (!Array.isArray(res)) res = res ? [res] : [];
    metadataListResults = res;
    if (!res.length) {
      infoEl.textContent = "该类型下没有找到组件";
      return;
    }
    infoEl.textContent = `共 ${res.length} 个组件`;
    const cols = ["fullName", "type", "createdByName", "lastModifiedByName", "lastModifiedDate"];
    const head = `<tr>${cols.map(c => `<th style="padding:8px 12px;background:var(--bg-tertiary);border-bottom:1px solid var(--border-color);font-weight:500;color:var(--text-secondary);font-size:var(--fs-sm);text-align:left;">${c}</th>`).join("")}</tr>`;
    const body = res.slice(0, 300).map(r =>
      `<tr>${cols.map(c =>
        `<td style="padding:6px 12px;border-bottom:1px solid var(--border-light);font-size:var(--fs-sm);white-space:nowrap;">${escapeHtml(String(r[c] ?? ""))}</td>`).join("")}</tr>`).join("");
    tableHost.innerHTML = `<div style="overflow:auto;max-height:400px;border:1px solid var(--border-color);border-radius:4px;">
            <table style="border-collapse:collapse;min-width:100%;">${head}${body}</table>
        </div>
        ${res.length > 300 ? `<p style="color:var(--text-secondary);font-size:var(--fs-xs);margin-top:8px;">仅预览前 300 行（下载仍包含全部 ${res.length} 个组件）。</p>` : ""}`;
  } catch (e) {
    logMeta.error("成员检索失败:", e);
    infoEl.textContent = "";
    showNotification("成员检索失败：" + (e.message || e), "error");
  }
}

/** 打包下载：retrieve({unpackaged}) → 轮询 checkRetrieveStatus → zip 直接保存 */
export async function retrieveMetadataPackage() {
  const select = document.getElementById("metadata-type-select");
  const statusEl = document.getElementById("metadata-retrieve-status");
  const btn = document.getElementById("metadata-retrieve-btn");
  if (!select || !select.value) { showNotification("请先选择 Metadata 类型", "warning"); return; }
  const typeName = select.value;

  // 成员来源：已执行过 list 则用清单；否则要求用户手填
  let members = [];
  const manualInput = document.getElementById("metadata-members-input");
  if (manualInput && manualInput.value.trim()) {
    members = manualInput.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  } else if (metadataListResults.length) {
    members = metadataListResults.map(r => r.fullName);
    // folder 类型的包需要在成员里带目录名，如 Report/MyFolder
  } else {
    showNotification("请先「检索成员」，或在输入框手动填写组件 FullName", "warning");
    return;
  }
  if (!members.length) { showNotification("没有可下载的组件", "warning"); return; }

  const conn = getConn();
  btn.disabled = true;
  statusEl.textContent = `正在打包 ${members.length} 个组件…`;

  try {
    // 分批 retrieve：单次包太大容易被限制，500 个一批再本地合并
    const BATCH = 500;
    const blobs = [];
    for (let i = 0; i < members.length; i += BATCH) {
      const chunk = members.slice(i, i + BATCH);
      const req = {
        unpackaged: { types: [{ name: typeName, members: chunk }], version: (appState.metadata_api_version || "59.0") }
      };
      const asyncResultId = await conn.metadata.retrieve(req);
      let status;
      let waited = 0;
      while (true) {
        status = await conn.metadata.checkRetrieveStatus(asyncResultId.id, true);
        if (status.done === "true" || status.done === true) break;
        await new Promise(r => setTimeout(r, 2000));
        waited += 2;
        statusEl.textContent = `打包中…（第 ${Math.floor(i / BATCH) + 1} 批，已等待 ${waited} 秒）`;
        if (waited > 300) throw new Error("打包超时（超过 5 分钟）");
      }
      if (status.errorMessage) throw new Error(status.errorMessage);
      blobs.push(status.zipFile); // base64
      statusEl.textContent = `进度：${Math.min(members.length, i + BATCH)} / ${members.length}`;
    }

    // 单包直接下载；多包用 JSZip 合并成一个 zip
    const files = blobs.map(b => new Uint8Array(atob(b).split("").map(c => c.charCodeAt(0))));
    const finalBuf = files.length === 1 ? files[0] : await mergeZips(files);
    const blob = new Blob([finalBuf], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${typeName}_metadata_${Date.now()}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    statusEl.textContent = `下载完成：${members.length} 个组件`;
    showNotification("Metadata 打包下载完成", "success");
  } catch (e) {
    logMeta.error("打包下载失败:", e);
    statusEl.textContent = "打包失败";
    showNotification("打包下载失败：" + (e.message || e), "error");
  } finally {
    btn.disabled = false;
  }
}

/** 用 JSZip 把多份 zip 解包再重新打包合并 */
async function mergeZips(bufs) {
  const merged = new JSZip();
  for (const buf of bufs) {
    const zip = await JSZip.loadAsync(buf);
    const entries = Object.keys(zip.files);
    for (const name of entries) {
      const file = zip.files[name];
      if (file.dir) continue;
      const content = await file.async("uint8array");
      merged.file(name, content);
    }
  }
  return merged.generateAsync({ type: "uint8array" });
}

/* ======================================================================
 * section-26  事件监听 (Event Monitor)
 * ==================================================================== */

const EVENT_CHANNEL_TYPES = [
  { value: "standardPlatformEvent", label: "标准 Platform Event", prefix: "/event/" },
  { value: "platformEvent", label: "自定义 Platform Event", prefix: "/event/" },
  { value: "customChannel", label: "自定义事件通道", prefix: "/event/" },
  { value: "changeEvent", label: "Change Data Capture", prefix: "/data/" }
];

let eventCometd = null;
let eventSubscription = null;
let eventLog = [];
let eventListening = false;

/** 按类型加载可选事件通道（查询逻辑与 SIR event-monitor 一致，走 Tooling API） */
export async function loadEventChannels() {
  const typeSelect = document.getElementById("event-type-select");
  const channelSelect = document.getElementById("event-channel-select");
  if (!typeSelect || !channelSelect) return;
  const type = typeSelect.value;
  let query;
  if (type === "standardPlatformEvent") {
    query = "SELECT Label, QualifiedApiName, DeveloperName FROM EntityDefinition"
      + " WHERE IsCustomizable = FALSE AND IsEverCreatable = TRUE"
      + " AND QualifiedApiName LIKE '%Event' AND (NOT QualifiedApiName LIKE '%ChangeEvent')"
      + " ORDER BY Label ASC LIMIT 200";
  } else if (type === "platformEvent") {
    query = "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE IsCustomizable = TRUE AND KeyPrefix LIKE 'e%' ORDER BY Label ASC";
  } else if (type === "customChannel") {
    query = "SELECT FullName, MasterLabel FROM PlatformEventChannel ORDER BY DeveloperName";
  } else if (type === "changeEvent") {
    query = "SELECT MasterLabel, SelectedEntity FROM PlatformEventChannelMember WHERE EventChannel = 'ChangeEvents' ORDER BY MasterLabel";
  }
  channelSelect.innerHTML = `<option value="">加载中…</option>`;
  try {
    const conn = getConn();
    const res = await conn.request(`/services/data/v${conn.version}/tooling/query?q=${encodeURIComponent(query)}`);
    let channels = (res.records || []).map(rec => ({
      name: rec.QualifiedApiName || rec.FullName || rec.SelectedEntity || rec.EntityName,
      label: rec.Label || rec.MasterLabel || rec.SelectedEntity || rec.EntityName
    }));
    if (type === "changeEvent") {
      channels = [{ name: "ChangeEvents", label: "所有 Change Events" }].concat(channels);
    }
    if (!channels.length) channels = [{ name: "", label: "（未找到可用通道）" }];
    channelSelect.innerHTML = channels.map(c =>
      `<option value="${escapeHtml(c.name)}">${escapeHtml(c.label)}（${escapeHtml(c.name)}）</option>`).join("");
  } catch (e) {
    logEvent.error("通道加载失败:", e);
    channelSelect.innerHTML = `<option value="">加载失败</option>`;
    showNotification("事件通道加载失败：" + (e.message || e), "error");
  }
}

/** Salesforce Replay 扩展（与 SIR 相同实现），支持 replayId -1/-2/指定位置 */
function cometdReplayExtension() {
  const REPLAY_FROM_KEY = "replay";
  let _cometd, _replay = -1, _channel;
  this.setReplay = function (replay) { _replay = parseInt(replay, 10); };
  this.setChannel = function (channel) { _channel = channel; };
  this.registered = function (name, cometd) { _cometd = cometd; };
  this.incoming = function (message) {
    if (message.channel === _channel && message.data && message.data.event && message.data.event.replayId) {
      _replay = message.data.event.replayId;
    }
  };
  this.outgoing = function (message) {
    if (message.channel === "/meta/subscribe") {
      if (!message.ext) message.ext = {};
      message.ext[REPLAY_FROM_KEY] = { [_channel]: _replay };
    }
  };
}

function renderEventLog() {
  const host = document.getElementById("event-log-container");
  if (!host) return;
  if (!eventLog.length) {
    host.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-secondary);">
            <i class="fas fa-satellite-dish" style="font-size:var(--fs-3xl);margin-bottom:8px;"></i>
            <p>${eventListening ? "正在监听，等待事件到达…" : "尚未开始监听"}</p>
        </div>`;
    return;
  }
  host.innerHTML = eventLog.map((ev, idx) => `
        <div style="border:1px solid var(--border-color);border-radius:4px;margin-bottom:8px;background:var(--bg-tertiary);">
            <div style="padding:6px 12px;border-bottom:1px solid var(--border-light);display:flex;justify-content:space-between;font-size:var(--fs-xs);color:var(--text-secondary);">
                <span>#${ev._replayId} · ${escapeHtml(ev._channel)}</span>
                <span>${escapeHtml(ev._receivedAt)}</span>
            </div>
            <pre style="margin:0;padding:12px;font-size:var(--fs-xs);overflow:auto;max-height:240px;white-space:pre-wrap;word-break:break-all;">${escapeHtml(JSON.stringify(ev._data, null, 2))}</pre>
        </div>`).join("");
  document.getElementById("event-log-count").textContent = `${eventLog.length} 条`;
}

/** 订阅事件通道：CometD 长轮询（与 SIR 相同的握手 / 鉴权方式） */
export function subscribeEventChannel() {
  const channelSelect = document.getElementById("event-channel-select");
  const customInput = document.getElementById("event-custom-channel-input");
  const replayInput = document.getElementById("event-replay-input");
  const statusEl = document.getElementById("event-status");
  if (eventListening) { showNotification("已在监听中，请先停止", "warning"); return; }

  const channelPath = (customInput && customInput.value.trim())
    ? (customInput.value.trim().startsWith("/") ? customInput.value.trim() : "/event/" + customInput.value.trim())
    : (channelSelect && channelSelect.value);
  if (!channelPath) { showNotification("请选择或输入要监听的事件通道", "warning"); return; }

  const conn = getConn();
  const apiVersion = conn.version || "59.0";
  const replayId = replayInput ? parseInt(replayInput.value, 10) : -1;
  if (Number.isNaN(replayId)) { showNotification("Replay Id 必须是整数（-1 / -2 / 具体位置）", "warning"); return; }
  if (replayId === -2 && !window.confirm("Replay Id 为 -2 会重放保留窗口内的所有事件，大事件量时可能影响性能并消耗每日事件配额，确定继续？")) {
    return;
  }

  const cometd = new CometD();
  cometd.configure({
    url: conn.instanceUrl + "/cometd/" + apiVersion,
    requestHeaders: { Authorization: "Bearer " + conn.accessToken },
    appendMessageTypeToURL: false
  });
  cometd.websocketEnabled = false;

  const replayExt = new cometdReplayExtension();
  replayExt.setChannel(channelPath);
  replayExt.setReplay(replayId);
  cometd.registerExtension("SalesforceReplayExtension", replayExt);

  statusEl.textContent = "握手中…";
  cometd.handshake(h => {
    if (!h.successful) {
      statusEl.textContent = "";
      showNotification("CometD 握手失败：" + (h.error || "未知错误"), "error");
      return;
    }
    eventCometd = cometd;
    eventSubscription = cometd.subscribe(channelPath, message => {
      eventLog.unshift({
        _channel: channelPath,
        _replayId: message.data && message.data.event ? message.data.event.replayId : "-",
        _receivedAt: new Date().toLocaleTimeString(),
        _data: message.data
      });
      if (eventLog.length > EVENT_LOG_MAX) eventLog.length = EVENT_LOG_MAX;
      renderEventLog();
    }, reply => {
      if (reply.successful) {
        eventListening = true;
        statusEl.textContent = `正在监听 ${channelPath} …`;
        setEventButtons(true);
        renderEventLog();
        showNotification("事件监听已启动", "success");
      } else {
        cometd.disconnect();
        statusEl.textContent = "";
        showNotification("订阅失败：" + (reply.error || "未知错误"), "error");
      }
    });
  });
}

/** 停止监听并断开 CometD 连接 */
export function unsubscribeEventChannel() {
  const statusEl = document.getElementById("event-status");
  if (!eventCometd) return;
  try {
    if (eventSubscription) eventCometd.unsubscribe(eventSubscription);
    eventCometd.disconnect();
  } catch (e) { /* ignore */ }
  eventCometd = null;
  eventSubscription = null;
  eventListening = false;
  if (statusEl) statusEl.textContent = "已停止监听";
  setEventButtons(false);
  renderEventLog();
  showNotification("事件监听已停止", "info");
}

function setEventButtons(listening) {
  const sub = document.getElementById("event-subscribe-btn");
  const unsub = document.getElementById("event-unsubscribe-btn");
  if (sub) sub.disabled = listening;
  if (unsub) unsub.disabled = !listening;
}

export function clearEventLog() {
  eventLog = [];
  renderEventLog();
}

/** 导出事件日志为 JSON 文件 */
export function exportEventLog() {
  if (!eventLog.length) { showNotification("没有事件日志可导出", "warning"); return; }
  const payload = eventLog.map(e => ({ channel: e._channel, replayId: e._replayId, receivedAt: e._receivedAt, data: e._data }));
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `event_log_${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotification("事件日志已导出", "success");
}

/** 通道类型切换时重新拉取通道列表 */
export function onEventTypeChange() {
  const prefix = (EVENT_CHANNEL_TYPES.find(t => t.value === document.getElementById("event-type-select").value) || {}).prefix || "/event/";
  // 自定义 CDC 类型提示通道前缀不同
  document.getElementById("event-prefix-hint").textContent = `通道前缀：${prefix}`;
  loadEventChannels();
}

/* ======================================================================
 * 模块初始化（由 app.js 调用一次）
 * ==================================================================== */

export function initInspectorTools() {
  // 进入对应功能页时懒加载数据（复用项目统一的 nforce:section 事件）
  window.addEventListener("nforce:section", (e) => {
    const section = e.detail && e.detail.section;
    if (section === 23) {
      loadSoqlObjects();
      initSoqlHistory();
    } else if (section === 26) {
      if (!document.getElementById("event-channel-select").childElementCount) {
        loadEventChannels();
      }
    }
  });

  // 导入页：操作类型切换时需要刷新映射区域（upsert 需要外部 ID 输入框）
  const opSelect = document.getElementById("import-op-select");
  if (opSelect) opSelect.addEventListener("change", renderImportMapping);
}
