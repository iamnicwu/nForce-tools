# nForce Tools - Chrome插件

## 概述

这是一个功能强大的Chrome浏览器插件，专为Salesforce用户设计。它允许用户直接在浏览器中连接Salesforce组织，快速获取订单数据、报表数据，并支持通过上传Excel文件批量查询Salesforce数据。插件完全在本地运行，无需额外的服务器支持。

## 功能特性

- **Salesforce连接管理**
  - 支持手动输入Session ID连接
  - 支持自动检测当前浏览器中已登录的Salesforce Session
  - 智能识别Production和Sandbox环境

- **数据获取与处理**
  - **获取当日数据**：一键获取当日FixedLine订单数据，自动去重并展示。
  - **获取当日PCD数据**：一键获取当日PCD订单数据，自动去重并展示。
  - **获取报表数据**：快速拉取预定义的Salesforce报表数据。
  - **批量查询**：上传包含订单号的Excel文件，批量从Salesforce获取最新状态和详细信息。
  - **VVIP查询**：上传包含 Account ID 的Excel文件，批量查询 PCD 和 LTS 订单状态。
  - **LTS查询**：上传包含 Account ID 的Excel文件，批量查询 LTS 订单状态。
  - **T-4 Outstanding**：获取 LTS T-4 报表数据，筛选符合条件的记录。
  - **数据分析**：上传Excel文件，根据预定义或自定义规则自动分析数据并更新状态。
  - **Bulk 操作**：支持输入 SOQL 语句，通过 Salesforce Bulk API 2.0 创建批量查询任务，实时查看进度并下载海量数据结果。

- **数据导出**
  - 支持将查询结果导出为Excel文件 (.xlsx)。
  - 智能格式化数据列。

- **用户友好的界面**
  - 现代化的侧边栏导航设计。
  - 实时状态通知和进度提示。
  - 数据表格支持排序、筛选和列宽调整（基于Handsontable）。

## 安装步骤

1. **下载代码**
   下载本插件的源代码到本地目录。

2. **安装Chrome插件**
   1. 打开Chrome浏览器。
   2. 在地址栏输入 `chrome://extensions/` 并回车。
   3. 打开右上角的 **"开发者模式"** 开关。
   4. 点击左上角的 **"加载已解压的扩展程序"**。
   5. 选择本插件的根目录（包含 `manifest.json` 的文件夹）。
   6. 插件安装成功，图标将显示在浏览器工具栏中。

## 使用方法

### 1. 启动应用
点击浏览器工具栏中的 **nForce Tools** 图标，点击 **"打开应用"**，将在新标签页中打开主界面。

### 2. 连接Salesforce
首次使用需要建立连接：
- **自动连接**：如果您的浏览器已经登录了Salesforce，插件会自动尝试检测并连接。
- **手动连接**：
  1. 在Salesforce中打开开发者控制台 (Developer Console) 或使用其他工具获取 Session ID。
  2. 在插件的 **"连接设置"** 页面输入 Session ID。
  3. 点击 **"保存Session ID"** 并 **"测试Salesforce连接"**。

### 3. 获取数据
连接成功后，通过侧边栏导航使用各项功能：
- **获取当日数据**：点击按钮即可获取当日订单。
- **获取报表数据**：点击按钮获取报表。
- **根据上传文件获取数据**：
  1. 拖拽或选择Excel文件（需包含订单号列，如 `OrderNumber`, `Order No` 等）。
  2. 系统自动提取订单号并查询Salesforce。
  3. 查看结果或导出Excel。
- **VVIP查询**：
  1. 在 VVIP 模块上传包含 Account ID 的 Excel 文件。
  2. 系统自动识别 PCD 和 LTS 账户，并分别查询相关订单。
  3. 结果合并展示，支持导出。
- **LTS查询**：
  1. 在 LTS 模块上传包含 Account ID 的 Excel 文件。
  2. 系统自动查询 LTS 订单。
  3. 结果展示并支持导出。
