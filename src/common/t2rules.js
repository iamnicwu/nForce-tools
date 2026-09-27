/**
 * T-4 / 到期订单规则引擎。
 *
 * `applyExpiryRules` 与 `applyT2Rules` 本来是两个 95% 相同的副本（连注释都一样），
 * 唯一的差别只有两处：
 *   ① 第 4 步用哪个 Sales 覆盖规则（`applySalesOverrideForExpiry` / `applySalesOverride`）；
 *   ② 命中的 action 最终写到哪些列（"Latest Action By"+"Issue Status" / "Action"）。
 * 所以主流程只留一份，把这两处差异参数化。改判定逻辑只需要改一处，
 * 不会再出现"两个函数的行为悄悄漂移"。
 */

/** M1 判定用的 DRC 编号（只读，别在规则函数里改它） */
const M1_CRITERIA = [
  "DRC: [31]", "DRC: [50]", "DRC: [28]", "DRC: [38]",
  "DRC: [34]", "DRC: [40]", "DRC: [57]", "DRC: [58]",
  "DRC: [65]", "DRC: [69]", "DRC: [77]", "DRC: [79]",
];

/** 需要人工介入的关键词（只读） */
const BAND_KEYWORDS = [
  "MANUAL ASSIGNMENT REQUIRED",
  "NOT ALLOW AUTO ASSIGN FOR THIS SB",
  "NO AVAILABLE DP",
  "Speical Handle Order",
];

/**
 * 规则引擎主流程。
 * @param {Array<object>} data 原始行
 * @param {(action: string|null, ctx: object, criteria: string[]) => string|null} salesOverride 第 4 步的 Sales 覆盖规则
 * @param {(row: object, keyIndex: Map, action: string, ctx: object) => void} writeResult 命中 action 时如何落列
 * @returns {Array<object>} 新数组（行对象是原地改的，与原实现一致）
 */
function runRuleEngine(data, { salesOverride, writeResult }) {
  if (!data || data.length === 0) return data;

  const jsonData = [...data];
  // 列名索引按「本行」解析（同结构的相邻行复用），详见 createKeyIndexResolver 的说明
  const indexFor = createKeyIndexResolver();

  jsonData.forEach((row) => {
    const keyIndex = indexFor(row);
    const debugInfo = [];
    const log = (msg) => debugInfo.push(msg);

    // 1. 提取上下文信息
    const ctx = extractContext(row, keyIndex, log);

    log(`[Init] Status='${ctx.status}', Fulfilment='${ctx.fulfillStatus}', RemarkLen=${ctx.fulfillRemark ? ctx.fulfillRemark.length : 0}`);

    // 2. 根据状态评估规则
    let action = evaluateStatusRules(ctx, BAND_KEYWORDS);

    // 3. 如果状态规则未匹配，则根据备注评估规则
    if (!action) {
      action = evaluateRemarkRules(ctx, M1_CRITERIA);
    }

    if (!action) {
      log(`[Info] No Main Rule matched for Status='${ctx.status}', Fulfilment='${ctx.fulfillStatus}'`);
    }

    // 4. 应用 Sales 覆盖规则 (例如 CS 订单、DRC 检测)
    action = salesOverride(action, ctx, M1_CRITERIA);

    // 5. 落列（Debug_Log 无论有没有命中都要写，便于排查"为什么没命中"）
    if (action) {
      writeResult(row, keyIndex, action, ctx);
    }
    setValue(row, keyIndex, "Debug_Log", debugInfo.join(" | "));
  });

  return jsonData;
}

/**
 * 到期订单：把结果写成"Latest Action By" + "Issue Status"。
 * @param {Array<object>} data
 */
export function applyExpiryRules(data) {
  return runRuleEngine(data, {
    salesOverride: applySalesOverrideForExpiry,
    writeResult(row, keyIndex, action) {
      setValue(row, keyIndex, "Latest Action By", action);
      setValue(row, keyIndex, "Issue Status", expiryIssueStatus(action));
    },
  });
}

/**
 * T-4 分析：把结果写成"Action"。
 * @param {Array<object>} data
 */
export function applyT2Rules(data) {
  return runRuleEngine(data, {
    salesOverride: applySalesOverride,
    writeResult(row, keyIndex, action) {
      setValue(row, keyIndex, "Action", action);
    },
  });
}

/**
 * action → Issue Status 的映射（原先内联在 applyExpiryRules 里）
 * @param {string} action
 * @returns {string}
 */
function expiryIssueStatus(action) {
  if (
    action === "COM" || action === "COM(LTS)" || action === "COM(PCD)" ||
    action === "NORA" || action === "FS" || action === "RBS" || action === "N/A"
  ) {
    return "In Progress";
  }
  if (action === "Vicki" || action === "OPS" || action === "Sales" || action === "CS") {
    return "Waiting for user";
  }
  return "Pending";
}

// ==========================================
// 辅助函数
// ==========================================

