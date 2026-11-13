// background.js — service worker (single source of truth)
// Responsibilities:
//  - own the recording state (recording / paused) so it survives page navigations
//  - own the recorded steps (stored in chrome.storage.session) so nothing is lost
//    while the side panel is closed
//  - relay commands (record, pick, detect, is_visible, assertions) to every frame
//  - inject content.js into tabs that were open before the extension was loaded
//  - keyboard shortcuts (Alt+Shift+R / Alt+Shift+C), context menu, REC badge

importScripts('codegen.js', 'replay.js');

const ARM_MODES = ['pick', 'detect', 'is_visible', 'assert_visible', 'assert_text', 'assert_value'];
const MAX_HTML = 20000;

let rec = { recording: false, paused: false };
let steps = [];
let settings = { testIdAttr: 'data-testid', sel: 'text', lang: 'python-pytest' };

const ready = Promise.all([
  chrome.storage.session.get(['rec', 'steps']).then((d) => {
    if (d.rec) rec = d.rec;
    if (Array.isArray(d.steps)) steps = d.steps;
  }),
  chrome.storage.local.get(['settings']).then((d) => {
    if (d.settings) settings = { ...settings, ...d.settings };
  }),
]).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = { ...settings, ...(changes.settings.newValue || {}) };
  }
});

// Serialise every state change so rapid events can't race each other.
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(() => ready).then(fn).catch((e) => console.warn('[CRX Pro]', e));
  return queue;
}

// ---------- helpers ----------
function toPanel(msg) {
  chrome.runtime.sendMessage({ from: 'bg', ...msg }).catch(() => {});
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch (_) {
    // chrome:// pages, Web Store, etc. cannot be scripted — ignore.
  }
}

async function sendToTab(tabId, msg) {
  try { await chrome.tabs.sendMessage(tabId, { from: 'bg', ...msg }); } catch (_) {}
}

let replaying = false;
// Never record while the Play button is replaying steps.
function isLive() { return rec.recording && !rec.paused && !replaying; }

async function broadcastState() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.id != null) sendToTab(t.id, { type: 'STATE', recording: isLive() });
}

async function startReplay() {
  if (Replay.isRunning()) return;
  const tab = await activeTab();
  if (!tab || tab.id == null) return toPanel({ type: 'REPLAY', status: 'failed', total: 0, log: [{ i: -1, verb: 'tab', ok: false, msg: 'No active tab' }] });
  if (!steps.some((s) => s.verb && s.verb !== 'pick')) {
    return toPanel({ type: 'REPLAY', status: 'failed', total: 0, log: [{ i: -1, verb: 'steps', ok: false, msg: 'Nothing to replay — record some steps first' }] });
  }
  replaying = true;
  await broadcastState();
  await ensureInjected(tab.id);
  // Run outside the state queue so recording commands stay responsive.
  Replay.start(JSON.parse(JSON.stringify(steps)), tab.id, (r) => toPanel({ type: 'REPLAY', ...r }), settings.sel)
    .finally(async () => { replaying = false; await broadcastState(); });
}

async function saveSteps() {
  await chrome.storage.session.set({ steps });
  toPanel({ type: 'STEPS', steps });
}

async function setRec(next) {
  rec = { ...rec, ...next };
  await chrome.storage.session.set({ rec });
  chrome.action.setBadgeText({ text: rec.recording ? (rec.paused ? '||' : 'REC') : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: rec.paused ? '#64748b' : '#ff3b30' }).catch(() => {});
  toPanel({ type: 'REC', rec });
  await broadcastState();
}

function selectorKey(step) {
  const s = step.selector || {};
  const role = s.role || {};
  const css = (s.css && s.css.value) || '';
  const frame = (step.framePath || []).join('>');
  return [step.tag || '', role.role || '', role.name || '', css, frame].join('|');
}

function addStep(action) {
  const a = { ...action };
  if (a.html && a.html.length > MAX_HTML) a.html = a.html.slice(0, MAX_HTML) + '\n<!-- truncated -->';
  const last = steps[steps.length - 1];
  const isFill = a.verb === 'fill' || a.verb === 'fill_rich';
  // Real-time typing: keep updating the last fill step for the same field.
  if (isFill && last && (last.verb === 'fill' || last.verb === 'fill_rich') && selectorKey(last) === selectorKey(a)) {
    last.value = a.value;
    return;
  }
  steps.push(a);
}

