/**
 * 首页布局的「内置默认值」
 *
 * 为什么需要这个文件？
 *   浏览器 / Chrome 扩展不支持直接 `import ... from "xxx.json"`（会报
 *   "Expected a JavaScript-or-Wasm module script but the server responded
 *   with a MIME type of application/json"），所以默认布局必须以 JS 模块形式提供，
 *   不能直接用 JSON 模块。
 *
 * 优先级（见 loadUiLayout）：
 *   1) chrome.storage.local 里用户保存的 ui_layout
 *   2) 扩展目录下的 rules/ui_layout.json（可直接编辑，改完刷新即生效，无需重新打包）
 *   3) 本文件（兜底，保证任何情况下首页都有图标可显示，不会白屏）
 *
 * 注意：rules/ui_layout.json 是主要维护入口；本文件仅作兜底，
 *       两者结构必须保持一致。
 */
const DEFAULT_LAYOUT = {
  version: 1,
  hero: {
    title: "功能中心",
    subtitle: "点击图标进入对应功能 · 常用功能可自行挑选"
  },
  favorites: {
    // 「常用功能」的默认列表：顺序即展示顺序，不再随使用频率变化。
    // 用户在界面上的改动存在 chrome.storage.local 的 ui_favorites，
    // 只有在「恢复默认」或首次使用时才会用到这里。
    title: "常用功能",
    max: 8,
    ids: ["lts-report","lts-file","t4-list","pcd-pid-fallout","pcd-qc-issue","session-link"]
  },
  groups: [
    {
      id: "connection",
      title: "连接与环境",
      icon: "fa-key",
      color: "blue",
      tiles: [
        { id: "connection", step: 1, label: "连接设置", icon: "fa-plug", desc: "Session ID · 连接测试", requiresConnection: false },
        { id: "session-link", step: 22, label: "Session 链接", icon: "fa-link", desc: "查看 · 复制 · 直接登录" }
      ]
    },
    {
      id: "lts",
      title: "LTS",
      icon: "fa-cubes",
      color: "blue",
      tiles: [
        { id: "lts-overview", step: 5, label: "LTS 概览", icon: "fa-home", desc: "Fallout Summary 概览" },
        { id: "lts-daily", step: 2, label: "获取当日数据", icon: "fa-calendar-day", desc: "当日订单数据" },
        { id: "lts-report", step: 3, label: "获取报表数据", icon: "fa-chart-bar", desc: "历史遗留未完成订单" },
        { id: "lts-file", step: 4, label: "获取文件数据", icon: "fa-file-upload", desc: "按文件批量查询" },
        { id: "vvip", step: 9, label: "VVIP", icon: "fa-star", desc: "VVIP 客户订单查询" },
        { id: "t4-list", step: 12, label: "T-4 Outstanding", icon: "fa-file-alt", desc: "T-4 connectivity 清单" },
        { id: "t4-analysis", step: 13, label: "T-4 分析", icon: "fa-chart-line", desc: "Outstanding 数据分析" }
      ]
    },
    {
      id: "analysis",
      title: "数据分析",
      icon: "fa-chart-pie",
      color: "purple",
      tiles: [
        { id: "analysis", step: 10, label: "数据分析", icon: "fa-chart-pie", desc: "规则匹配 · 数据透视" }
      ]
    },
    {
      id: "ott",
      title: "OTT",
      icon: "fa-tv",
      color: "orange",
      tiles: [
        { id: "ott", step: 7, label: "OTT", icon: "fa-tv", desc: "OTT 数据获取" }
      ]
    },
    {
      id: "pcd",
      title: "PCD",
      icon: "fa-laptop-code",
      color: "pink",
      tiles: [
        { id: "pcd", step: 8, label: "PCD", icon: "fa-laptop-code", desc: "PCD 当日数据" },
        { id: "pcd-pid-fallout", step: 16, label: "PID Fallout", icon: "fa-exclamation-triangle", desc: "Data issue 排查" },
        { id: "pcd-qc-issue", step: 17, label: "QC Issue", icon: "fa-search", desc: "Data issue 排查" }
      ]
    },
    {
      id: "cvp7",
      title: "CVP7",
      icon: "fa-plug",
      color: "amber",
      tiles: [
        { id: "cvp7", step: 11, label: "CVP7", icon: "fa-plug", desc: "T-4 连通性检测" }
      ]
    },
    {
      id: "tools",
      title: "工具",
      icon: "fa-check-circle",
      color: "green",
      tiles: [
        { id: "bulk", step: 15, label: "Bulk 操作", icon: "fa-database", desc: "批量作业管理" },
        { id: "anonymous", step: 18, label: "Execute Anonymous", icon: "fa-code", desc: "Apex 匿名执行" },
        { id: "schedule-jobs", step: 19, label: "Schedule Jobs", icon: "fa-clock", desc: "定时任务管理" },
        { id: "soql-export", step: 23, label: "SOQL 导出", icon: "fa-search", desc: "查询 · 导出 Excel/CSV" },
        { id: "data-import", step: 24, label: "批量导入", icon: "fa-file-import", desc: "CSV/Excel 批量写入" },
        { id: "metadata-tools", step: 25, label: "Metadata 工具", icon: "fa-box-open", desc: "检索 · 打包下载" },
        { id: "event-monitor", step: 26, label: "事件监听", icon: "fa-satellite-dish", desc: "Platform Event · CDC" }
      ]
    },
    {
      id: "misc",
      title: "杂项",
      icon: "fa-ellipsis-h",
      color: "teal",
      tiles: [
        { id: "lunch", step: 14, label: "中午食乜", icon: "fa-utensils", desc: "随机挑选午餐" }
      ]
    }
  ]
};

export default DEFAULT_LAYOUT;
