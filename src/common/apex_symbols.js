/**
 * Apex 补全用的**词表**（Execute Anonymous 编辑器的代码提示数据源）。
 *
 * ── 为什么自己维护一份 ──
 * Apex 没有可用的 JS 语言服务（官方 Apex Language Server 是 Java 的，跑在本地进程里），
 * 所以"提示什么"这件事只能自己列。这里放的是**写匿名 Apex 时最常用的那一层**：
 * 关键字 / 平台内置类与常用成员 / 常见标准对象与字段 —— 不追求穷举（穷举既不现实也没必要，
 * `System.debug`、`SELECT ... FROM Account`、`Schema.getGlobalDescribe()` 这类才是高频）。
 *
 * ── 它和 org 的关系 ──
 * 静态词表覆盖"语言层"；**"你这个 org 里有什么"**由 `biz/apex_complete.js` 在运行时补：
 *   · sObject 名 → describeGlobal（有连接时懒加载，合并进候选）
 *   · 某个对象的字段 → 输入 `Account.` 时按需 describe 并缓存
 * 静态词表是**兜底**：未连接、加载失败、或用户粘代码进来分析时，提示依然可用。
 *
 * 与 `rules/ui_layout.json` 那种"可配置数据"不同，这份词表是**代码的一部分**（走 JS 模块，
 * 不用 fetch）—— 项目禁止 import JSON（浏览器不支持 JSON 模块），而这里没必要让用户改。
 */

/** Apex 关键字（语言关键字 + 常用 DML/SOQL 关键词 + 日期字面量） */
export const APEX_KEYWORDS = [
  // 声明与修饰
  "abstract", "class", "enum", "extends", "final", "global", "implements", "interface",
  "override", "private", "protected", "public", "static", "testmethod", "transient",
  "virtual", "webservice", "with", "without", "sharing",
  // 语句与控制流
  "break", "catch", "continue", "do", "else", "finally", "for", "if", "instanceof", "new",
  "return", "switch", "throw", "try", "when", "while", "super", "this",
  // 修饰与运算符（写代码时会打）
  "and", "or", "not", "null", "true", "false", "as", "in", "like", "insert", "update",
  "upsert", "delete", "undelete", "merge", "trigger", "before", "after",
  // SOQL / SOSL
  "SELECT", "FROM", "WHERE", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET", "ASC",
  "DESC", "NULLS", "FIRST", "LAST", "FIND", "RETURNING", "TYPEOF", "END",
  // 日期字面量（SOQL 里天天用）
  "TODAY", "YESTERDAY", "TOMORROW", "LAST_WEEK", "THIS_WEEK", "NEXT_WEEK",
  "LAST_MONTH", "THIS_MONTH", "NEXT_MONTH", "LAST_90_DAYS", "NEXT_90_DAYS",
  "THIS_QUARTER", "LAST_QUARTER", "NEXT_QUARTER", "THIS_YEAR", "LAST_YEAR", "NEXT_YEAR",
  "THIS_FISCAL_QUARTER", "LAST_FISCAL_QUARTER", "NEXT_FISCAL_QUARTER",
  "THIS_FISCAL_YEAR", "LAST_FISCAL_YEAR", "NEXT_FISCAL_YEAR"
];

/** 基本类型（也当类型提示用） */
export const APEX_PRIMITIVES = [
  "Blob", "Boolean", "Date", "Datetime", "Decimal", "Double", "Id", "Integer", "Long",
  "Object", "String", "Time"
];

/** 集合类型 */
export const APEX_COLLECTIONS = ["List", "Map", "Set"];

/**
 * 平台内置类与常用成员。
 * `insert` 会带上参数占位（补全后光标落在括号里），`snippet` 是更长的模板。
 */
