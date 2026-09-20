/**
 * Handsontable 表格渲染模块
 * 集中管理所有使用 Handsontable 库的数据表格渲染逻辑
 */

// 全局 Handsontable 实例
let dailyDataHot = null;
let pcdDailyDataHot = null;
let pcdPidFalloutDataHot = null;
let pcdQCIssueDataHot = null;
let reportDataHot = null;
let t2DataHot = null;
let t2AnalysisDataHot = null;
let latestDataHot = null;
let vvipDataHot = null;
let analysisDataHot = null;
let bulkJobsHot = null;

// Handsontable 通用配置
const HANDSONTABLE_COMMON_CONFIG = {
    colHeaders: true,
    rowHeaders: true,
    stretchH: 'all',
    autoWrapRow: true,
    autoWrapCol: true,
    maxRows: 1000,
    width: '100%',
    height: '500px',
    licenseKey: 'non-commercial-and-evaluation',
    filters: true,
    dropdownMenu: true,
    sortIndicator: true,
    manualColumnResize: true,
    manualRowResize: true,
    manualColumnMove: true,
    search: true,
    contextMenu: true
};

/**
 * 销毁 Handsontable 实例
 * @param {Object} hotInstance - Handsontable 实例
 */
function destroyHotInstance(hotInstance) {
    if (hotInstance) {
        hotInstance.destroy();
        return null;
    }
    return hotInstance;
}

/**
 * 从数据创建列配置
 * @param {Array} data - 数据数组
 * @param {Function} titleFormatter - 列标题格式化函数
 */
function createColumns(data, titleFormatter = col => col) {
    if (!data || data.length === 0) return [];
    return Object.keys(data[0]).map(col => ({
        title: titleFormatter(col),
        data: col
    }));
}

/**
 * 渲染日报数据表格
 */
export function renderDailyData(data) {
    const container = document.getElementById("daily-data-container");
    const table = document.getElementById("daily-data-table");
    
    dailyDataHot = destroyHotInstance(dailyDataHot);
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        return;
    }
    
    if (container) container.style.display = "block";
    
    const columns = createColumns(data, col => col.replace(/__c/g, '').replace(/Order_/g, '').replace(/_/g, ' '));
    
    dailyDataHot = new Handsontable(table, {
        ...HANDSONTABLE_COMMON_CONFIG,
        data: data,
        columns: columns
    });
}

/**
 * 渲染 PCD 日报数据表格
 */
export function renderPCDDailyData(data) {
    const container = document.getElementById("pcd-daily-data-container");
    const table = document.getElementById("pcd-daily-data-table");
    
    pcdDailyDataHot = destroyHotInstance(pcdDailyDataHot);
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        return;
    }
    
    if (container) container.style.display = "block";
    
    const columns = createColumns(data, col => col.replace(/__c/g, '').replace(/_/g, ' '));
    
    pcdDailyDataHot = new Handsontable(table, {
        ...HANDSONTABLE_COMMON_CONFIG,
        data: data,
        columns: columns
    });
}

/**
 * 渲染 PCD PID Fallout 数据表格
 */
export function renderPCDPIDFalloutData(data) {
    const container = document.getElementById("pcd-pid-fallout-data-container");
    const table = document.getElementById("pcd-pid-fallout-data-table");
    
    pcdPidFalloutDataHot = destroyHotInstance(pcdPidFalloutDataHot);
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        return;
    }
    
    if (container) container.style.display = "block";
    
    const columns = createColumns(data, col => col.replace(/__c/g, '').replace(/_/g, ' '));
    
    pcdPidFalloutDataHot = new Handsontable(table, {
        ...HANDSONTABLE_COMMON_CONFIG,
        data: data,
        columns: columns
    });
}

/**
 * 渲染 PCD QC Issue 数据表格
 */
export function renderPCDQCIssueData(data) {
    const container = document.getElementById("pcd-qc-issue-data-container");
    const table = document.getElementById("pcd-qc-issue-data-table");
    
    pcdQCIssueDataHot = destroyHotInstance(pcdQCIssueDataHot);
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        return;
    }
    
    if (container) container.style.display = "block";
    
    const columns = createColumns(data, col => col.replace(/__c/g, '').replace(/_/g, ' '));
    
    pcdQCIssueDataHot = new Handsontable(table, {
        ...HANDSONTABLE_COMMON_CONFIG,
        data: data,
        columns: columns
    });
}

/**
 * 渲染报表数据表格
 */
export function renderReportData(data) {
    const container = document.getElementById("report-data-container");
    const table = document.getElementById("report-data-table");
    
    reportDataHot = destroyHotInstance(reportDataHot);
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        return;
    }
    
    if (container) container.style.display = "block";
    
    const columns = createColumns(data, col => col.replace(/__c/g, '').replace(/_/g, ' '));
    
    reportDataHot = new Handsontable(table, {
        ...HANDSONTABLE_COMMON_CONFIG,
        data: data,
        columns: columns
    });
}

/**
 * 渲染 T-2 数据表格
 */
export function renderT2Data(data) {
    const container = document.getElementById("t2-data-container");
    const table = document.getElementById("t2-data-table");
    
    t2DataHot = destroyHotInstance(t2DataHot);
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        return;
    }
    
    if (container) container.style.display = "block";
    
    const columns = createColumns(data, col => col.replace(/__c/g, '').replace(/_/g, ' '));
    
    t2DataHot = new Handsontable(table, {
        ...HANDSONTABLE_COMMON_CONFIG,
        data: data,
        columns: columns
    });
}

