/**
 * 单元测试: src/common/apex_log.js
 *
 * 这个模块决定两件很容易出错、又很难在界面上看出来”的事：
 *   ① 查 ApexLog 时必须限定 `LogUserId` —— 漏了就会拿到别人或系统批处理留下的日志，
 *      现象是"日志内容看着完全不相关"，而界面上一切正常（有 Log ID、有正文）；
 *   ② "哪条日志才算本次执行的"必须靠 **Id 变化**判定，不能靠时间（服务端与本机时钟有偏差）。
 *
 * 这两条都在这里钉死；真发请求那层（biz/sf_service.js）由渲染验证覆盖。
 */

describe("apex_log.js - Execute Anonymous 取日志的纯逻辑", () => {
  const apex = require("../src/common/apex_log.js");

  const T0 = Date.parse("2026-10-16T10:00:00.000Z");

  describe("SOQL 拼装", () => {
    it("查 TraceFlag：按用户过滤，且同时认 DEVELOPER_LOG 与 USER_DEBUG", () => {
      const soql = apex.traceFlagSoql("005000000000001AAA");
      expect(soql).toContain("FROM TraceFlag");
      expect(soql).toContain("WHERE TracedEntityId = '005000000000001AAA'");
      expect(soql).toContain("LogType IN ('DEVELOPER_LOG', 'USER_DEBUG')");
      expect(soql).toContain("ORDER BY ExpirationDate DESC");
    });

    it("查 ApexLog：**必须**带 LogUserId（漏了就会拿到别人的日志）", () => {
      const soql = apex.apexLogSoql("005000000000001AAA", 5);
      expect(soql).toContain("FROM ApexLog");
      expect(soql).toContain("WHERE LogUserId = '005000000000001AAA'");
      expect(soql).toContain("ORDER BY StartTime DESC");
      expect(soql).toContain("LIMIT 5");
    });

    it("查 ApexLog：limit 超出范围会被夹住，非法值回落到 5", () => {
      expect(apex.apexLogSoql("005", 1)).toContain("LIMIT 1");
      expect(apex.apexLogSoql("005", -3)).toContain("LIMIT 1");
      expect(apex.apexLogSoql("005", 9999)).toContain("LIMIT 200");
      expect(apex.apexLogSoql("005", "abc")).toContain("LIMIT 5");
    });

    it("SOQL 字面量会转义单引号（防御性：用户 Id 正常不会命中）", () => {
      expect(apex.traceFlagSoql("a'b")).toContain("'a\\'b'");
    });

    it("DateTime 字面量不带引号，形如 2026-10-16T10:00:00.000+0000", () => {
      expect(apex.soqlDateTime(T0)).toBe("2026-10-16T10:00:00.000+0000");
    });
  });

  describe("TraceFlag 挑选与请求体", () => {
    const active = { Id: "7tf1", ExpirationDate: "2026-10-16T10:30:00.000Z" };
    const expired = { Id: "7tf2", ExpirationDate: "2026-10-16T09:00:00.000Z" };

    it("挑未过期的那条", () => {
      expect(apex.pickActiveTraceFlag([expired, active], T0)).toBe(active);
      expect(apex.pickActiveTraceFlag([expired], T0)).toBeNull();
    });

    it("多条可用时挑有效期最晚的", () => {
      const later = { Id: "7tf3", ExpirationDate: "2026-10-16T11:00:00.000Z" };
      expect(apex.pickActiveTraceFlag([active, later], T0)).toBe(later);
    });

    it("没写到期时间的按可用处理（宁可复用，也不要在客户 org 里多建一条）", () => {
      expect(apex.pickActiveTraceFlag([{ Id: "7tf4" }], T0)).toEqual({ Id: "7tf4" });
    });

    it("已过期的能被单独挑出来续期", () => {
      expect(apex.pickExpiredTraceFlag([active, expired], T0)).toBe(expired);
      expect(apex.pickExpiredTraceFlag([active], T0)).toBeNull();
    });

    it("新建请求体：LogType 取 DEVELOPER_LOG，有效期 = 现在 + TTL", () => {
      const body = apex.traceFlagPayload("005", "7dl", T0, 30);
      expect(body.TracedEntityId).toBe("005");
      expect(body.LogType).toBe("DEVELOPER_LOG");
      expect(body.DebugLevelId).toBe("7dl");
      expect(Date.parse(body.ExpirationDate) - Date.parse(body.StartDate)).toBe(30 * 60 * 1000);
      expect(body.StartDate).toBe("2026-10-16T10:00:00.000Z");
    });

    it("续期请求体只改时间与级别（不带 TracedEntityId / LogType）", () => {
      const body = apex.traceFlagRenewPayload("7dl", T0, 30);
      expect(body).not.toHaveProperty("TracedEntityId");
      expect(body).not.toHaveProperty("LogType");
      expect(body.DebugLevelId).toBe("7dl");
    });

    it("自建 DebugLevel：ApexCode 至少要是 DEBUG（否则 System.debug 不进日志）", () => {
      const body = apex.debugLevelPayload();
      expect(body.ApexCode).toBe("DEBUG");
      expect(body.DeveloperName).toBe(apex.DEBUG_LEVEL_NAME);
    });
  });

  describe("认准「本次执行」那条日志", () => {
    const newer = { Id: "07L_new", StartTime: "2026-10-16T10:00:01.000Z" };
    const older = { Id: "07L_old", StartTime: "2026-10-16T09:59:00.000Z" };

    it("执行前那条还在列表里时，必须跳过它取更早出现的那条新的", () => {
      expect(apex.pickNewestLog([newer, older], "07L_old")).toBe(newer);
    });

    it("列表里全是同一条（日志还没落库）→ null，交给调用方继续轮询", () => {
      expect(apex.pickNewestLog([older], "07L_old")).toBeNull();
      expect(apex.pickNewestLog([], "07L_old")).toBeNull();
    });

    it("执行前一条日志都没有时，取第一条", () => {
      expect(apex.pickNewestLog([newer, older], null)).toBe(newer);
    });

    it("忽略没有 Id 的脏记录", () => {
      expect(apex.pickNewestLog([{ StartTime: "x" }, newer], null)).toBe(newer);
    });
  });

  describe("日志正文归一化", () => {
    it("把字面量 \\n 还原成换行（有些返回会整段转义，不还原就挤成一行）", () => {
      const out = apex.normalizeLogBody("line1\\nline2");
      expect(out.text).toBe("line1\nline2");
      expect(out.truncated).toBe(false);
    });

    it("超长时截断并附提示（单条日志上限 5MB，直接塞进页面会把界面拖死）", () => {
      const out = apex.normalizeLogBody("x".repeat(50), 10);
      expect(out.truncated).toBe(true);
      expect(out.bytes).toBe(50);
      expect(out.text.startsWith("x".repeat(10))).toBe(true);
      expect(out.text).toContain("下载日志");
    });

    it("空值 / 非字符串都安全", () => {
      expect(apex.normalizeLogBody(null).text).toBe("");
      expect(apex.normalizeLogBody(undefined).bytes).toBe(0);
      expect(apex.normalizeLogBody(12345).text).toBe("12345");
    });
  });

  describe("给用户看的文案", () => {
    it("摘要行拼出 操作 · 体积 · 时间 · 状态", () => {
      const text = apex.logMetaText({
        Operation: "ExecuteAnonymous",
        LogLength: 2048,
        StartTime: "2026-10-16T10:00:00.000Z",
        Status: "Success"
      });
      expect(text).toContain("ExecuteAnonymous");
      expect(text).toContain("2.0 KB");
      expect(text).toContain("2026-10-16");
      expect(text).toContain("Success");
    });

    it("TraceFlag 三种成功形态各有说法（复用 / 新建 / 续期）", () => {
      expect(apex.traceFlagHint({ ok: true, status: "created" })).toContain("已自动开启");
      expect(apex.traceFlagHint({ ok: true, status: "renewed" })).toContain("已续期");
      expect(apex.traceFlagHint({ ok: true, status: "reused", traceFlag: { ExpirationDate: "2026-10-16T10:30:00.000Z" } }))
        .toContain("复用现有日志跟踪");
    });

    it("开不起来时把原因带出来（那是「为什么没有日志」的答案）", () => {
      expect(apex.traceFlagHint({ ok: false, error: "权限不足" })).toContain("权限不足");
    });

    it("没拿到日志时的排查建议：跟踪没开 vs 这次真没输出，两条不同的路", () => {
      expect(apex.noLogHint({ traceOk: false })).toContain("日志跟踪没开起来");
      expect(apex.noLogHint({ traceOk: true })).toContain("System.debug");
    });
  });
});