export const BUILTIN_CLASSES = {
  System: {
    detail: "平台内置类：调试输出、断言、类型转换…",
    members: [
      { name: "debug", signature: "debug(Any)", detail: "写一行调试日志（USER_DEBUG）" },
      { name: "assert", signature: "assert(Boolean)", detail: "条件不成立就抛异常" },
      { name: "assertEquals", signature: "assertEquals(Object, Object)", detail: "断言相等（测试用）" },
      { name: "assertNotEquals", signature: "assertNotEquals(Object, Object)" },
      { name: "isBatch", signature: "isBatch()" },
      { name: "isFuture", signature: "isFuture()" },
      { name: "isQueueable", signature: "isQueueable()" },
      { name: "isScheduled", signature: "isScheduled()" },
      { name: "now", signature: "now()", detail: "当前 Datetime" },
      { name: "today", signature: "today()", detail: "当前 Date" },
      { name: "requestVersion", signature: "requestVersion()" },
      { name: "runAs", signature: "runAs(Map<Id, SObject>, System.AccessLevel)" },
      { name: "setPasswordPolicy", signature: "setPasswordPolicy()" },
      { name: "schedule", signature: "schedule(String, String, Object)" },
      { name: "enqueueJob", signature: "enqueueJob(String, Object)" }
    ]
  },
  Database: {
    detail: "DML 与查询（可控制是否允许部分成功）",
    members: [
      { name: "query", signature: "query(String)", detail: "带绑定变量的动态 SOQL" },
      { name: "queryWithBinds", signature: "queryWithBinds(String, Map<String, Object>)" },
      { name: "getQueryLocator", signature: "getQueryLocator(String)", detail: "大结果集用" },
      { name: "countQuery", signature: "countQuery(String)" },
      { name: "insert", signature: "insert(SObject, Boolean)", detail: "第二个参数 true = 允许部分成功" },
      { name: "update", signature: "update(SObject, Boolean)" },
      { name: "upsert", signature: "upsert(SObject, Schema.SObjectField, Boolean)" },
      { name: "delete", signature: "delete(SObject, Boolean)" },
      { name: "undelete", signature: "undelete(SObject, Boolean)" },
      { name: "executeBatch", signature: "executeBatch(Database.Batchable, Integer)" },
      { name: "getDmlOptions", signature: "getDmlOptions()" },
      { name: "setSavepoint", signature: "setSavepoint()" },
      { name: "rollback", signature: "rollback(Database.Savepoint)" }
    ]
  },
  Schema: {
    detail: "元数据：对象、字段、描述信息",
    members: [
      { name: "getGlobalDescribe", signature: "getGlobalDescribe()", detail: "Map<String, SObjectType>" },
      { name: "getSObjectType", signature: "getSObjectType()" },
      { name: "describeSObjects", signature: "describeSObjects(List<String>)" },
      { name: "SObjectType", signature: "Schema.SObjectType" },
      { name: "SObjectField", signature: "Schema.SObjectField" },
      { name: "DescribeSObjectResult", signature: "Schema.DescribeSObjectResult" },
      { name: "DescribeFieldResult", signature: "Schema.DescribeFieldResult" }
    ]
  },
  JSON: {
    detail: "JSON 序列化 / 反序列化",
    members: [
      { name: "serialize", signature: "serialize(Object)", detail: "对象 → JSON 字符串" },
      { name: "serializePretty", signature: "serializePretty(Object)" },
      { name: "deserialize", signature: "deserialize(String, Type)" },
      { name: "deserializeUntyped", signature: "deserializeUntyped(String)", detail: "→ Map/List" },
      { name: "createParser", signature: "createParser(String)" }
    ]
  },
  Limits: {
    detail: "当前事务的限额用量",
    members: [
      { name: "getQueries", signature: "getQueries()" },
      { name: "getQueryRows", signature: "getQueryRows()" },
      { name: "getDmlStatements", signature: "getDmlStatements()" },
      { name: "getDmlRows", signature: "getDmlRows()" },
      { name: "getCpuTime", signature: "getCpuTime()" },
      { name: "getHeapSize", signature: "getHeapSize()" },
      { name: "getCallouts", signature: "getCallouts()" },
      { name: "getLimitQueries", signature: "getLimitQueries()" }
    ]
  },
  Test: {
    detail: "测试类（匿名 Apex 里也能用 startTest/stopTest）",
    members: [
      { name: "startTest", signature: "startTest()", detail: "重置限额计数" },
      { name: "stopTest", signature: "stopTest()" },
      { name: "isRunningTest", signature: "isRunningTest()" },
      { name: "setMock", signature: "setMock(Type, HttpCalloutMock)" }
    ]
  },
  ApexPages: {
    detail: "Visualforce 页面上下文",
    members: [
      { name: "currentPage", signature: "currentPage()" },
      { name: "addMessage", signature: "addMessage(ApexPages.Message)" },
      { name: "Message", signature: "ApexPages.Message" },
      { name: "StandardController", signature: "ApexPages.StandardController" }
    ]
  },
  Trigger: {
    detail: "触发器上下文（Trigger.new / Trigger.old…）",
    members: [
      { name: "new", signature: "Trigger.new", detail: "新版本记录" },
      { name: "old", signature: "Trigger.old" },
      { name: "newMap", signature: "Trigger.newMap" },
      { name: "oldMap", signature: "Trigger.oldMap" },
      { name: "isBefore", signature: "Trigger.isBefore" },
      { name: "isAfter", signature: "Trigger.isAfter" },
      { name: "isInsert", signature: "Trigger.isInsert" },
      { name: "isUpdate", signature: "Trigger.isUpdate" },
      { name: "isDelete", signature: "Trigger.isDelete" },
      { name: "size", signature: "Trigger.size" }
    ]
  },
  UserInfo: {
    detail: "当前用户",
    members: [
      { name: "getUserId", signature: "getUserId()" },
      { name: "getName", signature: "getName()" },
      { name: "getUserEmail", signature: "getUserEmail()" },
      { name: "getOrganizationId", signature: "getOrganizationId()" },
      { name: "getProfileId", signature: "getProfileId()" },
      { name: "getSessionId", signature: "getSessionId()" },
      { name: "getDefaultCurrency", signature: "getDefaultCurrency()" },
      { name: "isMultiCurrencyOrganization", signature: "isMultiCurrencyOrganization()" }
    ]
  },
  Messaging: {
    detail: "邮件与平台事件",
    members: [
      { name: "SingleEmailMessage", signature: "Messaging.SingleEmailMessage" },
      { name: "sendEmail", signature: "sendEmail(List<Messaging.Email>)" },
      { name: "EmailMessage", signature: "Messaging.EmailMessage" }
    ]
  },
  Http: {
    detail: "HTTP callout",
    members: [
      { name: "HttpRequest", signature: "Http.HttpRequest" },
      { name: "HttpResponse", signature: "Http.HttpResponse" },
      { name: "send", signature: "send(HttpRequest)" }
    ]
  },
  SObject: {
    detail: "任意记录",
    members: [
      { name: "get", signature: "get(String)", detail: "按字段 API 名取值" },
      { name: "put", signature: "put(String, Object)" },
      { name: "getId", signature: "getId()" },
      { name: "getSObjectType", signature: "getSObjectType()" },
      { name: "getSObjects", signature: "getSObjects(String)" }
    ]
  },
  Exception: {
    detail: "异常类型",
    members: [
      { name: "getMessage", signature: "getMessage()" },
      { name: "getStackTraceString", signature: "getStackTraceString()" },
      { name: "getTypeName", signature: "getTypeName()" },
      { name: "DmlException", signature: "System.DmlException" },
      { name: "QueryException", signature: "System.QueryException" },
      { name: "NullPointerException", signature: "System.NullPointerException" },
      { name: "CalloutException", signature: "System.CalloutException" },
      { name: "ListException", signature: "System.ListException" }
    ]
  }
};