/**
 * 备注类字段的「包含」判断。
 *
 * `Fulfillment Remark` / `FulfillmentDetail` 在真实数据里可能不是字符串：
 *   - Salesforce 侧：字段为空时 `flattenRecords` 出来是 **null**；
 *   - Excel 侧：`sheet_to_json` 会把纯数字单元格解析成 number。
 * 旧实现直接 `.includes(...)`，碰到这类值就抛 TypeError，**整批订单的分析会中断**
 * （外层只会显示"分析失败"，排查成本很高）。
 *
 * 这里对字符串输入保持与被替换代码**逐字节相同**的语义（`typeof` + 原生 `includes`），
 * 非字符串一律视为"不包含"，把崩溃降级成一个确定的判定结果。
 * 因此这个改动不可能改变任何原本能正常跑通的输入。
 *
 * @param {*} value 待检查的值
 * @param {string} needle 子串
 * @returns {boolean}
 */
function hasText(value, needle) {
  return typeof value === "string" && value.includes(needle);
}

/**
 * 列名归一化（忽略大小写、空格、下划线）
 * @param {*} str
 * @returns {string}
 */
function normalizeKey(str) {
  return String(str).toLowerCase().replace(/[\s_]/g, "");
}

/**
 * 列名索引：把「逻辑列名 → 真实 key」的匹配结果一次性算好
 *
 * 性能说明（2026-09-27）：
 * 原来 getValue / setValue 每次调用都 `Object.keys(row)` 再逐键做 normalize 比较。
 * extractContext 每行调用 getValue 11 次、setValue 2~3 次 → 每行约 14 次键数组分配
 * 加数百次字符串比较，5000 行就是 7 万次数组分配。现在每行只建一次，随后 O(1) 查表。
 *
 * 匹配规则与旧实现逐条对齐，保证行为不变：
 *   getValue：① 精确同名 ② 归一化同名 ③ 归一化 `<name>__c`
 *   setValue：仅忽略大小写（历史上两者规则就不同，这里保持原样）
 *
 * @param {string[]} keys 某一行的键序列
 */
function buildKeyIndex(keys) {
  const exact = new Set(keys);
  const norm = new Map();
  const lower = new Map();
  for (const k of keys) {
    const n = normalizeKey(k);
    if (!norm.has(n)) norm.set(n, k);   // 保留首个出现的 key，与 keys.find 语义一致
    const l = String(k).toLowerCase();
    if (!lower.has(l)) lower.set(l, k);
  }
  return {
    /**
     * 按 getValue 的三段规则解析出真实 key
     * @param {string} name
     * @returns {string|null}
     */
    find(name) {
      if (exact.has(name)) return name;
      const n = normalizeKey(name);
      if (norm.has(n)) return norm.get(n);
      const nc = normalizeKey(name + "__c");
      if (norm.has(nc)) return norm.get(nc);
      return null;
    },
    /**
     * 按 setValue 的规则解析出真实 key（只忽略大小写）
     * @param {string} colName
     * @returns {string|null}
     */
    findForWrite(colName) {
      const l = String(colName).toLowerCase();
      return lower.has(l) ? lower.get(l) : null;
    },
  };
}

/**
 * 返回「按行取列名索引」的解析器。
 *
 * ⚠️ 索引必须按**本行自己的键**来建，不能只用首行的键建一次。
 * 2026-09-27 踩过：曾用 `buildKeyIndex(Object.keys(jsonData[0]))` 建一份全局索引，
 * 于是「首行没有的列，后续所有行都读不到」——
 * 例如首行 `Fulfillment Remark` 为空、后面几行才有值的表（XLSX 上传 + 手工补备注的场景），
 * 后续行的备注规则会**全部静默失效**。旧实现 getValue 每次 `Object.keys(row)`，
 * 天然按行解析，不存在这个问题；缓存索引属于"优化引入的正确性回归"。
 *
 * 现在的做法：以「键序列」为签名，签名相同的相邻行复用同一份索引，否则重建。
 * 同一批 SOQL/工作表数据的列集合一致 → 绝大多数行命中快路径，仍是 O(k) 比较；
 * 列集合一旦不同就立刻回退到正确行为。
 *
 * 注意：签名是**写入 Debug_Log / Action 之前**的快照，因此同一行后续被加了列
 * 不会影响下一行的比较（下一行比较的也是它自己"加列前"的键序列）。
 *
 * @returns {(row: object) => ReturnType<typeof buildKeyIndex>}
 */
function createKeyIndexResolver() {
  let lastKeys = null;
  let lastIndex = null;
  return function indexFor(row) {
    const keys = Object.keys(row);
    if (lastKeys !== null && keys.length === lastKeys.length) {
      let same = true;
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== lastKeys[i]) {
          same = false;
          break;
        }
      }
      if (same) return lastIndex;
    }
    lastKeys = keys;
    lastIndex = buildKeyIndex(keys);
    return lastIndex;
  };
}

function getValue(row, index, ...possibleNames) {
  for (const name of possibleNames) {
    const key = index.find(name);
    if (key) return row[key];
  }
  return null;
}

function setValue(row, index, colName, value) {
  const key = index.findForWrite(colName) || colName;
  row[key] = value;
}