/**
 * 渲染 T-2 分析数据表格
 */
export function renderT2AnalysisData(data) {
    const container = document.getElementById("t2-analysis-data-container");
    const table = document.getElementById("t2-analysis-data-table");
    
    t2AnalysisDataHot = destroyHotInstance(t2AnalysisDataHot);
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        return;
    }
    
    if (container) container.style.display = "block";
    
    const columns = createColumns(data);
    
    t2AnalysisDataHot = new Handsontable(table, {
        ...HANDSONTABLE_COMMON_CONFIG,
        data: data,
        columns: columns
    });
}

/**
 * 渲染最新数据表格
 */
export function renderLatestData(data) {
    const container = document.getElementById("latest-data-container");
    const table = document.getElementById("latest-data-table");
    
    latestDataHot = destroyHotInstance(latestDataHot);
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        return;
    }
    
    if (container) container.style.display = "block";
    
    const columns = createColumns(data, col => col.replace(/__c/g, '').replace(/Order_/g, '').replace(/_/g, ' '));
    
    latestDataHot = new Handsontable(table, {
        ...HANDSONTABLE_COMMON_CONFIG,
        data: data,
        columns: columns,
        contextMenu: {
            items: {
                'row_above': { name: '在上方插入行' },
                'row_below': { name: '在下方插入行' },
                'col_left': { name: '在左侧插入列' },
                'col_right': { name: '在右侧插入列' },
                'remove_row': { name: '删除行' },
                'remove_col': { name: '删除列' },
                '---------': '---------',
                'copy': { name: '复制' },
                'cut': { name: '剪切' },
                'paste': { name: '粘贴' }
            }
        }
    });
}

/**
 * 渲染 VVIP 数据表格
 */
export function renderVVIPData(data) {
    const container = document.getElementById("vvip-data-container");
    const table = document.getElementById("vvip-data-table");
    
    vvipDataHot = destroyHotInstance(vvipDataHot);
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        return;
    }
    
    if (container) container.style.display = "block";
    
    const columns = createColumns(data, col => col.replace(/__c/g, '').replace(/_/g, ' '));
    
    vvipDataHot = new Handsontable(table, {
        ...HANDSONTABLE_COMMON_CONFIG,
        data: data,
        columns: columns
    });
}

/**
 * 渲染分析数据表格
 */
export function renderAnalysisData(data) {
    const container = document.getElementById("analysis-data-container");
    const table = document.getElementById("analysis-data-table");
    
    analysisDataHot = destroyHotInstance(analysisDataHot);
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        return;
    }
    
    if (container) container.style.display = "block";
    
    const columns = createColumns(data);
    
    analysisDataHot = new Handsontable(table, {
        ...HANDSONTABLE_COMMON_CONFIG,
        data: data,
        columns: columns
    });
}

/**
 * 渲染 Bulk Jobs 表格
 */
export function renderBulkJobsTable(data) {
    const container = document.getElementById("bulk-jobs-container");
    const table = document.getElementById("bulk-jobs-table");
    const loadingEl = document.getElementById("bulk-jobs-loading");
    const emptyEl = document.getElementById("bulk-jobs-empty");
    
    if (loadingEl) loadingEl.style.display = "none";
    
    bulkJobsHot = destroyHotInstance(bulkJobsHot);
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        if (emptyEl) emptyEl.style.display = "block";
        return;
    }
    
    if (container) container.style.display = "block";
    if (emptyEl) emptyEl.style.display = "none";
    
    // 获取可用的显示字段
    const displayFields = ['id', 'operation', 'state', 'query', 'createdDate', 'numberOfRecordsProcessed', 'numberOfRecordsFailed', 'totalProcessingTime'];
    const availableFields = displayFields.filter(field => data.length > 0 && data[0].hasOwnProperty(field));
    const fieldsToUse = availableFields.length > 0 ? availableFields : Object.keys(data[0]);
    
    const columns = fieldsToUse.map(col => ({ title: col, data: col }));
    
    bulkJobsHot = new Handsontable(table, {
        ...HANDSONTABLE_COMMON_CONFIG,
        data: data,
        columns: columns,
        maxRows: 100,
        height: 'auto',
        readOnly: true
    });
}

/**
 * 显示 Bulk Jobs 加载状态
 */
export function showBulkJobsLoading() {
    const loadingEl = document.getElementById("bulk-jobs-loading");
    const container = document.getElementById("bulk-jobs-container");
    const emptyEl = document.getElementById("bulk-jobs-empty");
    
    if (loadingEl) loadingEl.style.display = "block";
    if (container) container.style.display = "none";
    if (emptyEl) emptyEl.style.display = "none";
}

// 导出实例，供调试用
export function getTableInstances() {
    return {
        dailyDataHot,
        pcdDailyDataHot,
        pcdPidFalloutDataHot,
        pcdQCIssueDataHot,
        reportDataHot,
        t2DataHot,
        t2AnalysisDataHot,
        latestDataHot,
        vvipDataHot,
        analysisDataHot,
        bulkJobsHot
    };
}
