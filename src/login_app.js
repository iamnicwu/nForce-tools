// login.html JavaScript Logic
// API Version
import { createLogger, maskSecret } from "./common/logger.js";
const log = createLogger("LOGIN");
const defaultApiVersion = "65.0";

// State
let availableSessions = [];
let selectedSessionIndex = -1;

// DOM Elements
const loadingState = document.getElementById('loading-state');
const sessionListContainer = document.getElementById('session-list-container');
const loginBtn = document.getElementById('login-btn');
const noSession = document.getElementById('no-session');
const showManualLogin = document.getElementById('show-manual-login');
const manualLoginSection = document.getElementById('manual-login-section');
const manualLoginBtn = document.getElementById('manual-login-btn');
const sessionIdInput = document.getElementById('session-id');
const errorMsg = document.getElementById('error-msg');


// Get domain from tab URL
function getDomain(currentTabUrl) {
    log.debug('getDomain called with:', currentTabUrl);
    if (currentTabUrl) {
        if (currentTabUrl.includes(".lightning.force.com")) {
            const domain = currentTabUrl.split(".lightning.force.com")[0] + ".my.salesforce.com";
            log.debug('Lightning domain extracted:', domain);
            return domain;
        } else if (currentTabUrl.includes(".my.salesforce.com")) {
            const domain = currentTabUrl.split(".my.salesforce.com")[0] + ".my.salesforce.com";
            log.debug('MySalesforce domain extracted:', domain);
            return domain;
        }
    }
    log.warn('无法从 URL 提取域名:', currentTabUrl);
    return null;
}

// Test connection and get user info
async function testConnectionWithUserInfo(session_id, instanceUrl) {
    log.debug('testConnectionWithUserInfo called');
    log.debug('session_id:', session_id ? maskSecret(session_id) : 'null');
    log.debug('instanceUrl:', instanceUrl);
    
    try {
        // let finalInstanceUrl = instanceUrl || "https://here2serve.my.salesforce.com";
        // if (finalInstanceUrl === "https://here2serve.lightning.force.com") {
        //     finalInstanceUrl = "https://here2serve.my.salesforce.com";
        //     log.debug('Converted lightning URL to:', finalInstanceUrl);
        // }
        
        log.debug('Creating jsforce connection...');
        const conn = new jsforce.Connection({
            instanceUrl: instanceUrl,
            serverUrl: `${instanceUrl}/services/Soap/u/${defaultApiVersion}`,
            sessionId: session_id,
            version: defaultApiVersion,
        });
        
        log.debug('Calling conn.identity()...');
        const userInfo = await conn.identity();
        log.debug('User identity retrieved successfully');
        // 安全：不输出完整的 userInfo 对象，避免泄露敏感信息
        log.debug('User:', userInfo.display_name || userInfo.name || userInfo.username);
        log.debug('User photos available:', !!userInfo.photos);
        log.debug('User thumbnail available:', !!userInfo.thumbnail);
        
        let orgInfo = null;
        try {
            log.debug('Querying Organization info...');
            const orgResult = await conn.query("SELECT Id, IsSandbox, OrganizationType FROM Organization");
            if (orgResult.records && orgResult.records.length > 0) {
                orgInfo = orgResult.records[0];
                log.debug('Organization info:', orgInfo);
            }
        } catch (orgErr) {
            log.warn('获取组织信息失败:', orgErr);
        }
        
        const result = {
            success: true,
            userInfo: {
                username: userInfo.username || userInfo.user_id || '',
                email: userInfo.email || '',
                fullName: userInfo.display_name || userInfo.name || '',
                thumbnail: userInfo.photos?.thumbnail || userInfo.photos?.[0]?.thumbnail || userInfo.thumbnail || userInfo.photos?.picture || ''
            },
            orgInfo: orgInfo,
            connection: conn
        };
        
        log.debug('testConnectionWithUserInfo SUCCESS');
        // 安全：不输出完整的 result 对象，避免泄露敏感信息
        return result;
    } catch (err) {
        log.error('连接测试失败:', err);
        return { success: false, error: err.message };
    }
}

