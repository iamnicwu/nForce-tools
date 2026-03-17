

// Service Worker
// 目前主要逻辑都在前端页面中处理
// 保留此文件用于将来扩展后台任务

console.log('nForce Tools Service Worker Started');

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('index.html')
  });
});