// 全局状态管理 - 使用 Proxy 封装，提供变更追踪和只读保护
import { createLogger } from "../common/logger.js";

const log = createLogger("STATE");
const _appState = {
  session_id: null,
  instance_url: null,
  is_connected: false,
  available_sessions: null,
  has_daily_data: false,
  has_pcd_daily_data: false,
  has_pcd_pid_fallout_data: false,
  has_pcd_qc_issue_data: false,
  has_report_data: false,
  has_t2_data: false,
  has_file: false,
  has_vvip_file: false,
  has_analysis_file: false,
  has_t2_analysis_file: false,
  has_lunch_file: false,
  lunch_places: [],
  custom_rules: null,
  t2_custom_rules: null,
  readme_loaded: false,
  lts_summary_loaded: false,
  order_numbers: [],
  account_ids: [],
  pcd_account_ids: [],
  lts_account_ids: [],
  userInfo: {
    username: '',
    email: '',
    fullName: '',
    thumbnail: ''
  },
  stats: {
    dailyOrders: 0,
    pcdDailyOrders: 0,
    pcdPidFalloutOrders: 0,
    pcdQCIssueOrders: 0,
    reportRecords: 0,
    t2Records: 0,
    uploadedOrders: 0,
    fetchedData: 0,
    uploadedAccounts: 0,
    ltsAccounts: 0,
    uploadedPcdAccounts: 0,
    uploadedLtsAccounts: 0,
    vvipOrders: 0,
    ltsOrders: 0,
    analysisRecords: 0,
    t2AnalysisRecords: 0
  },
  daily_data: null,
  pcd_daily_data: null,
  pcd_pid_fallout_data: null,
  pcd_qc_issue_data: null,
  report_data: null,
  t2_data: null,
  t2_analysis_data: null,
  latest_data: null,
  vvip_data: null,
  analysis_data: null,
  orgInfo: null
};

// 状态变更监听器
const _stateListeners = [];

/**
 * 订阅状态变更
 * @param {Function} callback - 回调函数，接收 (key, newValue, oldValue)
 * @returns {Function} 取消订阅函数
 */
export function subscribeStateChange(callback) {
  _stateListeners.push(callback);
  return () => {
    const index = _stateListeners.indexOf(callback);
    if (index > -1) _stateListeners.splice(index, 1);
  };
}

/**
 * 通知所有监听器状态变更
 */
function _notifyStateChange(key, newValue, oldValue) {
  _stateListeners.forEach(callback => {
    try {
      callback(key, newValue, oldValue);
    } catch (e) {
      log.error('状态监听器执行失败:', e);
    }
  });
}

// 使用 Proxy 封装状态，提供变更追踪
export const appState = new Proxy(_appState, {
  set(target, key, value) {
    const oldValue = target[key];
    if (oldValue !== value) {
      target[key] = value;
      _notifyStateChange(key, value, oldValue);
    }
    return true;
  },
  get(target, key) {
    return target[key];
  }
});

/**
 * 已删除 clearDataCache()。
 *
 * 它原本是"释放大数据集内存"的唯一工具，但全项目没有任何调用方：
 * 8 个 getXxxData() 拿到的全量数据都常驻在 _appState 里（供「导出」按钮重下载），
 * 没有任何路径会把它们置空。一个无人调用的释放函数并不解决内存问题，
 * 反而容易让人误以为"已经有回收机制了"。
 *
 * 如果后续要真正处理大数据量下的常驻内存，正确做法是给数据集加"生命周期"：
 * 例如离开该 section 时释放，或导出完成后释放并让「导出」按钮重新拉取，
 * 而不是留一个孤立函数在这里。详见 plans/review-2026-09-27.md §4 的最后一行。
 */
