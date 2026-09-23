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
  t2_default_rules: null,
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
 * 清理大数据缓存，释放内存
 * @param {Array<string>} keys - 要清理的数据键名，不传则清理所有数据
 */
export function clearDataCache(keys = null) {
  const dataKeys = keys || [
    'daily_data', 'pcd_daily_data', 'pcd_pid_fallout_data', 
    'pcd_qc_issue_data', 'report_data', 't2_data', 
    't2_analysis_data', 'latest_data', 'vvip_data', 'analysis_data'
  ];
  dataKeys.forEach(key => {
    if (_appState[key] !== null && _appState[key] !== undefined) {
      _appState[key] = null;
    }
  });
  log.info('数据缓存已清除:', dataKeys);
}