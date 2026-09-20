# nForce Tools - 单元测试指南

## 概述

本项目使用 Jest 作为单元测试框架，为核心业务逻辑和工具函数提供全面的单元测试覆盖。

## 测试文件

| 文件 | 描述 |
|------|------|
| `test/utils.test.js` | 工具函数测试 (parseMarkdown, parseInline, flattenRecords, remove_duplicates) |
| `test/t2rules.test.js` | T2 规则引擎测试 (applyT2Rules, applyExpiryRules) |
| `test/state.test.js` | 全局状态管理测试 (appState) |
| `test/excel_utils.test.js` | Excel 工具函数测试 (analyzeData, applyRules, getUniqueOrderCount) |
| `test/test_t2_logic.js` | T2 逻辑集成测试 (legacy) |
| `test/test_t2_integration.js` | T2 集成测试 (legacy) |

## 运行测试

```bash
# 安装依赖
npm install

# 运行所有测试
npm test

# 运行测试并监听文件变化
npm run test:watch

# 生成测试覆盖率报告
npm run test:coverage
```

## 测试覆盖的模块

### src/common/utils.js
- ✅ `parseMarkdown()` - Markdown 到 HTML 解析
- ✅ `parseInline()` - 行内样式解析（粗体、代码、链接）
- ✅ `flattenRecords()` - 扁平化 Salesforce 嵌套记录
- ✅ `remove_duplicates()` - 按 OrderNumber 去重

### src/common/t2rules.js
- ✅ `applyT2Rules()` - T2 规则应用（50+ 测试用例）
- ✅ `applyExpiryRules()` - 过期规则应用
- ✅ 备注分割逻辑测试
- ✅ 边界条件测试

### src/biz/state.js
- ✅ appState 结构验证
- ✅ userInfo 结构验证
- ✅ stats 结构验证
- ✅ 状态更新测试

### src/common/excel_utils.js
- ✅ `analyzeData()` - 数据分析
- ✅ `analyzeT2Data()` - T2 数据分析
- ✅ `applyRules()` - 规则引擎（多种操作符、匹配模式）
- ✅ `getUniqueOrderCount()` - 唯一订单号计数

## 测试用例数量

| 模块 | 测试用例数 |
|------|-----------|
| utils.js | ~20 |
| t2rules.js | ~60 |
| state.js | ~30 |
| excel_utils.js | ~40 |
| **总计** | **~150+** |

## 测试原则

1. **独立性**: 每个测试用例独立运行，不依赖其他测试
2. **可重复性**: 相同的测试输入始终产生相同的输出
3. **清晰性**: 测试描述清晰，便于理解测试目的
4. **全面性**: 覆盖正常用例、边界条件和错误处理

## 覆盖率目标

- 核心业务逻辑 (t2rules.js): > 80%
- 工具函数 (utils.js): > 90%
- Excel 工具 (excel_utils.js): > 70%