function extractContext(row, index, log) {
  const status = getValue(row, index, "Order Status", "Custom_OrderStatus", "Custom_OrderStatus__c", "Order.Custom_OrderStatus__c");
  const fulfillStatus = getValue(row, index, "Fulfillment Status", "Custom_FulfilmentStatus", "Custom_FulfilmentStatus__c", "Order.Custom_FulfilmentStatus__c");
  const fulfillRemark = getValue(row, index, "Fulfillment Remark", "FulfillmentRemark", "FulfillmentRemark__c");
  const fulfilldetail = getValue(row, index, "FulfillmentDetail", "FulfillmentDetail__c");
  const fulfillId = getValue(row, index, "FulfillmentId__c");
  const orderName = getValue(row, index, "Order Name", "OrderNumber", "Name", "Order.Name");
  const orderNature = getValue(row, index, "Order Nature", "OrderNature", "OrderNature__c", "Order.Order_Nature__c");
  const createdBy = getValue(row, index, "Created By", "CreatedBy", "CreatedById", "Order.CreatedBy.Name");
  const apptId = getValue(row, index, "Appointment ID", "AppointmentId", "Appointment__c", "AppointmentId__c");
  const lob = getValue(row, index, "Order.LOB__c");
  const orderType = lob === "FixedLine" ? "COM(LTS)" : "COM(PCD)";
  

  return { row, status, fulfillStatus, fulfillRemark, fulfilldetail, fulfillId, orderName, orderNature, createdBy, apptId, lob, orderType, log };
}

// ==========================================
// 规则逻辑模块
// ==========================================