// Auto detect sessions
async function autoDetectSession() {
    log.debug('========== autoDetectSession START ==========');
    
    try {
        log.debug('Querying Chrome tabs for Salesforce URLs...');
        const tabs = await chrome.tabs.query({
            url: [
                "https://*.salesforce.com/*",
                "https://*.force.com/*",
                "https://*.salesforce-setup.com/*",
            ],
        });
        
        log.debug('Tabs query result:', tabs);
        log.debug('Total tabs found:', tabs ? tabs.length : 0);
        
        const availableSessions = [];
        // const processedDomains = new Set();
        
        if (tabs && tabs.length > 0) {
            log.debug(`Processing ${tabs.length} tabs...`);
            
            for (const tab of tabs) {
                log.debug('-----------------------------------');
                log.debug('Processing tab:', {
                    id: tab.id,
                    url: tab.url,
                    title: tab.title
                });
                
                try {
                    const url = new URL(tab.url);
                    // const instanceUrl = url.origin;
                    const hostname = url.hostname;
                    
                    
                    // Extract domain key
                    let domainKey = hostname;
                    if (hostname.includes('--')) {
                        domainKey = hostname.split('--')[0];
                        log.debug('  Domain key (with --):', domainKey);
                    } else {
                        domainKey = hostname.split('.')[0];
                        log.debug('  Domain key (simple):', domainKey);
                    }
                    
                    
                    
                    // Get cookie URL
                    const cookieUrl = getDomain(tab.url);
                    log.debug('  Cookie URL:', cookieUrl);
                    
                    if (!cookieUrl) {
                        log.warn('  SKIP: Could not get cookie URL');
                        continue;
                    }
                    
                    // Get session from cookies
                    log.debug('  Getting cookies for sid...');
                    const cookies = await chrome.cookies.getAll({ url: cookieUrl, name: "sid" });
                    log.debug('  Cookies result:', cookies);
                    
                    if (cookies && cookies.length > 0) {
                        const cookieValue = cookies[0].value;
                        log.debug('  Cookie value (first 50 chars):', cookieValue ? cookieValue.substring(0, 50) + '...' : 'null');
                        const instanceUrl = "https://"+getDomain(cookies[0].domain);
                        log.debug("cookies[0].domain: ", instanceUrl);
                        // Parse session ID from cookie
                        // Cookie format: something!sessionId
                        const parts = cookieValue.split('!');
                        log.debug('  Cookie split parts:', parts.length);
                        
                        let sid = null;
                        if (parts.length >= 2) {
                            sid = parts[1];
                        } else if (parts.length === 1) {
                            sid = parts[0];
                        }
                        
                        log.debug('  Extracted SID:', sid ? sid.substring(0, 20) + '...' : 'null');
                        
                        log.debug("abc instanceUrl: ", instanceUrl);
                        if (sid) {
                            log.debug('  Testing connection...');
                            const connectionResult = await testConnectionWithUserInfo(sid, instanceUrl);
                            
                            if (connectionResult.success) {
                                log.debug('  Connection SUCCESS!');
                                availableSessions.push({
                                    sid: sid,
                                    instanceUrl: instanceUrl,
                                    tabId: tab.id,
                                    tabTitle: tab.title,
                                    userInfo: connectionResult.userInfo,
                                    orgInfo: connectionResult.orgInfo,
                                    connection: connectionResult.connection
                                });
                                log.debug('  Session added to availableSessions, total:', availableSessions.length);
                            } else {
                                log.warn('  Connection FAILED');
                            }
                        }
                    } else {
                        log.warn('  No cookies found for this tab');
                    }
                } catch (err) {
                    log.error('  Error processing tab:', err);
                }
            }
        } else {
            log.warn('未找到 Salesforce 标签页');
        }
        
        // Deduplicate sessions by sid + instanceUrl combination
        const seen = new Set();
        const deduplicatedSessions = availableSessions.filter(session => {
            const key = `${session.sid}::${session.instanceUrl}`;
            if (seen.has(key)) {
                log.debug(`  Deduplicating duplicate session: ${session.instanceUrl} (${session.userInfo?.username})`);
                return false;
            }
            seen.add(key);
            return true;
        });
        
        log.debug('========== autoDetectSession END ==========');
        log.debug('Total sessions before deduplication:', availableSessions.length);
        log.debug('Total sessions after deduplication:', deduplicatedSessions.length);
        deduplicatedSessions.forEach((s, i) => {
            log.debug(`  Session ${i}:`, {
                instanceUrl: s.instanceUrl,
                username: s.userInfo?.username,
                fullName: s.userInfo?.fullName
            });
        });
        
        return deduplicatedSessions;
    } catch (error) {
        log.error('自动检测 Session 失败:', error);
        return [];
    }
}