- **数据分析**：
  1. 在数据分析模块上传 Excel 文件。
  2. (可选) 上传自定义规则 JSON 文件。
  3. 点击“开始分析”，系统将根据规则自动更新数据状态。
  4. 分析结果支持导出。
- **Bulk 操作**：
  1. 在 Bulk 操作模块输入 SOQL 查询语句。
  2. 点击“创建 Bulk 任务”，系统将返回 Job ID。
  3. 输入 Job ID 点击“查询状态”可查看任务进度。
  4. 任务完成后，点击“下载结果”即可获取 CSV 格式的数据文件。

## 文件结构

```
nForce-tools/
├── manifest.json      # 插件配置清单
├── index.html         # 应用主界面
├── app.js             # 主应用逻辑
├── background.js      # 后台服务脚本
├── popup.html         # 插件弹出层
├── biz/               # 业务逻辑模块
│   ├── logic.js       # 核心业务逻辑
│   ├── sf_service.js  # Salesforce 服务逻辑
│   ├── state.js       # 状态管理
│   └── ui.js          # UI 交互逻辑
├── common/            # 通用工具模块
│   ├── excel_utils.js # Excel 处理工具
│   ├── table_utils.js # 表格处理工具
│   ├── utils.js       # 通用工具函数
│   ├── icons.js       # 图标相关
│   └── t2rules.js     # T2 规则逻辑
├── lib/               # 第三方库
│   ├── css/           # 样式库 (AntD, Handsontable 等)
│   └── js/            # JS 库 (JSForce, SheetJS, Day.js 等)
├── icons/             # 图标资源
├── rules/             # 规则配置
├── docs/              # 文档
└── README.md          # 说明文档
```

## 技术栈

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Salesforce Integration**: JSForce
- **Data Grid**: Handsontable
- **Excel Processing**: SheetJS (xlsx)
- **Date Handling**: Day.js

## 注意事项

1. 插件仅在本地浏览器环境中运行，数据直接在浏览器和Salesforce之间传输，安全可靠。
2. 请确保您的Salesforce Session ID有效且具有相应的API访问权限。
3. 批量查询时，建议单次处理的数据量不要过大，以免触发Salesforce API限制。

## 更新日志

### v2.0 (2026-04-03)
- 新增 Bulk 操作模块，支持通过 SOQL 和 Bulk API 2.0 进行海量数据查询和下载
- 优化 Bulk 结果下载逻辑，支持自动分页获取完整数据
- 更新插件版本信息和文档

### v1.9 (2026-03-27)
- 优化插件性能和稳定性
- 更新版本信息和文档

### v1.8 (2026-03-17)
- 优化 T-4 规则逻辑 (t2rules.js)
- 更新项目文件结构文档
- 修复已知 Bug

### v1.7 (2026-03-16)
- 新增 PCD 模块“获取当日PCD数据”功能
- 支持自定义日期范围查询 PCD 数据
- 支持导出 PCD 数据为 Excel

### v1.6 (2026-02-11)
- 优化 Excel 文件处理逻辑，修复年份硬编码问题
- 优化 T-4 规则匹配逻辑
- 修复已知 Bug

### v1.5
- 优化代码结构，清理冗余日志
- 提升数据查询和处理性能
- 修复已知 Bug

### v1.4
- 新增 T-4 Outstanding 模块，支持获取 LTS T-4 报表数据
- 优化数据分析功能
- 修复已知 Bug

### v1.3
- 新增数据分析模块，支持自定义规则分析 Excel 数据
- 新增 LTS 模块，支持独立查询 LTS 订单
- 优化 VVIP 模块，支持更精准的 Account ID 识别
- 界面布局优化，支持移动端侧边栏切换

### v1.1
- 新增 VVIP 模块，支持通过 Account ID 批量查询 PCD 和 LTS 订单
- 优化数据查询性能，减少流式回调开销
- 界面优化与 Bug 修复

### v1.0
- 初始版本发布
- 支持Session ID连接
- 实现当日数据、报表数据获取
- 实现Excel文件上传批量查询
- 集成Handsontable数据展示
