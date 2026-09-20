// login.html JavaScript Logic
// API Version
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

// Debug logging helper
function debugLog(...args) {
    console.log('[nForce Tools Login]', new Date().toISOString(), ...args);
}

function debugError(...args) {
    console.error('[nForce Tools Login ERROR]', new Date().toISOString(), ...args);
}

function debugWarn(...args) {
    console.warn('[nForce Tools Login WARN]', new Date().toISOString(), ...args);
}

// Get domain from tab URL
function getDomain(currentTabUrl) {
    debugLog('getDomain called with:', currentTabUrl);
    if (currentTabUrl) {
        if (currentTabUrl.includes(".lightning.force.com")) {
            const domain = currentTabUrl.split(".lightning.force.com")[0] + ".my.salesforce.com";
            debugLog('Lightning domain extracted:', domain);
            return domain;
        } else if (currentTabUrl.includes(".my.salesforce.com")) {
            const domain = currentTabUrl.split(".my.salesforce.com")[0] + ".my.salesforce.com";
            debugLog('MySalesforce domain extracted:', domain);
            return domain;
        }
    }
    debugWarn('Could not extract domain from:', currentTabUrl);
    return null;
}

// Test connection and get user info
async function testConnectionWithUserInfo(session_id, instanceUrl) {
    debugLog('testConnectionWithUserInfo called');
    debugLog('session_id:', session_id ? session_id.substring(0, 20) + '...' : 'null');
    debugLog('instanceUrl:', instanceUrl);
    
    try {
        // let finalInstanceUrl = instanceUrl || "https://here2serve.my.salesforce.com";
        // if (finalInstanceUrl === "https://here2serve.lightning.force.com") {
        //     finalInstanceUrl = "https://here2serve.my.salesforce.com";
        //     debugLog('Converted lightning URL to:', finalInstanceUrl);
        // }
        
        debugLog('Creating jsforce connection...');
        const conn = new jsforce.Connection({
            instanceUrl: instanceUrl,
            serverUrl: `${instanceUrl}/services/Soap/u/${defaultApiVersion}`,
            sessionId: session_id,
            version: defaultApiVersion,
        });
        
        debugLog('Calling conn.identity()...');
        const userInfo = await conn.identity();
        debugLog('User identity retrieved successfully');
        // 安全：不输出完整的 userInfo 对象，避免泄露敏感信息
        debugLog('User:', userInfo.display_name || userInfo.name || userInfo.username);
        debugLog('User photos available:', !!userInfo.photos);
        debugLog('User thumbnail available:', !!userInfo.thumbnail);
        
        let orgInfo = null;
        try {
            debugLog('Querying Organization info...');
            const orgResult = await conn.query("SELECT Id, IsSandbox, OrganizationType FROM Organization");
            if (orgResult.records && orgResult.records.length > 0) {
                orgInfo = orgResult.records[0];
                debugLog('Organization info:', orgInfo);
            }
        } catch (orgErr) {
            debugWarn('获取组织信息失败:', orgErr);
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
        
        debugLog('testConnectionWithUserInfo SUCCESS');
        // 安全：不输出完整的 result 对象，避免泄露敏感信息
        return result;
    } catch (err) {
        debugError('testConnectionWithUserInfo FAILED:', err);
        return { success: false, error: err.message };
    }
}

// Auto detect sessions
async function autoDetectSession() {
    debugLog('========== autoDetectSession START ==========');
    
    try {
        debugLog('Querying Chrome tabs for Salesforce URLs...');
        const tabs = await chrome.tabs.query({
            url: [
                "https://*.salesforce.com/*",
                "https://*.force.com/*",
                "https://*.salesforce-setup.com/*",
            ],
        });
        
        debugLog('Tabs query result:', tabs);
        debugLog('Total tabs found:', tabs ? tabs.length : 0);
        
        const availableSessions = [];
        // const processedDomains = new Set();
        
        if (tabs && tabs.length > 0) {
            debugLog(`Processing ${tabs.length} tabs...`);
            
            for (const tab of tabs) {
                debugLog('-----------------------------------');
                debugLog('Processing tab:', {
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
                        debugLog('  Domain key (with --):', domainKey);
                    } else {
                        domainKey = hostname.split('.')[0];
                        debugLog('  Domain key (simple):', domainKey);
                    }
                    
                    
                    
                    // Get cookie URL
                    const cookieUrl = getDomain(tab.url);
                    debugLog('  Cookie URL:', cookieUrl);
                    
                    if (!cookieUrl) {
                        debugWarn('  SKIP: Could not get cookie URL');
                        continue;
                    }
                    
                    // Get session from cookies
                    debugLog('  Getting cookies for sid...');
                    const cookies = await chrome.cookies.getAll({ url: cookieUrl, name: "sid" });
                    debugLog('  Cookies result:', cookies);
                    
                    if (cookies && cookies.length > 0) {
                        const cookieValue = cookies[0].value;
                        debugLog('  Cookie value (first 50 chars):', cookieValue ? cookieValue.substring(0, 50) + '...' : 'null');
                        const instanceUrl = "https://"+getDomain(cookies[0].domain);
                        console.log("cookies[0].domain: ", instanceUrl);
                        // Parse session ID from cookie
                        // Cookie format: something!sessionId
                        const parts = cookieValue.split('!');
                        debugLog('  Cookie split parts:', parts.length);
                        
                        let sid = null;
                        if (parts.length >= 2) {
                            sid = parts[1];
                        } else if (parts.length === 1) {
                            sid = parts[0];
                        }
                        
                        debugLog('  Extracted SID:', sid ? sid.substring(0, 20) + '...' : 'null');
                        
                        console.log("abc instanceUrl: ", instanceUrl);
                        if (sid) {
                            debugLog('  Testing connection...');
                            const connectionResult = await testConnectionWithUserInfo(sid, instanceUrl);
                            
                            if (connectionResult.success) {
                                debugLog('  Connection SUCCESS!');
                                availableSessions.push({
                                    sid: sid,
                                    instanceUrl: instanceUrl,
                                    tabId: tab.id,
                                    tabTitle: tab.title,
                                    userInfo: connectionResult.userInfo,
                                    orgInfo: connectionResult.orgInfo,
                                    connection: connectionResult.connection
                                });
                                debugLog('  Session added to availableSessions, total:', availableSessions.length);
                            } else {
                                debugWarn('  Connection FAILED');
                            }
                        }
                    } else {
                        debugWarn('  No cookies found for this tab');
                    }
                } catch (err) {
                    debugError('  Error processing tab:', err);
                }
            }
        } else {
            debugWarn('No Salesforce tabs found');
        }
        
        // Deduplicate sessions by sid + instanceUrl combination
        const seen = new Set();
        const deduplicatedSessions = availableSessions.filter(session => {
            const key = `${session.sid}::${session.instanceUrl}`;
            if (seen.has(key)) {
                debugLog(`  Deduplicating duplicate session: ${session.instanceUrl} (${session.userInfo?.username})`);
                return false;
            }
            seen.add(key);
            return true;
        });
        
        debugLog('========== autoDetectSession END ==========');
        debugLog('Total sessions before deduplication:', availableSessions.length);
        debugLog('Total sessions after deduplication:', deduplicatedSessions.length);
        deduplicatedSessions.forEach((s, i) => {
            debugLog(`  Session ${i}:`, {
                instanceUrl: s.instanceUrl,
                username: s.userInfo?.username,
                fullName: s.userInfo?.fullName
            });
        });
        
        return deduplicatedSessions;
    } catch (error) {
        debugError('autoDetectSession FAILED:', error);
        return [];
    }
}

// Render session list
function renderSessionList(sessions) {
    debugLog('renderSessionList called with', sessions ? sessions.length : 0, 'sessions');
    
    if (!sessionListContainer) {
        debugError('sessionListContainer is null!');
        return;
    }
    
    sessionListContainer.innerHTML = '';
    
    if (!sessions || sessions.length === 0) {
        debugWarn('No sessions to render');
        return;
    }
    
    sessions.forEach((session, index) => {
        debugLog('Rendering session', index, ':', session.instanceUrl);
        
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
        
        debugLog('  Environment:', envLabel, 'IsSandbox:', isSandbox);
        
        // Extract domain for display
        let domainDisplay = session.instanceUrl;
        try {
            const url = new URL(session.instanceUrl);
            domainDisplay = url.hostname;
        } catch (e) {
            debugWarn('  Could not parse domain:', e);
        }
        
        const userDisplay = session.userInfo?.fullName || session.userInfo?.username || 'Unknown User';
        const emailDisplay = session.userInfo?.email || '-';
        
        debugLog('  User:', userDisplay);
        debugLog('  Email:', emailDisplay);
        
        card.innerHTML = `
            <span class="session-env ${envClass}">${envLabel}</span>
            <div class="session-domain">${domainDisplay}</div>
            <div class="session-user">${userDisplay}</div>
            <div class="session-email">${emailDisplay}</div>
        `;
        
        card.addEventListener('click', () => {
            debugLog('Session card clicked, index:', index);
            selectSession(index);
        });
        
        sessionListContainer.appendChild(card);
    });
    
    debugLog('renderSessionList complete');
}

// Select session
function selectSession(index) {
    debugLog('selectSession called with index:', index);
    
    selectedSessionIndex = index;
    
    // Update UI
    const cards = document.querySelectorAll('.session-card');
    debugLog('Found', cards.length, 'session cards');
    
    cards.forEach((card, i) => {
        const isSelected = i === index;
        debugLog('  Card', i, 'selected:', isSelected);
        card.classList.toggle('selected', isSelected);
    });
    
    if (loginBtn) {
        loginBtn.disabled = false;
        const session = availableSessions[index];
        const userName = session?.userInfo?.fullName || session?.userInfo?.username || '此环境';
        loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i><span>登录到 ' + userName + '</span>';
        debugLog('Login button updated, user:', userName);
    } else {
        debugError('loginBtn is null!');
    }
}

// Handle login
async function handleLogin() {
    debugLog('handleLogin called');
    debugLog('selectedSessionIndex:', selectedSessionIndex);
    debugLog('availableSessions.length:', availableSessions.length);
    
    if (selectedSessionIndex < 0 || selectedSessionIndex >= availableSessions.length) {
        debugError('Invalid session index!');
        return;
    }
    
    const session = availableSessions[selectedSessionIndex];
    debugLog('Selected session:', {
        instanceUrl: session.instanceUrl,
        username: session.userInfo?.username,
        fullName: session.userInfo?.fullName
    });
    
    // Save to chrome.storage.local
    debugLog('Saving to chrome.storage.local...');
    try {
        await chrome.storage.local.set({
            sf_session_id: session.sid,
            sf_instance_url: session.instanceUrl,
            is_connected: true,
            userInfo: session.userInfo,
            orgInfo: session.orgInfo
        });
        debugLog('chrome.storage.local saved successfully');
    } catch (e) {
        debugError('chrome.storage.local save failed:', e);
    }
    
    // Session 信息仅保存在 chrome.storage.local 中，不再存储到 localStorage
    // localStorage 可被同源脚本访问，存在安全风险
    debugLog('Session saved to chrome.storage.local only (localStorage removed for security)');
    
    // Show success
    if (loginBtn) {
        loginBtn.innerHTML = '<i class="fas fa-check"></i><span>登录成功！</span>';
        loginBtn.style.background = '#52c41a';
        debugLog('Login button updated to success state');
    }
    
    // Navigate to index.html after delay
    debugLog('Scheduling redirect to index.html...');
    setTimeout(() => {
        debugLog('Creating new tab with index.html...');
        chrome.tabs.create({
            url: chrome.runtime.getURL('index.html')
        }, (tab) => {
            debugLog('New tab created:', tab);
            window.close();
        });
    }, 500);
}

// Show manual login
if (showManualLogin) {
    debugLog('showManualLogin button found, adding listener');
    showManualLogin.addEventListener('click', () => {
        debugLog('showManualLogin clicked');
        if (manualLoginSection) {
            manualLoginSection.style.display = 'block';
            debugLog('manualLoginSection shown');
        }
        if (noSession) {
            noSession.style.display = 'none';
            debugLog('noSession hidden');
        }
    });
} else {
    debugWarn('showManualLogin button NOT found');
}

// Manual login
if (manualLoginBtn) {
    debugLog('manualLoginBtn found, adding listener');
    manualLoginBtn.addEventListener('click', async () => {
        debugLog('manualLoginBtn clicked');
        
        const sessionId = sessionIdInput ? sessionIdInput.value.trim() : '';
        debugLog('Session ID input:', sessionId ? sessionId.substring(0, 20) + '...' : 'empty');
        
        if (!sessionId) {
            if (errorMsg) {
                errorMsg.textContent = '请输入 Session ID';
                errorMsg.classList.add('show');
            }
            debugWarn('No session ID entered');
            return;
        }
        
        if (errorMsg) {
            errorMsg.classList.remove('show');
        }
        
        if (manualLoginBtn) {
            manualLoginBtn.disabled = true;
            manualLoginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>验证中...</span>';
        }
        
        debugLog('Calling testConnectionWithUserInfo...');
        const result = await testConnectionWithUserInfo(sessionId);
        
        if (result.success) {
            debugLog('Manual login SUCCESS');
            
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
                manualLoginBtn.style.background = '#52c41a';
            }
            
            setTimeout(() => {
                chrome.tabs.create({
                    url: chrome.runtime.getURL('index.html')
                });
                window.close();
            }, 500);
        } else {
            debugError('Manual login FAILED');
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
    debugWarn('manualLoginBtn NOT found');
}

// Login button click
if (loginBtn) {
    debugLog('loginBtn found, adding listener');
    loginBtn.addEventListener('click', handleLogin);
} else {
    debugError('loginBtn is null!');
}

// Initialize
async function init() {
    debugLog('========================================');
    debugLog('nForce Tools Login Page Initializing...');
    debugLog('========================================');
    
    debugLog('Checking DOM elements...');
    debugLog('  loadingState:', loadingState ? 'found' : 'NULL');
    debugLog('  sessionListContainer:', sessionListContainer ? 'found' : 'NULL');
    debugLog('  loginBtn:', loginBtn ? 'found' : 'NULL');
    debugLog('  noSession:', noSession ? 'found' : 'NULL');
    debugLog('  showManualLogin:', showManualLogin ? 'found' : 'NULL');
    debugLog('  manualLoginSection:', manualLoginSection ? 'found' : 'NULL');
    debugLog('  manualLoginBtn:', manualLoginBtn ? 'found' : 'NULL');
    debugLog('  sessionIdInput:', sessionIdInput ? 'found' : 'NULL');
    debugLog('  errorMsg:', errorMsg ? 'found' : 'NULL');
    
    debugLog('Calling autoDetectSession()...');
    const sessions = await autoDetectSession();
    availableSessions = sessions;
    
    debugLog('autoDetectSession returned, sessions count:', sessions ? sessions.length : 0);
    
    // Hide loading state
    if (loadingState) {
        loadingState.style.display = 'none';
        debugLog('Loading state hidden');
    } else {
        debugError('loadingState is null, cannot hide');
    }
    
    if (sessions && sessions.length > 0) {
        debugLog('Sessions available, sessions count:', sessions.length);
        
        if (sessions.length === 1) {
            // Auto login when only one session found
            debugLog('Single session found, auto-logging in...');
            availableSessions = sessions;
            selectedSessionIndex = 0;
            
            // Auto login directly
            await handleLogin();
        } else {
            // Multiple sessions - show selection list
            debugLog('Multiple sessions, showing selection list...');
            
            renderSessionList(sessions);
            
            if (sessionListContainer) {
                sessionListContainer.style.display = 'block';
            }
            debugLog('Session list displayed');
        }
    } else {
        // No sessions found
        debugWarn('No sessions found, showing noSession UI');
        
        if (noSession) {
            noSession.style.display = 'block';
            debugLog('noSession shown');
        }
        
        if (loginBtn) {
            loginBtn.style.display = 'none';
            debugLog('loginBtn hidden');
        }
    }
    
    debugLog('========================================');
    debugLog('Initialization complete');
    debugLog('========================================');
}

// Start initialization when DOM is ready
debugLog('Script loaded, checking document.readyState:', document.readyState);

if (document.readyState === 'loading') {
    debugLog('Document still loading, waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', () => {
        debugLog('DOMContentLoaded fired');
        init();
    });
} else {
    debugLog('Document already loaded, calling init() directly');
    init();
}
