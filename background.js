// background.js — service worker (single source of truth)
// Responsibilities:
//  - own the recording state (recording / paused) so it survives page navigations
//  - own the recorded steps (stored in chrome.storage.session) so nothing is lost
//    while the side panel is closed
//  - relay commands (record, pick, detect, is_visible, assertions) to every frame
//  - inject content.js into tabs that were open before the extension was loaded
//  - keyboard shortcuts (Alt+Shift+R / Alt+Shift+C), context menu, REC badge

importScripts('codegen.js', 'replay.js');

const ARM_MODES = ['pick', 'detect', 'is_visible'];
const MAX_HTML = 20000;

let rec = { recording: false, paused: false };
let steps = [];
let settings = { testIdAttr: 'data-testid', sel: 'text', lang: 'python-pytest' };
// Multi-page recording: every tab that takes part gets a page alias
// ("page", "page1", "page2", ...) which the generated code uses as variable name.
let pages = { aliases: {}, count: 0 };   // aliases: { [tabId]: alias }
let pendingPopup = null;                 // a popup whose opening step hasn't arrived yet

const ready = Promise.all([
  chrome.storage.session.get(['rec', 'steps', 'pages']).then((d) => {
    if (d.rec) rec = d.rec;
    if (Array.isArray(d.steps)) steps = d.steps;
    if (d.pages) pages = d.pages;
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
  if (!steps.length) { pages = { aliases: {}, count: 0 }; pendingPopup = null; }
  await chrome.storage.session.set({ steps, pages });
  toPanel({ type: 'STEPS', steps });
}

function nextAlias() { pages.count += 1; return `page${pages.count}`; }

// Which page alias does this tab have? Unknown tabs (the user switched to some other
// tab while recording) become a new page: page.context.new_page() + goto(url).
function aliasForTab(tab) {
  if (!tab || tab.id == null) return 'page';
  let alias = pages.aliases[tab.id];
  if (alias) return alias;
  if (!steps.length) {
    alias = 'page';
    pages.aliases[tab.id] = alias;
    if (/^https?:/i.test(tab.url || '')) steps.push({ verb: 'goto', url: tab.url, page: alias, framePath: [], at: Date.now() });
    return alias;
  }
  alias = nextAlias();
  pages.aliases[tab.id] = alias;
  steps.push({ verb: 'new_page', page: alias, framePath: [], at: Date.now() });
  if (/^https?:/i.test(tab.url || '')) steps.push({ verb: 'goto', url: tab.url, page: alias, framePath: [], at: Date.now() });
  return alias;
}

const POPUP_OPENERS = new Set(['click', 'press', 'check', 'uncheck', 'select', 'fill', 'fill_rich']);

// Mark the step that opened a new tab / popup window.
function attachPopup(srcAlias, alias, maxAgeMs) {
  const now = Date.now();
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.page !== srcAlias || !POPUP_OPENERS.has(s.verb)) continue;
    if (now - (s.at || 0) > maxAgeMs || s.popupAlias) return false;
    s.opensPopup = true;
    s.popupAlias = alias;
    return true;
  }
  return false;
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

function addStep(action, tab) {
  const a = { ...action, at: Date.now() };
  a.page = aliasForTab(tab);
  if (a.html && a.html.length > MAX_HTML) a.html = a.html.slice(0, MAX_HTML) + '\n<!-- truncated -->';
  // The new tab was created before this step's message arrived: link them now.
  if (pendingPopup && pendingPopup.srcAlias === a.page && POPUP_OPENERS.has(a.verb) && Date.now() - pendingPopup.at < 3000) {
    a.opensPopup = true;
    a.popupAlias = pendingPopup.alias;
    clearTimeout(pendingPopup.timer);
    pendingPopup = null;
  }
  const last = steps[steps.length - 1];
  const isFill = a.verb === 'fill' || a.verb === 'fill_rich';
  // Real-time typing: keep updating the last fill step for the same field.
  if (isFill && last && (last.verb === 'fill' || last.verb === 'fill_rich') && selectorKey(last) === selectorKey(a)) {
    last.value = a.value;
    return;
  }
  // Keep steps in the order the user did them (an iframe action can arrive a bit late).
  let i = steps.length;
  if (a.t) while (i > 0 && steps[i - 1].t && steps[i - 1].t > a.t) i--;
  steps.splice(i, 0, a);
}

// ---------- commands ----------
async function startRecording() {
  const tab = await activeTab();
  if (tab && tab.id != null) await ensureInjected(tab.id);
  if (!steps.length && tab) {
    pages = { aliases: {}, count: 0 };
    aliasForTab(tab); // the starting tab is "page" (+ goto)
    await saveSteps();
  }
  await setRec({ recording: true, paused: false });
}

// ---------- new tabs & popup windows ----------
// Fires for target=_blank links, window.open(), Ctrl/Shift/middle-click, form target=_blank,
// "Sign in with Google" popup windows, ... in normal AND incognito windows.
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  enqueue(async () => {
    if (!rec.recording || replaying) return;
    const srcAlias = pages.aliases[d.sourceTabId];
    if (!srcAlias || pages.aliases[d.tabId]) return;
    const alias = nextAlias();
    pages.aliases[d.tabId] = alias;
    if (attachPopup(srcAlias, alias, 2500)) { await saveSteps(); return; }
    // The opening click hasn't been reported yet (messages race) — wait briefly for it.
    const p = { srcAlias, alias, at: Date.now() };
    p.timer = setTimeout(() => enqueue(async () => {
      if (pendingPopup !== p) return;
      pendingPopup = null;
      // Opened without a recorded action (e.g. by a page script): open it explicitly.
      steps.push({ verb: 'new_page', page: alias, framePath: [], at: Date.now() });
      if (/^https?:/i.test(d.url || '')) steps.push({ verb: 'goto', url: d.url, page: alias, framePath: [], at: Date.now() });
      await saveSteps();
    }), 3000);
    pendingPopup = p;
    await chrome.storage.session.set({ pages });
  });
});

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
      enqueue(async () => { addStep(action, sender.tab); await saveSteps(); });
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