function evaluateStatusRules(ctx, bandKeywords) {
  const { status,  fulfillStatus, fulfilldetail, fulfillRemark, fulfillId, apptId, createdBy, orderType, orderNature, lob, log } = ctx;

  if (status === "Ready To Submit") {
    
    if(orderNature === 'Resumption'){
      if(lob === 'FixedLine'){
        log(`[Status Rule 1.1.0] Ready To Submit + Resumption -> N/A`);
        return "N/A";
      }
    }

    if(orderNature === 'Change VAS'){
      if(apptId && !fulfillStatus){
        if(createdBy === "integration.user"){
          log(`[Status Rule 1.1.0.2] Ready To Submit + Change VAS + ApptId -> ${orderType}`);
          return orderType;
        }
        else{
          log(`[Status Rule 1.1.0.3] Ready To Submit + Change VAS + ApptId -> N/A`);
          return "N/A";
        }
      }
    }

    if(fulfillStatus === "Insufficient Cutover Date"){
      log(`[Status Rule 1.1.0.1] Ready To Submit + Insufficient Cutover Date -> Sales`);
      return "Sales";
    }

    if(fulfillStatus === "Address Rejected"){
      log(`[Status Rule 1.1.0.2] Ready To Submit + Address Rejected -> ${orderType}`);
      return orderType;
    }

    if (fulfillStatus === "In Progress" || fulfillStatus === "In Progress-Distributed") {
      if (createdBy != "integration.user") {
        log(`[Status Rule 1.1.1] Ready To Submit + In Progress + CreatedBy(!= integration.user) -> N/A`);
        return "N/A";
      } 
      log(`[Status Rule 1.1.2] Ready To Submit + In Progress + CreatedBy(= integration.user) -> Sales`);
      return orderType;
      
    } 
    if (!fulfillStatus) {
      if(createdBy != "integration.user"){
        log(`[Status Rule 1.2.0] Ready To Submit + Empty Fulfillment -> N/A`);
        return "N/A";
      }
      log(`[Status Rule 1.2.1] Ready To Submit + Empty Fulfillment -> ${orderType}`);
      return orderType;
    } 

    if (fulfillStatus === "Remake Appointment (M1)") {
      if (createdBy != "integration.user") {
        log(`[Status Rule 1.6.1] Ready To Submit + Remake Appt (M1) + CreatedBy(!= integration.user) -> Sales`);
        return "Sales";
      }
      log(`[Status Rule 1.6.2] Ready To Submit + Remake Appt (M1) + CreatedBy(integration.user) -> ${orderType}`);
      return orderType;
    } 

    if (fulfillStatus === "Sales Support Follow-up (M3)") {
      log(`[Status Rule 1.3] Ready To Submit + '${fulfillStatus}' -> ${orderType}`);
      return orderType;
    } 
    if (fulfillStatus === "Inventory Replenishment") {
      log(`[Status Rule 1.4] Ready To Submit + Inventory Replenishment -> F&S`);
      return "F&S";
    } 
    if (fulfillStatus === "Waiting For Inventory" || 
      fulfillStatus === "Inventory Fallout"|| 
      fulfillStatus === "Manual Assign Inventory") {
      
      if (bandKeywords.some(keyword => hasText(fulfillRemark, keyword))) {
        log(`[Remark Rule 1.5.1] INVENTORY FALLOUT + UIM + MANUAL ASSIGNMENT REQUIRED -> BAND`);
        return "BAND";
      }
      else if (hasText(fulfillRemark, "UIM")) {
        if(hasText(fulfillRemark, "SALES FOLLOW-UP)")){
          log(`[Remark Rule 1.5.2] INVENTORY FALLOUT + UIM + SALES FOLLOW-UP -> Sales`);
          return "Sales";
        }
        else if(hasText(fulfillRemark, "504 Gateway Time-out")){
          log(`[Remark Rule 1.5.4] INVENTORY FALLOUT + 504 Gateway Time-out -> NORA`);
          return "NORA";
        }
        log(`[Status Rule 1.5.3] In Progress + Waiting For Inventory + Remark(UIM) -> UIM`);
        return "UIM";
      }
      log(`[Status Rule 1.5] Ready To Submit + Inventory Fallout -> NORA`);
      return "NORA";
    } 
    if (fulfillStatus === "Address Under Review") {
      log(`[Status Rule 1.6] Ready To Submit + Address Under Review -> Sales`);
      return "Sales";
    }
    if(fulfillStatus === "Completed"){
      log(`[Status Rule 1.7] Ready To Submit + '${fulfillStatus}' -> ${orderType}`);
      return orderType;
    }

    if(fulfillStatus === "Appointment Changed (M1)"){
      if (createdBy != "integration.user") {
        log(`[Status Rule 1.9.0] Ready To Submit + '${fulfillStatus}' -> Sales`);
        return "Sales";
      }
      log(`[Status Rule 1.9.1] Ready To Submit + '${fulfillStatus}' -> ${orderType}}`);
      return orderType;
    }

    if(fulfillStatus === "Appointment Changed (M2)"){
      if (createdBy != "integration.user") {
        log(`[Status Rule 1.8.0] Ready To Submit + '${fulfillStatus}' -> N/A`);
        return "N/A";
      }
      log(`[Status Rule 1.8.1] Ready To Submit + '${fulfillStatus}' -> ${orderType}}`);
      return orderType;
    }
    
    if(fulfillStatus === "Number Investigation"){
      log(`[Status Rule 1.10] In Progress + Number Investigation -> F&S`);
      return "F&S";
    }

    if(fulfillStatus === "Inventory ReAppointment"){
      if (createdBy != "integration.user") {
        log(`[Status Rule 1.11.0] Ready To Submit + '${fulfillStatus}' -> N/A`);
        return "N/A";
      }
      log(`[Status Rule 1.11.1] Ready To Submit + '${fulfillStatus}' -> ${orderType}}`);
      return orderType;
    }

    if(fulfillStatus === "DN Inventory Ready"){
      log(`[Status Rule 1.12] Ready To Submit + '${fulfillStatus}' -> N/A`);
      return "N/A";
    }

    if(fulfillStatus === "Cancelled"){
      log(`[Status Rule 1.13] Ready To Submit + '${fulfillStatus}' -> ${orderType}`);
      return orderType;
    }
  } 
  
  if (status === "Amend Requested") {
    if (["Inventory Fallout", "Appointment Changed (M1)", "Remake Appointment (M1)", "Appointment Changed (M2)"].includes(fulfillStatus)) {
      if (createdBy != "integration.user") {
        log(`[Status Rule 2.1] Amend Requested + '${fulfillStatus}' + CreatedBy(!= integration.user) -> N/A`);
        return "N/A";
      }
      log(`[Status Rule 2.2] Amend Requested + '${fulfillStatus}' + CreatedBy(integration.user) -> ${orderType}`);
      return orderType;
    }
    if(fulfillStatus === "In Progress" || fulfillStatus === "In Progress-Distributed"){
      log(`[Status Rule 2.3] Amend Requested + '${fulfillStatus}' -> ${orderType}`);
      return orderType;
    }

    if(fulfillStatus === "Cancelled"){
      log(`[Status Rule 2.5] Amend Requested + '${fulfillStatus}' -> ${orderType}`);
      return orderType;
    }

    if(!fulfillStatus){
      log(`[Status Rule 2.4] Amend Requested + '${fulfillStatus}' -> ${orderType}`);
      return orderType;
    }
  } 
  
  if (status === "In Progress") {

    if(orderNature == 'Resumption'){
      if(lob === 'FixedLine' && !hasText(fulfilldetail, "fallout")){
        log(`[Status Rule 3.0.0] In Progress + Resumption -> N/A`);
        return "N/A";
      }
    }

    if(orderNature === 'Termination'){
      if(fulfillStatus === 'In Progress'){
        if (hasText(fulfillRemark, "ORDER ABORT")) {
          log(`[Remark Rule 3.0.0] NORA updated "ORDER ABORT" -> ${orderType}`);
          return orderType + " - order abort";
        }
        log(`[Status Rule 3.0.1] In Progress + In Progress -> N/A`);
        return "N/A";
      }
    }

    if(orderNature === 'TOO'){
      if(fulfillStatus === 'In Progress'){
        log(`[Status Rule 3.0.2] In Progress + In Progress -> N/A`);
        return "N/A";
      }
    }

    // 逻辑有问题, 后面再睇
    if (fulfillStatus === "In Progress - Fulfillment Data Issue") {
      log(`[Status Rule 3.1.0] In Progress + In Progress - Fulfillment Data Issue -> ${orderType}`);
      return orderType + " - Data issue";
    } 

    if(orderNature === 'Change Owner' || 
      orderNature === 'Change VAS' || 
      orderNature === 'Change TV Campaign only'){
      if(!fulfilldetail){
        log(`[Status Rule 3.0.3] In Progress + emtpy fulfilldetail -> N/A`);
        return "N/A";
      }
    }

    if (!fulfillStatus && !fulfillId) {
      log(`[Status Rule 3.0] In Progress + Empty Fulfillment & FulfillId -> ${orderType}`);
      return orderType;
    } 

    if (!fulfillStatus || !fulfillRemark) {
      log(`[Status Rule 3.1] In Progress + Missing Fulfill/Remark -> ${orderType}`);
      return orderType;
    } 

    if (fulfillStatus === "Appointment Changed (M2)") {
      log(`[Status Rule 3.2.1] In Progress + Appointment Changed (M2) -> N/A`);
      return "N/A";
    } 
    if (fulfillStatus === "F&S Followed") {
      log(`[Status Rule 3.2.2] In Progress + F&S Followed -> N/A`);
      return "N/A";
    } 
    if (fulfillStatus === "Inventory Replenishment") {
      log(`[Status Rule 3.3] In Progress + Inventory Replenishment -> F&S`);
      return "F&S";
    } 
    if (fulfillStatus === "Address Check Sales Follow-up") {
      log(`[Status Rule 3.4] In Progress + Address Check Sales Follow-up -> Sales`);
      return "Sales";
    } 
    if (fulfillStatus === "[F&S] Resources Issues") {
      log(`[Status Rule 3.5] In Progress + [F&S] Resources Issues -> F&S`);
      return "F&S";
    } 
    if (fulfillStatus === "Address Check SB Assigned") {
      log(`[Status Rule 3.5] In Progress + Address Check SB Assigned -> Sales`);
      return "Sales";
    } 
    if (fulfillStatus === "Leased-In Failed") {
      log(`[Status Rule 3.6] In Progress + Leased-In Failed -> Sales`);
      return "Sales";
    } 
    if (fulfillStatus === "Waiting For Inventory" || 
      fulfillStatus === "Inventory Fallout"|| 
      fulfillStatus === "Manual Assign Inventory") {
      
      if (bandKeywords.some(keyword => hasText(fulfillRemark, keyword))) {
          log(`[Remark Rule 3.7.3] INVENTORY FALLOUT + UIM + MANUAL ASSIGNMENT REQUIRED -> BAND`);
          return "BAND";
      }
      else if (hasText(fulfillRemark, "UIM")) {
        if(hasText(fulfillRemark, "SALES FOLLOW-UP)")){
          log(`[Remark Rule 3.7.4] INVENTORY FALLOUT + UIM + SALES FOLLOW-UP -> Sales`);
          return "Sales";
        }
        else if(hasText(fulfillRemark, "504 Gateway Time-out")){
          log(`[Remark Rule 3.7.4.1] INVENTORY FALLOUT + 504 Gateway Time-out -> NORA`);
          return "NORA";
        }
        log(`[Status Rule 3.7.1] In Progress + Waiting For Inventory + Remark(UIM) -> UIM`);
        return "UIM";
      }
      else if (hasText(fulfillRemark, "504 Gateway Time-out")) {
        log(`[Remark Rule 3.7.5] 504 Gateway Time-out -> NORA`);
        return "NORA";
      }
      else if (hasText(fulfillRemark, "OPG updated \"CANCELLED\"")) {
        log(`[Remark Rule 3.7.6] OPG updated \"CANCELLED\" -> ${orderType}`);
        return orderType;
      }
      else if (lob !== "FixedLine"){
        if(hasText(fulfillRemark, "Cable assignment issue")){
          log(`[Remark Rule 3.7.7.1] PCD order + fulfillment status = Inventory Fallout + Cable assignment issue from EOPI`);
          return "OPS";
        }
        log(`[Remark Rule 3.7.7] PCD order + fulfillment status = Inventory Fallout + ${lob}`);
        return "BAND";
      }
      else if(hasText(fulfillRemark, "INVENTORY REPLENISHMENT")){
        log(`[Remark Rule 3.7.8] PCD order + fulfillment status = Waiting For Inventory + INVENTORY REPLENISHMENT`);
        return "N/A";
      }

      log(`[Status Rule 3.7.2] In Progress + Waiting For Inventory -> OPS`);
      return "OPS";
    }
    if(fulfillStatus === "Remake Appointment (M1)"){
      if(createdBy === "integration.user"){
        log(`[Status Rule 3.8.1] In Progress + Remake Appt (M1) + CreatedBy(=== integration.user) -> Sales`);
        return "Sales";
      }
    }
    if(fulfillStatus === "In Progress" || fulfillStatus === "In Progress-Distributed" ){
      if (hasText(fulfillRemark, "ORDER ABORT")) {
        log(`[Remark Rule 3.9.0] NORA updated "ORDER ABORT" -> ${orderType}`);
        return orderType + " - order abort";
      }
      log(`[Status Rule 3.9] In Progress + In Progress -> Sales`);
      return "Sales";
    }
    if(fulfillStatus === "Cancelled"){
      log(`[Status Rule 3.10] In Progress + In Progress -> ${orderType}`);
      return orderType;
    }
    if(fulfillStatus === "Decomposed"){
      log(`[Status Rule 3.12] In Progress + Decomposed -> ${orderType}`);
      return orderType;
    }

    if(fulfillStatus === "Inventory ReAppointment"){
      if(createdBy === "integration.user"){
        log(`[Status Rule 3.13.1] In Progress + Inventory ReAppointment + CreatedBy(=== integration.user) -> Sales`);
        return "Sales";
      }
      log(`[Status Rule 3.13.2] In Progress + Inventory ReAppointment + CreatedBy(!= integration.user) -> N/A`);
      return "N/A";
    }
    
  } 
  
  if (status === "In Progress-Fulfilment Completed") {
    if (fulfillStatus === "Completed") {
      log(`[Status Rule 3.3.1] In Progress-Fulfilment Completed + Completed -> N/A`);
      return "N/A";
    }
  } 
  
  if (
    ["Cancel Requested", "Frozen", "Rejected"].includes(status) ||
    fulfillStatus === "In Progress - Fulfillment Data Issue" ||
    (["Appointment Changed (M1)", "Appointment Changed (M2)"].includes(fulfillStatus) && !apptId)
  ) {
    log(`[Status Rule 4] Status='${status}', Fulfilment='${fulfillStatus}', ApptId='${apptId}' -> ${orderType}`);
    return orderType;
  } 
  
  if (["Address Approved", "Address Check SB Assigned"].includes(fulfillStatus)) {
    log(`[Status Rule 5] Fulfilment='${fulfillStatus}' -> Sales`);
    return "Sales";
  }

  return null;
}

