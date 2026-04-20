# nForce Tools UI 优化计划

## 目标
统一所有功能模块的UI设计，建立一致的视觉语言和交互体验。

## 当前问题分析

### 1. 页面头部设计不一致
- 部分页面有圆形图标背景，部分没有
- 描述文字的样式和位置不统一
- 标题级别不统一

### 2. 文件上传组件不统一
- 各模块上传区域样式各异
- 图标、颜色、边框处理不一致
- 已上传文件预览样式不统一

### 3. 按钮设计不统一
- 主按钮颜色不统一（蓝色、橙色、紫色、绿色等）
- 按钮尺寸和间距不统一
- 操作按钮的排列方式不一致

### 4. 表格容器样式不统一
- 部分有边框，部分没有
- 表头样式不统一
- 分页器样式不统一

### 5. 表单布局不统一
- 标签位置不统一
- 输入框样式不统一
- 帮助文本样式不统一

---

## 优化方案

### 一、统一的页面头部设计

每个功能模块的页面头部采用统一布局：

```html
<!-- 统一的头部结构 -->
<div class="section-header">
    <div class="section-icon" style="background: #e6f7ff;">
        <i class="fas fa-cloud-download-alt" style="color: #1890ff;"></i>
    </div>
    <div class="section-info">
        <h3 class="section-title">获取当日数据</h3>
        <ul class="section-desc">
            <li><strong>日期范围：</strong>...</li>
            <li><strong>筛选条件：</strong>...</li>
        </ul>
    </div>
</div>
```

**设计规范：**
- 图标容器：`80px × 80px`，`border-radius: 50%`
- 图标大小：`32px`
- 标题：`1.25rem`，`font-weight: 600`
- 描述列表：黑色圆点，缩进20px

### 二、统一的文件上传组件

```html
<!-- 统一的上传组件结构 -->
<div class="unified-file-upload">
    <div class="upload-drag-area">
        <div class="upload-icon">
            <i class="fas fa-cloud-upload-alt"></i>
        </div>
        <p class="upload-text">点击或拖拽文件到此区域上传</p>
        <p class="upload-hint">支持 .xlsx 格式</p>
    </div>
    <input type="file" class="upload-input">
</div>
```

**设计规范：**
- 拖拽区域：`border: 2px dashed var(--border-color)`
- 内边距：`3rem 2rem`
- 最小高度：`200px`
- 悬停：`border-color: var(--primary-color)` + 背景色变化

### 三、统一的按钮设计

**主按钮：**
- 背景色：统一使用 `var(--primary-color)` 蓝色
- 尺寸：`height: 48px`，`font-size: 16px`
- 内边距：`6.4px 15px`
- 边框圆角：`2px`

**次按钮：**
- 背景色：`var(--bg-primary)`
- 边框：`1px solid var(--border-color)`
- 悬停：边框色变化

**按钮组布局：**
- 水平居中排列
- 按钮间距：`1rem`
- 最大宽度：`400px`（居中表单内）

### 四、统一的表格容器

```html
<div class="unified-table-container">
    <div class="table-header">
        <h4 class="table-title">数据预览</h4>
        <div class="table-actions">
            <button class="ant-btn ant-btn-default">
                <i class="fas fa-download"></i> 导出
            </button>
        </div>
    </div>
    <div class="table-body">
        <!-- Handsontable 容器 -->
    </div>
</div>
```

**设计规范：**
- 容器边框：`1px solid var(--border-color)`
- 圆角：`var(--radius-md)`
- 溢出处理：`overflow: hidden`

### 五、统一的表单布局

```html
<div class="unified-form">
    <div class="form-group">
        <label class="form-label">标签文字</label>
        <input class="ant-input">
        <div class="form-help">帮助说明文字</div>
    </div>
</div>
```

**设计规范：**
- 标签：`font-size: 0.875rem`，`font-weight: 500`
- 输入框：统一使用 Ant Design 的 `ant-input` 类
- 帮助文本：`font-size: 0.75rem`，`color: var(--text-light)`

---

## 实施步骤

### Phase 1: CSS 变量和基础样式
1. 更新 `main.css` 中的 CSS 变量定义
2. 创建统一的工具类

### Phase 2: 组件模板
1. 创建统一的页面头部 HTML 模板
2. 创建统一的文件上传组件
3. 创建统一的表格容器模板

### Phase 3: 逐步应用到各模块
1. Section 2: 获取当日数据
2. Section 3: 获取报表数据
3. Section 4: 根据上传文件获取数据
4. Section 9: VVIP
5. Section 10: 数据分析
6. Section 12: T-4 Outstanding
7. Section 13: T-4 Outstanding分析
8. Section 14: 中午吃乜
9. Section 15: Bulk 操作
10. Section 16: PCD PID Fallout
11. Section 17: PCD QC Issue
12. Section 18: Execute Anonymous
13. Section 19: Schedule Jobs

---

## 模块颜色主题

| 模块 | 主色 | 背景色 |
|------|------|--------|
| LTS | `#1890ff` | `#e6f7ff` |
| PCD | `#1890ff` | `#e6f7ff` |
| VVIP | `#faad14` | `#fffbe6` |
| 数据分析 | `#722ed1` | `#f9f0ff` |
| T-4 | `#fa8c16` | `#fff7e6` |
| Bulk/工具 | `#2f54eb` | `#f0f5ff` |
| 中午吃乜 | `#eb2f96` | `#fff0f6` |
| Execute | `#2f54eb` | `#f0f5ff` |
