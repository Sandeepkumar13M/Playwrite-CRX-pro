// background.js — service worker
// Responsibilities:
//  - open the side panel on toolbar click
//  - relay recorded actions from content scripts (any frame) to the side panel
//  - broadcast record/stop/pick commands from the panel to all frames

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open && tab && tab.id != null) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

// Relay hub. Content scripts post {type:'ACTION'|'HOVER'|...}; panel posts {type:'CMD'}.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // From content script -> forward to panel (runtime message, panel listens)
  if (msg.from === 'content') {
    // attach frame info
    msg.frameId = sender.frameId;
    msg.url = sender.url;
    msg.relayedByBackground = true;
    chrome.runtime.sendMessage(msg).catch(() => {});
    return;
  }

  // From panel -> broadcast to all frames of the active tab
  if (msg.from === 'panel') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id == null) return;
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
    });
    sendResponse({ ok: true });
    return true;
  }
});
