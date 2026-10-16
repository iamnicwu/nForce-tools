/**
 * 中午食乜（抽签 + 地点文件上传）
 *
 * 首页「中午食乜」那个小工具：初始化下拉、抽签、上传自定义地点清单。
 *
 * ── 为什么单独一个文件（2026-10-15）──
 * 这些代码原先都在 `biz/logic.js` 里 —— 一个 2239 行、45 个导出的巨型模块，把取数、导入、
 * 导出、Bulk、定时任务、午餐抽签全塞在一起，改一处要在两千行里翻。按功能域拆成 10 个文件后，
 * 每个 60~400 行，文件名即功能域。**只做了搬运，没有改任何函数体**。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("LUNCH");
import { appState } from "./state.js";
import { showNotification } from "../common/utils.js";
import { updateLunchFileUploadUI, showLunchResult, updateLunchUIState } from "./ui.js";
import { DEFAULT_LUNCH_PLACES } from "./ui_config.js";

export function initLunch() {
  if (!appState.lunch_places || appState.lunch_places.length === 0) {
    appState.lunch_places = [...DEFAULT_LUNCH_PLACES];
    log.info("已加载默认午餐地点");
  }
  updateLunchUIState();
}

export function shakeLunch() {
    // 确保有数据
    if (!appState.lunch_places || appState.lunch_places.length === 0) {
        initLunch();
    }

    // 简单的随机选择动画效果
    const container = document.getElementById("lunch-result-container");
    if (container) {
        container.innerHTML = '<div style="text-align: center; font-size: var(--fs-3xl); color: var(--warning-color);"><i class="fas fa-spinner fa-spin"></i> 正在选...</div>';
        container.style.display = 'block';
    }

    setTimeout(() => {
        const randomIndex = Math.floor(Math.random() * appState.lunch_places.length);
        const selectedPlace = appState.lunch_places[randomIndex];
        showLunchResult(selectedPlace);
    }, 800);
}

export function processLunchFile(file) {
  if (!file) return;

  if (!file.name.endsWith(".json")) {
    showNotification("请上传 JSON 格式的文件", "error");
    return;
  }

  updateLunchFileUploadUI(file);

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const places = JSON.parse(e.target.result);
      if (Array.isArray(places)) {
        appState.lunch_places = places;
        appState.has_lunch_file = true;
        showNotification(`成功加载 ${places.length} 个地点`, "success");
        
        // 更新UI
        updateLunchUIState();
      } else {
        showNotification("文件格式错误：应为地点数组", "error");
      }
    } catch (error) {
      log.error("解析午餐文件失败:", error);
      showNotification("解析文件失败: " + error.message, "error");
    }
  };
  reader.readAsText(file);
}
