/**
 * UI 静态配置
 *
 * 历史说明：本文件曾包含 submenuConfig / sectionToModule（旧侧边栏与横向菜单的配置），
 * 以及 DEFAULT_STATS / DEFAULT_USER_INFO / BULK_JOBS_DISPLAY_FIELDS。
 * v3.2 改为 App 图标式首页后侧边栏与横向菜单已被移除，这些常量全项目零引用，
 * 已于 2026-09-24 删除 —— 它们描述的是不再存在的结构，或与 state.js 重复，留着只会误导后来的人。
 *
 * 相关内容的真身现在在这些地方：
 *   - 功能入口：src/rules/ui_layout.json（首选，改完刷新即生效）
 *              src/biz/ui_layout_default.js（同一份磁贴的 JS 兜底）
 *   - 数据形状：src/biz/state.js 的 _appState（stats / userInfo 等）
 */

// 默认午餐地点（「中午食乜」首次使用时的初始列表）
export const DEFAULT_LUNCH_PLACES = [
    { "name": "万达兰州拉面" },
    { "name": "京华胜记" },
    { "name": "京华牛杂面" },
    { "name": "荣耀国际" },
    { "name": "负一楼" },
    { "name": "万达木桶饭" }
];