/** 接口（写可调度/批处理时会用到） */
export const BUILTIN_INTERFACES = ["Schedulable", "Batchable", "Queueable", "Comparable", "Callable"];

/**
 * 常见标准对象的**常用字段**（静态兜底）。
 * 有连接时 `biz/apex_complete.js` 会用 org 的真实 describe 覆盖/补全这一份。
 */
export const STANDARD_OBJECTS = {
  Account: ["Id", "Name", "AccountNumber", "Type", "Industry", "Phone", "Website", "OwnerId", "ParentId", "BillingCity", "BillingCountry", "CreatedDate", "LastModifiedDate"],
  Contact: ["Id", "FirstName", "LastName", "Name", "Email", "Phone", "AccountId", "Title", "MailingCity", "OwnerId", "CreatedDate"],
  Opportunity: ["Id", "Name", "StageName", "Amount", "CloseDate", "AccountId", "Probability", "OwnerId", "Type", "LeadSource", "CreatedDate"],
  Case: ["Id", "CaseNumber", "Subject", "Status", "Priority", "AccountId", "ContactId", "OwnerId", "Origin", "CreatedDate", "ClosedDate"],
  Lead: ["Id", "FirstName", "LastName", "Company", "Status", "Email", "Phone", "OwnerId", "LeadSource", "CreatedDate"],
  Order: ["Id", "OrderNumber", "AccountId", "Status", "EffectiveDate", "TotalAmount", "OwnerId", "Pricebook2Id", "CreatedDate"],
  OrderItem: ["Id", "OrderId", "Product2Id", "Quantity", "UnitPrice", "TotalPrice", "PricebookEntryId", "CreatedDate"],
  OrderHistory: ["Id", "OrderId", "Field", "OldValue", "NewValue", "CreatedById", "CreatedDate"],
  Contract: ["Id", "ContractNumber", "AccountId", "Status", "StartDate", "EndDate", "OwnerId"],
  Product2: ["Id", "Name", "ProductCode", "IsActive", "Family", "Description"],
  PricebookEntry: ["Id", "Pricebook2Id", "Product2Id", "UnitPrice", "IsActive", "CurrencyIsoCode"],
  User: ["Id", "Name", "Username", "Email", "IsActive", "ProfileId", "UserRoleId", "ManagerId", "Alias"],
  Task: ["Id", "Subject", "Status", "Priority", "WhoId", "WhatId", "OwnerId", "ActivityDate"],
  Event: ["Id", "Subject", "StartDateTime", "EndDateTime", "WhoId", "WhatId", "OwnerId"],
  Asset: ["Id", "Name", "AccountId", "Product2Id", "SerialNumber", "Status", "InstallDate"],
  Campaign: ["Id", "Name", "Status", "StartDate", "EndDate", "Type", "IsActive"],
  ApexLog: ["Id", "LogUserId", "LogLength", "Operation", "Request", "StartTime", "Status"],
  ApexClass: ["Id", "Name", "ApiVersion", "Status", "Body", "LengthWithoutComments"],
  ApexTrigger: ["Id", "Name", "TableEnumOrId", "Status", "ApiVersion"],
  DebugLevel: ["Id", "DeveloperName", "MasterLabel", "ApexCode", "ApexProfiling", "Callout", "Database", "System", "Validation", "Visualforce", "Workflow"],
  TraceFlag: ["Id", "TracedEntityId", "LogType", "DebugLevelId", "StartDate", "ExpirationDate"]
};

