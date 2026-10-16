/**
 * 把各业务域的数据导出成 Excel
 *
 * 11 个薄封装：从 appState 取对应数据 → exportToExcel。被 data_query / data_pcd 调用。
 *
 * ── 为什么单独一个文件（2026-10-15）──
 * 这些代码原先都在 `biz/logic.js` 里 —— 一个 2239 行、45 个导出的巨型模块，把取数、导入、
 * 导出、Bulk、定时任务、午餐抽签全塞在一起，改一处要在两千行里翻。按功能域拆成 10 个文件后，
 * 每个 60~400 行，文件名即功能域。**只做了搬运，没有改任何函数体**。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("EXPORT");
import { appState } from "./state.js";
import { showNotification } from "../common/utils.js";
import { exportToExcel } from "../common/excel_utils.js";

export async function exportDailyData() {
  await exportToExcel(appState.daily_data, "当日数据", "当日数据");
}

export async function exportPCDDailyData() {
  await exportToExcel(appState.pcd_daily_data, "PCD当日数据", "PCD当日数据");
}

export async function exportPCDExpiredData() {
  await exportToExcel(appState.pcd_expired_data, "PCD过期数据", "PCD过期数据");
}

export function exportPCDPIDFalloutData() {
  const data = appState.pcd_pid_fallout_data;
  if (!data || data.length === 0) {
    showNotification("没有可导出的数据", "warning");
    return;
  }

  // 将数据转换为CSV格式
  const headers = Object.keys(data[0]);
  const csvRows = [];
  
  // 添加表头
  csvRows.push(headers.join(','));
  
  // 添加数据行
  for (const row of data) {
    const values = headers.map(header => {
      const value = row[header];
      // 处理值中的特殊字符
      if (value === null || value === undefined) {
        return '';
      }
      const stringValue = String(value);
      // 如果值包含逗号、引号或换行符，用引号包裹
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    });
    csvRows.push(values.join(','));
  }
  
  const csvString = csvRows.join('\n');
  
  // 创建Blob并下载
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", `PCD_PID_Fallout_${new Date().toISOString().slice(0,10)}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  
  showNotification("CSV 文件下载成功", "success");
}

export function exportPCDQCIssueData() {
  const data = appState.pcd_qc_issue_data;
  if (!data || data.length === 0) {
    showNotification("没有可导出的数据", "warning");
    return;
  }

  // 将数据转换为CSV格式
  const headers = Object.keys(data[0]);
  const csvRows = [];
  
  // 添加表头
  csvRows.push(headers.join(','));
  
  // 添加数据行
  for (const row of data) {
    const values = headers.map(header => {
      const value = row[header];
      // 处理值中的特殊字符
      if (value === null || value === undefined) {
        return '';
      }
      const stringValue = String(value);
      // 如果值包含逗号、引号或换行符，用引号包裹
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    });
    csvRows.push(values.join(','));
  }
  
  const csvString = csvRows.join('\n');
  
  // 创建Blob并下载
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", `PCD_QC_Issue_${new Date().toISOString().slice(0,10)}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  
  showNotification("CSV 文件下载成功", "success");
}

export async function exportReportData() {
  await exportToExcel(appState.report_data, "报表数据", "报表数据");
}

export async function exportT2Data() {
  await exportToExcel(appState.t2_data, "T-4数据", "T-4数据");
}

export async function exportLatestData() {
  await exportToExcel(appState.latest_data, "最新数据", "最新数据");
}

export async function exportVVIPData() {
  await exportToExcel(appState.vvip_data, "VVIP数据", "VVIP数据");
}

export async function exportAnalysisData() {
  await exportToExcel(appState.analysis_data, "数据分析结果", "数据分析");
}

export async function exportT2AnalysisData() {
  await exportToExcel(appState.t2_analysis_data, "T-4分析结果", "T-4分析");
}