// Render session list
function renderSessionList(sessions) {
    log.debug('renderSessionList called with', sessions ? sessions.length : 0, 'sessions');
    
    if (!sessionListContainer) {
        log.error('未找到 #session-list-container 容器!');
        return;
    }
    
    sessionListContainer.innerHTML = '';
    
    if (!sessions || sessions.length === 0) {
        log.warn('没有可渲染的会话');
        return;
    }
    
    sessions.forEach((session, index) => {
        log.debug('Rendering session', index, ':', session.instanceUrl);
        
        const card = document.createElement('div');
        card.className = 'session-card';
        card.dataset.index = index;
        
        // Determine environment type
        const isSandbox = session.orgInfo?.IsSandbox;
        let envClass = 'unknown';
        let envLabel = 'Unknown';
        if (isSandbox === true) {
            envClass = 'sandbox';
            envLabel = 'Sandbox';
        } else if (isSandbox === false) {
            envClass = 'production';
            envLabel = 'Production';
        }
        
        log.debug('  Environment:', envLabel, 'IsSandbox:', isSandbox);
        
        // Extract domain for display
        let domainDisplay = session.instanceUrl;
        try {
            const url = new URL(session.instanceUrl);
            domainDisplay = url.hostname;
        } catch (e) {
            log.warn('  Could not parse domain:', e);
        }
        
        const userDisplay = session.userInfo?.fullName || session.userInfo?.username || 'Unknown User';
        const emailDisplay = session.userInfo?.email || '-';
        
        log.debug('  User:', userDisplay);
        log.debug('  Email:', emailDisplay);
        
        card.innerHTML = `
            <span class="session-env ${envClass}">${envLabel}</span>
            <div class="session-domain">${domainDisplay}</div>
            <div class="session-user">${userDisplay}</div>
            <div class="session-email">${emailDisplay}</div>
        `;
        
        card.addEventListener('click', () => {
            log.debug('Session card clicked, index:', index);
            selectSession(index);
        });
        
        sessionListContainer.appendChild(card);
    });
    
    log.debug('renderSessionList complete');
}

// Select session
function selectSession(index) {
    log.debug('selectSession called with index:', index);
    
    selectedSessionIndex = index;
    
    // Update UI
    const cards = document.querySelectorAll('.session-card');
    log.debug('Found', cards.length, 'session cards');
    
    cards.forEach((card, i) => {
        const isSelected = i === index;
        log.debug('  Card', i, 'selected:', isSelected);
        card.classList.toggle('selected', isSelected);
    });
    
    if (loginBtn) {
        loginBtn.disabled = false;
        const session = availableSessions[index];
        const userName = session?.userInfo?.fullName || session?.userInfo?.username || '此环境';
        loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i><span>登录到 ' + userName + '</span>';
        log.debug('Login button updated, user:', userName);
    } else {
        log.error('未找到 #login-btn!');
    }
}