/** 代码片段（tab 一步到位，光标落在 `|` 处） */
export const SNIPPETS = [
  { label: "System.debug()", insert: "System.debug(${1:'debug message'});", detail: "调试输出", kind: "snippet" },
  { label: "for (SObject s : list)", insert: "for (${1:Account} ${2:acc} : ${3:records}) {\n    ${4}\n}", detail: "循环", kind: "snippet" },
  { label: "if (condition) {}", insert: "if (${1:condition}) {\n    ${2}\n}", detail: "条件", kind: "snippet" },
  { label: "try / catch", insert: "try {\n    ${1}\n} catch (Exception e) {\n    System.debug(LoggingLevel.ERROR, e.getMessage() + '\\n' + e.getStackTraceString());\n}", detail: "异常处理", kind: "snippet" },
  { label: "SOQL: [SELECT ... FROM ...]", insert: "[SELECT ${1:Id, Name} FROM ${2:Account} WHERE ${3:Id = :id} LIMIT ${4:100}]", detail: "内联 SOQL", kind: "snippet" },
  { label: "Database.query()", insert: "Database.query('SELECT ${1:Id} FROM ${2:Account} LIMIT ${3:10}')", detail: "动态 SOQL", kind: "snippet" },
  { label: "Limits.getQueries()", insert: "System.debug('SOQL: ' + Limits.getQueries() + '/' + Limits.getLimitQueries());", detail: "打印限额用量", kind: "snippet" },
  { label: "JSON.serialize()", insert: "System.debug(JSON.serializePretty(${1:value}));", detail: "打印对象结构", kind: "snippet" }
];

/** 常用 LoggingLevel（`System.debug(LoggingLevel.X, …)`） */
export const LOGGING_LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "FINE", "FINER", "FINEST"];

/** 内置类的名字列表（不含成员），用于"这里可以写哪些类"的场景 */
export function builtinClassNames() {
  return Object.keys(BUILTIN_CLASSES);
}
