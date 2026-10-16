/**
 * 用户信息 / 组织信息
 *
 * 连接成功后拉一次的用户与组织信息（首页与连接设置都会用到）。
 *
 * ── 为什么单独一个文件（2026-10-15）──
 * 这些代码原先都在 `biz/logic.js` 里 —— 一个 2239 行、45 个导出的巨型模块，把取数、导入、
 * 导出、Bulk、定时任务、午餐抽签全塞在一起，改一处要在两千行里翻。按功能域拆成 10 个文件后，
 * 每个 60~400 行，文件名即功能域。**只做了搬运，没有改任何函数体**。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("ORG");
import { sfConn } from "./sf_service.js";
import { appState } from "./state.js";

export async function fetchUserInfo() {
  try {
    if (appState.is_connected && sfConn.connection) {
      const result = await sfConn.getUserInfo();
      log.info('获取用户信息成功:', result);
      if (result.success) {
        const userInfo = result.userInfo;
        // 更新应用状态
        appState.userInfo = {
          username: userInfo.username || userInfo.user_id || '',
          email: userInfo.email || '',
          fullName: userInfo.display_name || userInfo.name || '',
          thumbnail: userInfo.photos?.thumbnail || userInfo.photos?.[0]?.thumbnail || userInfo.thumbnail || userInfo.photos?.picture || ''
        };

        log.debug(appState.userInfo);
        // 更新UI
        // updateUserInfo(); // updateUIState 会调用
      }
    }
  } catch (error) {
    log.error('获取用户信息失败:', error);
  }
}

export async function fetchOrgInfo() {
  try {
    if (appState.is_connected && sfConn.connection) {
      const result = await sfConn.getOrgInfo();
      log.info('获取组织信息成功:', result);
      if (result.success) {
        appState.orgInfo = result.orgInfo;
        // updateUserInfo(); // updateUIState 会调用
      }
    }
  } catch (error) {
    log.error('获取组织信息失败:', error);
  }
}
