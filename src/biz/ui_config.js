/**
 * UI 配置常量
 * 存放子菜单配置、默认午餐地点等静态配置数据
 */

// 子菜单配置
export const submenuConfig = {
    'lts': {
        title: 'LTS',
        icon: 'fas fa-cubes',
        items: [
            { step: 5, text: '概览', icon: 'fas fa-home' },
            { step: 2, text: '获取当日数据', icon: 'fas fa-calendar-day' },
            { step: 3, text: '获取报表数据', icon: 'fas fa-chart-bar' },
            { step: 4, text: '获取文件数据', icon: 'fas fa-file-upload' },
            { step: 10, text: '数据分析', icon: 'fas fa-chart-pie' },
            { step: 9, text: 'VVIP', icon: 'fas fa-star' },
            { step: 12, text: 'T-4 Outstanding', icon: 'fas fa-file-alt' },
            { step: 13, text: 'T-4 Outstanding分析', icon: 'fas fa-chart-line' }
        ]
    },
    'ott': {
        title: 'OTT',
        icon: 'fas fa-tv',
        items: [
            { step: 7, text: 'OTT', icon: 'fas fa-tv' }
        ]
    },
    'pcd': {
        title: 'PCD',
        icon: 'fas fa-laptop-code',
        items: [
            { step: 8, text: 'PCD', icon: 'fas fa-laptop-code' },
            { step: 16, text: 'Data issue - PID fallout', icon: 'fas fa-exclamation-triangle' },
            { step: 17, text: 'Data issue - QC issue', icon: 'fas fa-search' }
        ]
    },
    'cvp7': {
        title: 'CVP7',
        icon: 'fas fa-network-wired',
        items: [
            { step: 11, text: 'CVP7', icon: 'fas fa-network-wired' }
        ]
    },
    'tools': {
        title: 'Tools',
        icon: 'fas fa-tools',
        items: [
            { step: 15, text: 'Bulk 操作', icon: 'fas fa-database' },
            { step: 19, text: 'Schedule Jobs', icon: 'fas fa-clock' },
            { step: 18, text: 'Execute Anonymous', icon: 'fas fa-code' }
        ]
    },
    'misc': {
        title: 'Misc',
        icon: 'fas fa-ellipsis-h',
        items: [
            { step: 14, text: '中午食乜', icon: 'fas fa-utensils' }
        ]
    },
    'settings': {
        title: 'Setup',
        icon: 'fas fa-cog',
        items: [
            { step: 6, text: '版本信息', icon: 'fas fa-info-circle' }
        ]
    }
};

// Section 到模块的映射
export const sectionToModule = {
    1: null,    // 连接设置 - 已移除，不显示横向菜单
    2: 'lts',   // 获取当日数据
    3: 'lts',   // 获取报表数据
    4: 'lts',   // 获取文件数据
    5: 'lts',   // LTS 概览
    6: 'settings', // 版本信息 - 显示设置横向菜单
    7: 'ott',   // OTT
    8: 'pcd',   // PCD
    9: 'lts',   // VVIP
    10: 'lts',  // 数据分析
    11: 'cvp7', // CVP7
    12: 'lts',  // T-4 Outstanding
    13: 'lts',  // T-4 Outstanding分析
    14: 'misc',  // 中午食乜
    15: 'tools', // Bulk 操作
    16: 'pcd',  // PCD PID Fallout
    17: 'pcd',  // PCD QC Issue
    18: 'tools',  // Execute Anonymous
    19: 'tools'   // Schedule Jobs
};

// 默认午餐地点
export const DEFAULT_LUNCH_PLACES = [
    { "name": "万达兰州拉面" },
    { "name": "京华胜记" },
    { "name": "京华牛杂面" },
    { "name": "荣耀国际" },
    { "name": "负一楼" },
    { "name": "万达木桶饭" }
];

// 默认 stats 对象结构
export const DEFAULT_STATS = {
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
};

// 默认 userInfo 对象结构
export const DEFAULT_USER_INFO = {
    username: '',
    email: '',
    fullName: '',
    thumbnail: ''
};

// Bulk Jobs 表格显示字段
export const BULK_JOBS_DISPLAY_FIELDS = [
    'id', 'operation', 'state', 'query', 
    'createdDate', 'numberOfRecordsProcessed', 
    'numberOfRecordsFailed', 'totalProcessingTime'
];