// ---------- commands ----------
async function startRecording() {
  const tab = await activeTab();
  if (tab && tab.id != null) await ensureInjected(tab.id);
  if (!steps.length && tab && /^https?:/i.test(tab.url || '')) {
    steps.push({ verb: 'goto', url: tab.url, framePath: [] });
    await saveSteps();
  }
  await setRec({ recording: true, paused: false });
}

async function handleCmd(cmd) {
  if (cmd === 'start') return startRecording();
  if (cmd === 'stop') { await setRec({ recording: false, paused: false }); return disarmAll(); }
  if (cmd === 'pause') return setRec({ paused: true });
  if (cmd === 'resume') return setRec({ paused: false });
  if (cmd === 'toggle') return rec.recording ? handleCmd('stop') : startRecording();
  if (cmd === 'disarm') return disarmAll();
  if (cmd === 'play') return startReplay();
  if (cmd === 'stop_replay') return Replay.stop();
  if (ARM_MODES.includes(cmd)) {
    const tab = await activeTab();
    if (!tab || tab.id == null) return;
    await ensureInjected(tab.id);
    await sendToTab(tab.id, { type: 'ARM', mode: cmd });
  }
}

async function disarmAll(tabId) {
  const id = tabId != null ? tabId : (await activeTab())?.id;
  if (id != null) await sendToTab(id, { type: 'ARM', mode: null });
}

// ---------- message hub ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.from === 'content') {
    if (msg.type === 'GET_STATE') {
      ready.then(() => sendResponse({ recording: isLive(), testIdAttr: settings.testIdAttr }));
      return true;
    }
    if (msg.type === 'ACTION' && msg.action) {
      const action = { ...msg.action, frameId: sender.frameId, url: msg.action.url || sender.url };
      enqueue(async () => { addStep(action); await saveSteps(); });
      return;
    }
    if (msg.type === 'MODE_DONE' || msg.type === 'MODE_CANCELLED') {
      // Disarm the other frames too, so an iframe doesn't stay in "pick" mode.
      if (sender.tab && sender.tab.id != null) disarmAll(sender.tab.id);
      toPanel({ type: msg.type, mode: msg.mode });
      return;
    }
    return;
  }

  if (msg.from === 'panel') {
    if (msg.type === 'GET_ALL') {
      ready.then(() => sendResponse({ rec, steps, replaying: Replay.isRunning() }));
      return true;
    }
    if (msg.type === 'SET_STEPS' && Array.isArray(msg.steps)) {
      enqueue(async () => { steps = msg.steps; await saveSteps(); }).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'CMD') {
      enqueue(() => handleCmd(msg.cmd)).then(() => sendResponse({ ok: true }));
      return true;
    }
  }
});

// ---------- side panel, context menu ----------
const MENU = [
  ['pick', 'Pick locator (copy HTML)'],
  ['detect', 'Detect state'],
  ['is_visible', 'Is visible'],
  ['assert_visible', 'Assert visible'],
  ['assert_text', 'Assert text'],
  ['assert_value', 'Assert value'],
];

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'crx-root', title: 'Playwright CRX Pro', contexts: ['all'] });
    for (const [id, title] of MENU) {
      chrome.contextMenus.create({ id: `crx-${id}`, parentId: 'crx-root', title, contexts: ['all'] });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null || !String(info.menuItemId).startsWith('crx-')) return;
  const mode = String(info.menuItemId).slice(4);
  if (!ARM_MODES.includes(mode)) return;
  chrome.tabs.sendMessage(tab.id, { from: 'bg', type: 'CTX', mode }, { frameId: info.frameId || 0 }).catch(() => {});
});

chrome.commands.onCommand.addListener((command, tab) => {
  // sidePanel.open must run synchronously inside the user gesture.
  if (tab && tab.windowId != null && chrome.sidePanel && chrome.sidePanel.open) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
  if (command === 'toggle-record') enqueue(() => handleCmd('toggle'));
  if (command === 'pick') enqueue(() => handleCmd('pick'));
});