function evaluateRemarkRules(ctx, m1Criteria) {
  const { fulfillRemark, status, fulfillStatus, createdBy, orderType, log } = ctx;

  if (typeof fulfillRemark !== "string") return null;

  const remarks = fulfillRemark.split(/\n+(?=\[)/).map((s) => s.trim()).filter(Boolean);
  if (remarks.length === 0) return null;

  const firstRemark = remarks[0];
  const hasM1words = remarks.some((r) => m1Criteria.some((k) => r.includes(k)));

  if (hasM1words) log(`[Info] Found M1 words in remarks`);

  // 1. 根据第一条备注内容判断
  if (firstRemark.includes("CANCELLED")) {
    log(`[Remark Rule 6.1] First Remark(CANCELLED) -> N/A`);
    return "N/A";
  }
  if (firstRemark.includes("RESOURCE USED UP")) {
    log(`[Remark Rule 6.2] First Remark(RESOURCE USED UP) -> F&S`);
    return "F&S";
  }
  if (firstRemark.includes("L2JOB FALLOUT")) {
    log(`[Remark Rule 6.3] First Remark(L2JOB FALLOUT) -> LDAP`);
    return "LDAP";
  }
  if (firstRemark.includes('NORA updated "ORDER ABORT"')) {
    log(`[Remark Rule 6.4] First Remark(NORA updated "ORDER ABORT") -> ${orderType}`);
    return orderType + " - order abort";
  }
  if(firstRemark.includes('VNDP')){
    log(`[Remark Rule 6.5] First Remark(VNDP) -> VNDP`);
    return "VNDP";
  }
  if (firstRemark.includes('updated "L2JOB ISSUED"')) {
    log(`[Remark Rule 6.5] First Remark(updated "L2JOB ISSUED") -> N/A`);
    if (remarks.length > 1) {
      const secondRemark = remarks[1];
      if (secondRemark.includes("2N Status: Rented")) {
        log(`[Remark Rule 6.5.1] Second Remark(2N Status: Rented) -> N/A`);
        return "N/A";
      }
      if (secondRemark.includes("2N Status: Failed")) {
        log(`[Remark Rule 6.5.2] Second Remark(2N Status: Failed) -> Sales`);
        return "Sales";
      }
      if (secondRemark.includes("DRC: [33]")) {
        log(`[Remark Rule 6.5.3] Second Remark(DRC: [33]) -> N/A`);
        return "N/A";
      }
    }
    return "N/A"; // 匹配了外层，直接返回
  }

  // 2. 遍历所有备注寻找匹配
  for (const remark of remarks) {
    if (remark.includes("APPOINTMENT CHANGED")) {
      if (hasM1words && status === "Amend Requested") {
        log(`[Remark Rule 7.1.1] APPOINTMENT CHANGED + M1 words + Amend Requested -> ${orderType}`);
        return orderType;
      }
      if (hasM1words && ["Remake Appointment (M1)", "Remake Appointment (M2)"].includes(fulfillStatus)) {
        log(`[Remark Rule 7.1.2] APPOINTMENT CHANGED + M1 words + Remake Appointment -> Sales`);
        return "Sales";
      }
      if (hasM1words && createdBy === "integration.user") {
        log(`[Remark Rule 7.1.3] APPOINTMENT CHANGED + M1 words + integration.user -> Sales`);
        return "Sales";
      }
      if (remark.includes("Await Sales Follow Up")) {
        log(`[Remark Rule 7.1.4] APPOINTMENT CHANGED + Await Sales Follow Up -> Sales`);
        return "Sales";
      }
      if ((remark.includes("Customer Busy") || remark.includes("await customer")) && remark.includes("TID: true")) {
        log(`[Remark Rule 7.1.5] APPOINTMENT CHANGED + Customer Busy + TID: true -> N/A`);
        return "N/A";
      }
      if (remark.includes("DRC: [21]") || remark.includes("DRC: [22]")) {
        log(`[Remark Rule 7.1.6] APPOINTMENT CHANGED + DRC: [21]/[22] -> N/A`);
        return "N/A";
      }
      if (remark.includes("DRC: [68]")) {
        log(`[Remark Rule 7.1.7] APPOINTMENT CHANGED + DRC: [68] -> FS (Action: N/A)`); 
        return "N/A"; // 原始代码逻辑是 N/A，但 log 写的是 FS，此处保留原始动作 N/A
      }
      if (remark.includes("DRC: [12]")) {
        log(`[Remark Rule 7.1.8] APPOINTMENT CHANGED + DRC: [12] -> N/A`);
        return "N/A";
      }
      if (remark.includes("DRC: [58]")) {
        log(`[Remark Rule 7.1.9] APPOINTMENT CHANGED + DRC: [58] -> Sales`);
        return "Sales";
      }
      if (remark.includes("Customer Busy") && remark.includes("TID: false")) {
        log(`[Remark Rule 7.1.10] APPOINTMENT CHANGED + Customer Busy + TID: false -> N/A`);
        return "N/A";
      }
    }

    if (remark.includes("2N UPDATED") && (remark.includes("2N Status: Failed") || remark.includes("SEE"))) {
      log(`[Remark Rule 7.2] 2N UPDATED + Failed/SEE -> N/A (FS CALL CENTER)`);
      return "N/A";
    }

    if (remark.includes("INVENTORY FALLOUT") || remark.includes("Fallout Reason: Cable assignment issue")) {

      if(remark.includes("ADDRESS CHECK IN PROGRESS")){
        log(`[Remark Rule 7.3.0] INVENTORY FALLOUT + ADDRESS CHECK IN PROGRESS -> F&S`);
        return "F&S";
      }

      if (remark.includes("OPS")) {
        if(fulfillStatus != "Remake Appointment (M1)"){
          log(`[Remark Rule 7.3.1] INVENTORY FALLOUT + OPS -> OPS`);
          return "OPS";
        }
        else{
          log(`[Remark Rule 7.3.1.1] INVENTORY FALLOUT + M1 -> N/A`);
          return "N/A";
        }
      }
      if (remark.includes("ORA-01403: no data found")) {
        log(`[Remark Rule 7.3.2] INVENTORY FALLOUT + ORA-01403 -> ${orderType}`);
        return orderType;
      }
      if (remark.includes("UIM")) {
        if (remark.includes("MANUAL ASSIGNMENT REQUIRED") || remark.includes("NOT ALLOW AUTO ASSIGN FOR THIS SB")) {
          log(`[Remark Rule 7.3.3.1] INVENTORY FALLOUT + UIM + MANUAL ASSIGNMENT REQUIRED -> BAND`);
          return "BAND";
        }
        log(`[Remark Rule 7.3.3] INVENTORY FALLOUT + UIM -> UIM`);
        return "UIM";
      }
      if (remark.includes("BAND")) {
        log(`[Remark Rule 7.3.4] INVENTORY FALLOUT + BAND -> BAND`);
        return "BAND";
      }
    }

    if (remark.includes("PID FALLOUT")) {
      log(`[Remark Rule 7.4] PID FALLOUT -> ${orderType}`);
      return orderType;
    }

    if (remark.includes("RESOURCE USED UP")) {
      log(`[Remark Rule 7.5] RESOURCE USED UP -> F&S`);
      return "F&S";
    }

    if (remark.includes("Fallout Reason: NOSS related issue (VNDP)") || 
    remark.includes("Voice network assignment issue from EIPI (VNDP)") ) {
      log(`[Remark Rule 7.6] NOSS related issue (VNDP) -> VNDP`);
      return "VNDP";
    }

    if (remark.includes("<head><title>504 Gateway Time-out</title></head>")) {
      log(`[Remark Rule 7.7] 504 Gateway Time-out -> NORA`);
      return "NORA";
    }

    // if (remark.includes("ORDER RECEIVED")) {
    //   log(`[Remark Rule 7.8] ORDER RECEIVED -> N/A`);
    //   return "N/A";
    // }
  }

  return null;
}

function applySalesOverrideForExpiry(currentAction, ctx, m1Criteria) {
  const {orderName, createdBy, status, fulfillStatus, fulfillRemark, log } = ctx;
  let finalAction = currentAction;

  // 特例：当 Action 为 Sales 时，做深度 DRC 检查
  if (finalAction === "Sales" && 
    (status === "In Progress" || status === "Ready To Submit") &&
    (fulfillStatus === "In Progress" || fulfillStatus === "In Progress-Distributed" || 
      fulfillStatus === "Remake Appointment (M1)" || fulfillStatus === "Appointment Changed (M2)") &&
      
    typeof fulfillRemark === "string") {

    log(`[Override Info] Validating Sales action with advanced DRC check`);
    const paragraphs = extractDRCParagraphsAdvanced(fulfillRemark);
    
    if ( paragraphs.length > 0) {
      const hasM1words = paragraphs.some((r) => m1Criteria.some((k) => r.includes(k)));
      if (hasM1words) {
        const firstDRC = paragraphs[0];
        
        // 生成正则用来校验 firstDRC 内部是否匹配指定的 DRC
        const m1Numbers = m1Criteria.map(k => k.match(/\d+/)[0]);
        const drcRegex = new RegExp(`DRC:\\s*\\[(${m1Numbers.join('|')})\\]`, 'i');
        const isFirstMatch = drcRegex.test(firstDRC);

        log(`[Override Info] First DRC Paragraph Match: ${isFirstMatch}`);

        if (!isFirstMatch) {
          finalAction = "N/A";
          log(`[Override Rule 9.0] contains M1 DRC but not the first DRC -> Sales -> N/A`);
        }
      }
      else{
        finalAction = "N/A";
        log(`[Override Rule 9.2] contains M1 DRC but not the first DRC -> Sales -> N/A`);
      }
    }else{
      finalAction = "N/A";
      log(`[Override Rule 9.3] does not contain M1 DRC -> N/A`);
    }
  }

  // 特例：当 Action 为 Sales 且 OrderName 以 CS 开头时，重载为 CS
  if (finalAction === "Sales" && orderName && String(orderName).startsWith("CS")) {
    log(`[Override Rule 8] Special Case CS Order -> CS`);
    finalAction = "CS";
  }

  return finalAction;
}

function applySalesOverride(currentAction, ctx, m1Criteria) {
  const {orderName, createdBy, status, fulfillStatus, fulfillRemark, log } = ctx;
  let finalAction = currentAction;

  // 特例：当 Action 为 Sales 时，做深度 DRC 检查
  if (finalAction === "Sales" && 
    (status === "In Progress" || status === "Ready To Submit") &&
    (fulfillStatus === "In Progress" || fulfillStatus === "In Progress-Distributed" || 
      fulfillStatus === "Remake Appointment (M1)" || fulfillStatus === "Appointment Changed (M2)") &&
      
    typeof fulfillRemark === "string") {

    log(`[Override Info] Validating Sales action with advanced DRC check`);
    const paragraphs = extractDRCParagraphsAdvanced(fulfillRemark);
    
    if ( paragraphs.length > 0) {
      const hasM1words = paragraphs.some((r) => m1Criteria.some((k) => r.includes(k)));
      if (hasM1words) {
        const firstDRC = paragraphs[0];
        
        // 生成正则用来校验 firstDRC 内部是否匹配指定的 DRC
        const m1Numbers = m1Criteria.map(k => k.match(/\d+/)[0]);
        const drcRegex = new RegExp(`DRC:\\s*\\[(${m1Numbers.join('|')})\\]`, 'i');
        const isFirstMatch = drcRegex.test(firstDRC);

        log(`[Override Info] First DRC Paragraph Match: ${isFirstMatch}`);

        if (!isFirstMatch) {
          finalAction = "N/A";
          log(`[Override Rule 9.0] contains M1 DRC but not the first DRC -> Sales -> N/A`);
        }
        else{
          
        }

        if(createdBy != "integration.user"){
          finalAction = "N/A";
          log(`[Override Rule 9.1] contains M1 DRC and the first DRC -> Sales -> N/A`);
        }
      }
      else{
        finalAction = "N/A";
        log(`[Override Rule 9.2] contains M1 DRC but not the first DRC -> Sales -> N/A`);
      }
    }else{
      finalAction = "N/A";
      log(`[Override Rule 9.3] does not contain M1 DRC -> N/A`);
    }
  }

  // 特例：当 Action 为 Sales 且 OrderName 以 CS 开头时，重载为 CS
  if (finalAction === "Sales" && orderName && String(orderName).startsWith("CS")) {
    log(`[Override Rule 8] Special Case CS Order -> CS`);
    finalAction = "CS";
  }

  return finalAction;
}

/**
 * 高级版本：使用正则表达式精确匹配 drc 段落
 * 段落定义为从包含 drc: [ 的行开始，到空行或文件结束
 */
function extractDRCParagraphsAdvanced(text) {
  if (!text || typeof text !== 'string') return [];

  // 统一换行符
  const normalizedText = text.replace(/\r\n/g, '\n');
  const result = [];
  const lines = normalizedText.split('\n');
  
  let paragraph = [];
  let collecting = false;
  
  for (const line of lines) {
    if (line.includes('DRC: [')) {
      if (collecting && paragraph.length > 0) {
        result.push(paragraph.join('\n'));
        paragraph = [];
      }
      collecting = true;
      paragraph.push(line);
    } else if (line.trim() === '') {
      if (collecting && paragraph.length > 0) {
        result.push(paragraph.join('\n'));
        paragraph = [];
        collecting = false;
      }
    } else if (collecting) {
      paragraph.push(line);
    }
  }
  
  if (collecting && paragraph.length > 0) {
    result.push(paragraph.join('\n'));
  }
  
  return result;
}