// Handle login
async function handleLogin() {
    log.debug('handleLogin called');
    log.debug('selectedSessionIndex:', selectedSessionIndex);
    log.debug('availableSessions.length:', availableSessions.length);
    
    if (selectedSessionIndex < 0 || selectedSessionIndex >= availableSessions.length) {
        log.error('无效的会话索引!');
        return;
    }
    
    const session = availableSessions[selectedSessionIndex];
    log.debug('Selected session:', {
        instanceUrl: session.instanceUrl,
        username: session.userInfo?.username,
        fullName: session.userInfo?.fullName
    });
    
    // Save to chrome.storage.local
    log.debug('Saving to chrome.storage.local...');
    try {
        await chrome.storage.local.set({
            sf_session_id: session.sid,
            sf_instance_url: session.instanceUrl,
            is_connected: true,
            userInfo: session.userInfo,
            orgInfo: session.orgInfo
        });
        log.debug('chrome.storage.local saved successfully');
    } catch (e) {
        log.error('写入 chrome.storage.local 失败:', e);
    }
    
    // Session 信息仅保存在 chrome.storage.local 中，不再存储到 localStorage
    // localStorage 可被同源脚本访问，存在安全风险
    log.debug('Session saved to chrome.storage.local only (localStorage removed for security)');
    
    // Show success
    if (loginBtn) {
        loginBtn.innerHTML = '<i class="fas fa-check"></i><span>登录成功！</span>';
        loginBtn.style.background = 'var(--success-color)';
        log.debug('Login button updated to success state');
    }
    
    // Navigate to index.html after delay
    log.debug('Scheduling redirect to index.html...');
    setTimeout(() => {
        log.debug('Creating new tab with index.html...');
        chrome.tabs.create({
            url: chrome.runtime.getURL('index.html')
        }, (tab) => {
            log.debug('New tab created:', tab);
            window.close();
        });
    }, 500);
}

// Show manual login
if (showManualLogin) {
    log.debug('showManualLogin button found, adding listener');
    showManualLogin.addEventListener('click', () => {
        log.debug('showManualLogin clicked');
        if (manualLoginSection) {
            manualLoginSection.style.display = 'block';
            log.debug('manualLoginSection shown');
        }
        if (noSession) {
            noSession.style.display = 'none';
            log.debug('noSession hidden');
        }
    });
} else {
    log.warn('未找到 #show-manual-login');
}

// Manual login
if (manualLoginBtn) {
    log.debug('manualLoginBtn found, adding listener');
    manualLoginBtn.addEventListener('click', async () => {
        log.debug('manualLoginBtn clicked');
        
        const sessionId = sessionIdInput ? sessionIdInput.value.trim() : '';
        log.debug('Session ID 输入:', sessionId ? maskSecret(sessionId) : 'empty');
        
        if (!sessionId) {
            if (errorMsg) {
                errorMsg.textContent = '请输入 Session ID';
                errorMsg.classList.add('show');
            }
            log.warn('未输入 Session ID');
            return;
        }
        
        if (errorMsg) {
            errorMsg.classList.remove('show');
        }
        
        if (manualLoginBtn) {
            manualLoginBtn.disabled = true;
            manualLoginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>验证中...</span>';
        }
        
        log.debug('Calling testConnectionWithUserInfo...');
        const result = await testConnectionWithUserInfo(sessionId);
        
        if (result.success) {
            log.debug('Manual login SUCCESS');
            
            // Save to chrome.storage.local
            await chrome.storage.local.set({
                sf_session_id: sessionId,
                sf_instance_url: result.userInfo.instanceUrl || null,
                is_connected: true,
                userInfo: result.userInfo,
                orgInfo: result.orgInfo
            });
            
            // Session 信息仅保存在 chrome.storage.local 中，不再存储到 localStorage
            // localStorage 可被同源脚本访问，存在安全风险
            
            if (manualLoginBtn) {
                manualLoginBtn.innerHTML = '<i class="fas fa-check"></i><span>登录成功！</span>';
                manualLoginBtn.style.background = 'var(--success-color)';
            }
            
            setTimeout(() => {
                chrome.tabs.create({
                    url: chrome.runtime.getURL('index.html')
                });
                window.close();
            }, 500);
        } else {
            log.error('手动登录失败');
            if (errorMsg) {
                errorMsg.textContent = 'Session ID 无效或已过期';
                errorMsg.classList.add('show');
            }
            if (manualLoginBtn) {
                manualLoginBtn.disabled = false;
                manualLoginBtn.innerHTML = '<i class="fas fa-check"></i><span>验证并登录</span>';
            }
        }
    });
} else {
    log.warn('未找到 #manual-login-btn');
}

