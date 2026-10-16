/**
 * 报表数据同步到 OneDrive 的私有工具链
 *
 * 把「取报表数据」的结果写进 OneDrive 上的 Excel。**只被 data_query.js 用**，所以连同它的几个私有 helper（二维数组转换、列号转字母、开关判定）一起搬出来，原来散在 logic.js 中段，很容易被误认为是别的功能的代码。
 *
 * ── 为什么单独一个文件（2026-10-15）──
 * 这些代码原先都在 `biz/logic.js` 里 —— 一个 2239 行、45 个导出的巨型模块，把取数、导入、
 * 导出、Bulk、定时任务、午餐抽签全塞在一起，改一处要在两千行里翻。按功能域拆成 10 个文件后，
 * 每个 60~400 行，文件名即功能域。**只做了搬运，没有改任何函数体**。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("ONEDRIVE");
import { showNotification } from "../common/utils.js";
import { OneDriveWorkbookService } from "../common/onedrive_service.js";

const ONEDRIVE_SYNC_STORAGE_KEY = "onedrive_report_sync";

function jsonTo2DArray(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return [];
  }

  // 提取所有可能的列名（取第一个对象的 keys）
  const headers = Object.keys(data[0]);

  // 预扫描所有数据，找出需要保留为文本格式的列（包含前导 0 的字符串值）
  const textColumns = new Set();
  data.forEach(record => {
    headers.forEach(header => {
      const value = record[header];
      if (typeof value === 'string' && /^0\d+$/.test(value)) {
        textColumns.add(header);
      }
    });
  });

  if (textColumns.size > 0) {
    log.info('以下列包含前导 0，将标记为文本格式:', Array.from(textColumns));
  }

  // 构建二维数组
  const rows = [headers];
  data.forEach(record => {
    const row = headers.map(header => {
      const value = record[header];
      // 处理 null/undefined
      if (value === null || value === undefined) {
        return '';
      }
      // 处理对象/数组（转为 JSON 字符串）
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      // 对带前导 0 的字符串值加 ' 前缀，强制 Excel 识别为文本格式
      if (textColumns.has(header) && typeof value === 'string') {
        return "'" + value;
      }
      return value;
    });
    rows.push(row);
  });

  return rows;
}

function columnIndexToLetter(index) {
  let result = '';
  let num = index;
  do {
    result = String.fromCharCode(65 + (num % 26)) + result;
    num = Math.floor(num / 26) - 1;
  } while (num >= 0);
  return result;
}

async function isReportOneDriveSyncEnabled() {
  const checkbox = document.getElementById("report-sync-onedrive-checkbox");
  if (checkbox) return checkbox.checked === true;

  try {
    const stored = await chrome.storage.local.get(ONEDRIVE_SYNC_STORAGE_KEY);
    return stored?.[ONEDRIVE_SYNC_STORAGE_KEY] === true;
  } catch (error) {
    log.warn("读取 OneDrive 同步开关失败，按关闭处理:", error);
    return false;
  }
}

async function writeReportDataToOneDrive(data, options = {}) {
  const {
    batchSize = 200,
    batchDelay = 300,
    worksheetName = 'nforce_test'
  } = options;

  try {
    log.info(`开始将 ${data.length} 条报表数据写入 OneDrive Workbook (每批 ${batchSize} 行)...`);

    // 创建 OneDrive 服务实例（使用 graph_token.js + ExpiredWorkbook 默认值）
    const service = new OneDriveWorkbookService();

    // 连接 Workbook
    const connectResult = await service.connect({ persistChanges: true });
    log.debug('connectResult:', connectResult);
    if (!connectResult.success) {
      log.error('连接 OneDrive Workbook 失败:', connectResult.error);
      return { success: false, error: connectResult.error };
    }

    log.info('OneDrive Workbook 连接成功');

    // 检查 worksheet 是否已存在，存在则删除
    const worksheets = await service.getWorksheets();
    const existingSheet = worksheets.find(sheet => sheet.name === worksheetName);

    if (existingSheet) {
      log.info(`Worksheet "${worksheetName}" 已存在，删除旧版本...`);
      await service.deleteWorksheet(worksheetName);
    }

    // 创建新的 worksheet
    log.info(`创建 Worksheet "${worksheetName}"...`);
    await service.createWorksheet(worksheetName);

    // 将数据转换为二维数组（含表头）
    const excelData = jsonTo2DArray(data);

    if (excelData.length === 0) {
      log.warn('无数据可写入');
      await service.disconnect();
      return { success: true, message: 'No data to write' };
    }

    const colCount = excelData[0].length;
    const endCol = columnIndexToLetter(colCount - 1);
    const headerRow = excelData[0];
    const dataRows = excelData.slice(1); // 去掉表头
    const totalDataRows = dataRows.length;
    const totalBatches = Math.ceil(totalDataRows / batchSize);

    log.info(`总计 ${totalDataRows} 行数据 ${colCount} 列，分 ${totalBatches} 批写入`);

    // 第 1 批：写入表头 + 第一批数据
    const firstBatch = dataRows.slice(0, batchSize);
    const firstBatchRange = `A1:${endCol}${firstBatch.length + 1}`;
    log.info(`批次 1/${totalBatches}: 写入 ${firstBatchRange} (表头 + ${firstBatch.length} 行)...`);
    await service.updateRangeValues(worksheetName, firstBatchRange, [headerRow, ...firstBatch]);

    // 后续批次：纯数据（从第 2 批开始，起始行偏移 = 1 表头 + 已写入行数）
    for (let i = 1; i < totalBatches; i++) {
      const startRow = 1 + i * batchSize; // +1 是表头行
      const batchData = dataRows.slice(i * batchSize, (i + 1) * batchSize);
      const endRow = startRow + batchData.length - 1;
      const batchRange = `A${startRow}:${endCol}${endRow}`;

      log.info(`批次 ${i + 1}/${totalBatches}: 写入 ${batchRange} (${batchData.length} 行)...`);
      await service.updateRangeValues(worksheetName, batchRange, batchData);

      // 批次间延迟，避免触发 API 限流
      if (i < totalBatches - 1) {
        await new Promise(resolve => setTimeout(resolve, batchDelay));
      }
    }

    const finalRange = `A1:${endCol}${totalDataRows + 1}`;
    log.info(`数据写入 OneDrive 成功，Range: ${finalRange}`);

    // 断开连接
    await service.disconnect();

    return {
      success: true,
      message: `成功写入 ${data.length} 条记录到 OneDrive (分 ${totalBatches} 批)`,
      worksheet: worksheetName,
      range: finalRange,
      totalRows: totalDataRows,
      totalBatches
    };
  } catch (error) {
    log.error('写入 OneDrive 失败:', error);
    return { success: false, error: error.message };
  }
}

export async function syncReportDataToOneDrive(data) {
  if (!(await isReportOneDriveSyncEnabled())) {
    log.debug("OneDrive 同步开关未开启，跳过写入");
    return;
  }

  try {
    const writeResult = await writeReportDataToOneDrive(data);
    if (writeResult.success) {
      showNotification(`${writeResult.message}，Worksheet: ${writeResult.worksheet}`, "success");
    } else {
      showNotification(`OneDrive 同步失败：${writeResult.error || "未知错误"}`, "warning");
    }
  } catch (error) {
    log.error("OneDrive 同步出现异常:", error);
    showNotification("OneDrive 同步失败，请在控制台用 testOneDrive() 检查配置", "warning");
  }
}
