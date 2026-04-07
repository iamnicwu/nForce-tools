// 全局状态管理
export const appState = {
  session_id: localStorage.getItem("sf_session_id") || null,
  is_connected: false,
  has_daily_data: false,
  has_pcd_daily_data: false,
  has_report_data: false,
  has_t2_data: false,
  has_file: false,
  has_vvip_file: false,
  // has_lts_file: false, // 移除 LTS 文件上传状态
  has_analysis_file: false,
  has_t2_analysis_file: false, // T-4 分析文件上传状态
  has_lunch_file: false, // 午餐文件上传状态
  lunch_places: [], // 午餐地点列表
  custom_rules: null, // 存储自定义规则 (通用分析)
  t2_custom_rules: null, // 存储 T-4 自定义规则
  t2_default_rules: null, // 存储 T-4 默认规则
  readme_loaded: false,
  lts_summary_loaded: false,
  order_numbers: [],
  account_ids: [],
  pcd_account_ids: [],
  lts_account_ids: [],
  // 用户信息
  userInfo: {
    username: '',
    email: '',
    fullName: ''
  },
  // 统计数据
  stats: {
    dailyOrders: 0,
    pcdDailyOrders: 0,
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
  // 数据存储
  daily_data: null,
  pcd_daily_data: null,
  report_data: null,
  t2_data: null,
  t2_analysis_data: null,
  latest_data: null,
  vvip_data: null,
  analysis_data: null,
  orgInfo: null
};