// Login button click
if (loginBtn) {
    log.debug('loginBtn found, adding listener');
    loginBtn.addEventListener('click', handleLogin);
} else {
    log.error('未找到 #login-btn!');
}

// Initialize
async function init() {
    log.debug('========================================');
    log.debug('nForce Tools Login Page Initializing...');
    log.debug('========================================');
    
    log.debug('Checking DOM elements...');
    log.debug('  loadingState:', loadingState ? 'found' : 'NULL');
    log.debug('  sessionListContainer:', sessionListContainer ? 'found' : 'NULL');
    log.debug('  loginBtn:', loginBtn ? 'found' : 'NULL');
    log.debug('  noSession:', noSession ? 'found' : 'NULL');
    log.debug('  showManualLogin:', showManualLogin ? 'found' : 'NULL');
    log.debug('  manualLoginSection:', manualLoginSection ? 'found' : 'NULL');
    log.debug('  manualLoginBtn:', manualLoginBtn ? 'found' : 'NULL');
    log.debug('  sessionIdInput:', sessionIdInput ? 'found' : 'NULL');
    log.debug('  errorMsg:', errorMsg ? 'found' : 'NULL');
    
    log.debug('Calling autoDetectSession()...');
    const sessions = await autoDetectSession();
    availableSessions = sessions;
    
    log.debug('autoDetectSession returned, sessions count:', sessions ? sessions.length : 0);
    
    // Hide loading state
    if (loadingState) {
        loadingState.style.display = 'none';
        log.debug('Loading state hidden');
    } else {
        log.error('未找到 #loading-state，无法隐藏');
    }
    
    if (sessions && sessions.length > 0) {
        log.debug('Sessions available, sessions count:', sessions.length);
        
        if (sessions.length === 1) {
            // Auto login when only one session found
            log.debug('Single session found, auto-logging in...');
            availableSessions = sessions;
            selectedSessionIndex = 0;
            
            // Auto login directly
            await handleLogin();
        } else {
            // Multiple sessions - show selection list
            log.debug('Multiple sessions, showing selection list...');
            
            renderSessionList(sessions);
            
            if (sessionListContainer) {
                sessionListContainer.style.display = 'block';
            }
            log.debug('Session list displayed');
        }
    } else {
        // No sessions found
        log.warn('未发现可用会话，显示无会话提示');
        
        if (noSession) {
            noSession.style.display = 'block';
            log.debug('noSession shown');
        }
        
        if (loginBtn) {
            loginBtn.style.display = 'none';
            log.debug('loginBtn hidden');
        }
    }
    
    log.debug('========================================');
    log.debug('Initialization complete');
    log.debug('========================================');
}

// Start initialization when DOM is ready
log.debug('Script loaded, checking document.readyState:', document.readyState);

if (document.readyState === 'loading') {
    log.debug('Document still loading, waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', () => {
        log.debug('DOMContentLoaded fired');
        init();
    });
} else {
    log.debug('Document already loaded, calling init() directly');
    init();
}
