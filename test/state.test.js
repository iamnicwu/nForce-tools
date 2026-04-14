/**
 * 单元测试: src/biz/state.js
 * 测试全局状态管理: appState
 */

describe('state.js - 全局状态管理测试', () => {
  // 由于 state.js 导出的是引用，直接导入会修改原状态
  // 我们需要创建一个 mock 来测试状态结构
  let appState;

  beforeEach(() => {
    // 每个测试前重置状态
    jest.resetModules();
    const state = require('../src/biz/state.js');
    appState = state.appState;
  });

  describe('appState 结构验证', () => {
    test('appState 对象存在', () => {
      expect(appState).toBeDefined();
      expect(typeof appState).toBe('object');
    });

    test('session_id 初始为 null', () => {
      expect(appState.session_id).toBeNull();
    });

    test('instance_url 初始为 null', () => {
      expect(appState.instance_url).toBeNull();
    });

    test('is_connected 初始为 false', () => {
      expect(appState.is_connected).toBe(false);
    });

    test('available_sessions 初始为 null', () => {
      expect(appState.available_sessions).toBeNull();
    });

    test('数据状态标志初始为 false', () => {
      expect(appState.has_daily_data).toBe(false);
      expect(appState.has_pcd_daily_data).toBe(false);
      expect(appState.has_pcd_pid_fallout_data).toBe(false);
      expect(appState.has_pcd_qc_issue_data).toBe(false);
      expect(appState.has_report_data).toBe(false);
      expect(appState.has_t2_data).toBe(false);
      expect(appState.has_file).toBe(false);
      expect(appState.has_vvip_file).toBe(false);
      expect(appState.has_analysis_file).toBe(false);
      expect(appState.has_t2_analysis_file).toBe(false);
      expect(appState.has_lunch_file).toBe(false);
    });

    test('lunch_places 初始为空数组', () => {
      expect(Array.isArray(appState.lunch_places)).toBe(true);
      expect(appState.lunch_places.length).toBe(0);
    });

    test('custom_rules 初始为 null', () => {
      expect(appState.custom_rules).toBeNull();
    });

    test('t2_custom_rules 初始为 null', () => {
      expect(appState.t2_custom_rules).toBeNull();
    });

    test('t2_default_rules 初始为 null', () => {
      expect(appState.t2_default_rules).toBeNull();
    });

    test('readme_loaded 初始为 false', () => {
      expect(appState.readme_loaded).toBe(false);
    });

    test('lts_summary_loaded 初始为 false', () => {
      expect(appState.lts_summary_loaded).toBe(false);
    });

    test('order_numbers 初始为空数组', () => {
      expect(Array.isArray(appState.order_numbers)).toBe(true);
      expect(appState.order_numbers.length).toBe(0);
    });

    test('account_ids 初始为空数组', () => {
      expect(Array.isArray(appState.account_ids)).toBe(true);
      expect(appState.account_ids.length).toBe(0);
    });

    test('pcd_account_ids 初始为空数组', () => {
      expect(Array.isArray(appState.pcd_account_ids)).toBe(true);
      expect(appState.pcd_account_ids.length).toBe(0);
    });

    test('lts_account_ids 初始为空数组', () => {
      expect(Array.isArray(appState.lts_account_ids)).toBe(true);
      expect(appState.lts_account_ids.length).toBe(0);
    });
  });

  describe('userInfo 结构验证', () => {
    test('userInfo 对象存在', () => {
      expect(appState.userInfo).toBeDefined();
      expect(typeof appState.userInfo).toBe('object');
    });

    test('userInfo 包含必要字段', () => {
      expect(appState.userInfo).toHaveProperty('username');
      expect(appState.userInfo).toHaveProperty('email');
      expect(appState.userInfo).toHaveProperty('fullName');
      expect(appState.userInfo).toHaveProperty('thumbnail');
    });

    test('userInfo 字段初始为空字符串', () => {
      expect(appState.userInfo.username).toBe('');
      expect(appState.userInfo.email).toBe('');
      expect(appState.userInfo.fullName).toBe('');
      expect(appState.userInfo.thumbnail).toBe('');
    });
  });

  describe('stats 结构验证', () => {
    test('stats 对象存在', () => {
      expect(appState.stats).toBeDefined();
      expect(typeof appState.stats).toBe('object');
    });

    test('stats 包含所有计数字段且初始为 0', () => {
      expect(appState.stats.dailyOrders).toBe(0);
      expect(appState.stats.pcdDailyOrders).toBe(0);
      expect(appState.stats.pcdPidFalloutOrders).toBe(0);
      expect(appState.stats.pcdQCIssueOrders).toBe(0);
      expect(appState.stats.reportRecords).toBe(0);
      expect(appState.stats.t2Records).toBe(0);
      expect(appState.stats.uploadedOrders).toBe(0);
      expect(appState.stats.fetchedData).toBe(0);
      expect(appState.stats.uploadedAccounts).toBe(0);
      expect(appState.stats.ltsAccounts).toBe(0);
      expect(appState.stats.uploadedPcdAccounts).toBe(0);
      expect(appState.stats.uploadedLtsAccounts).toBe(0);
      expect(appState.stats.vvipOrders).toBe(0);
      expect(appState.stats.ltsOrders).toBe(0);
      expect(appState.stats.analysisRecords).toBe(0);
      expect(appState.stats.t2AnalysisRecords).toBe(0);
    });
  });

  describe('dataStorage 结构验证', () => {
    test('数据存储字段初始为 null', () => {
      expect(appState.daily_data).toBeNull();
      expect(appState.pcd_daily_data).toBeNull();
      expect(appState.pcd_pid_fallout_data).toBeNull();
      expect(appState.pcd_qc_issue_data).toBeNull();
      expect(appState.report_data).toBeNull();
      expect(appState.t2_data).toBeNull();
      expect(appState.t2_analysis_data).toBeNull();
      expect(appState.latest_data).toBeNull();
      expect(appState.vvip_data).toBeNull();
      expect(appState.analysis_data).toBeNull();
      expect(appState.orgInfo).toBeNull();
    });
  });

  describe('状态更新测试', () => {
    test('可以更新 session_id', () => {
      const testSessionId = 'test_session_123';
      appState.session_id = testSessionId;
      expect(appState.session_id).toBe(testSessionId);
    });

    test('可以更新 is_connected', () => {
      appState.is_connected = true;
      expect(appState.is_connected).toBe(true);
    });

    test('可以更新 userInfo', () => {
      const testUserInfo = {
        username: 'test.user',
        email: 'test@example.com',
        fullName: 'Test User',
        thumbnail: 'http://example.com/photo.jpg'
      };
      appState.userInfo = testUserInfo;
      expect(appState.userInfo).toEqual(testUserInfo);
    });

    test('可以更新 stats', () => {
      appState.stats.dailyOrders = 100;
      expect(appState.stats.dailyOrders).toBe(100);
    });

    test('可以更新 order_numbers', () => {
      const testOrders = ['001', '002', '003'];
      appState.order_numbers = testOrders;
      expect(appState.order_numbers).toEqual(testOrders);
    });

    test('可以更新 lunch_places', () => {
      const testPlaces = [
        { name: 'Restaurant A' },
        { name: 'Restaurant B' }
      ];
      appState.lunch_places = testPlaces;
      expect(appState.lunch_places).toEqual(testPlaces);
    });
  });
});
