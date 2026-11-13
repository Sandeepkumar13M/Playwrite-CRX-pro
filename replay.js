// replay.js — "Play" button: replays the recorded steps in the active tab.
// Loaded by background.js (importScripts). Uses:
//  - the same locators as the generated code (PWCodegen.locParts)
//  - content.js (window.__pwRecReplay) to find elements in the right iframe
//  - chrome.debugger (Chrome DevTools Protocol) for trusted mouse / keyboard input
/* global PWCodegen */

const Replay = (() => {
  const STEP_TIMEOUT = 10000;
  const STEP_DELAY = 350;
  const KEYS = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    Delete: { code: 'Delete', keyCode: 46 },
  };

  let run = null; // { tabId, stopped, log, attached:Set }
  let report = () => {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cdp = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params || {});

  async function attach(tabId) {
    if (run.attached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, '1.3');
    run.attached.add(tabId);
  }

  async function detachAll() {
    if (!run) return;
    for (const tabId of run.attached) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    }
    run.attached.clear();
  }

  async function waitLoad(tabId, timeout = 15000) {
    const end = Date.now() + timeout;
    await sleep(150);
    while (Date.now() < end) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t) throw new Error('Tab was closed');
      if (t.status === 'complete') return;
      await sleep(150);
    }
  }

  async function inFrames(tabId, cmd) {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (c) => (window.__pwRecReplay ? window.__pwRecReplay(c) : null),
      args: [cmd],
    });
    for (const r of results) if (r && r.result) return r.result;
    return null;
  }

  function describe(parts) {
    return PWCodegen.renderLoc('py', 'page', parts);
  }

  // Retry until the element exists (and is visible when needed) or time runs out.
  async function locate(tabId, step, op, extra = {}, needVisible = true) {
    const strategy = step.selStrategy || run.sel || 'text';
    const parts = PWCodegen.locParts(step, strategy).parts;
    const cmd = {
      op,
      framePath: parts.filter((p) => p.k === 'frame').map((p) => p.v),
      parts: parts.filter((p) => p.k !== 'frame'),
      ...extra,
    };
    const end = Date.now() + STEP_TIMEOUT;
    let last = null;
    while (Date.now() < end) {
      if (run.stopped) throw new Error('Stopped');
      // content.js may be missing right after a navigation — make sure it is there.
      last = await inFrames(tabId, cmd).catch(() => null);
      if (!last) {
        await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => {});
      } else if (last.found && (!needVisible || last.visible)) {
        if (last.error) throw new Error(last.error);
        return last;
      }
      await sleep(250);
    }
    const why = last && last.found ? 'not visible' : 'not found';
    throw new Error(`Element ${why}: ${describe(parts)}`);
  }

  async function click(tabId, x, y) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  }

  async function press(tabId, combo) {
    const shift = combo.startsWith('Shift+');
    const key = shift ? combo.slice(6) : combo;
    const k = KEYS[key] || { code: key, keyCode: 0 };
    const common = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: shift ? 8 : 0 };
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...common, type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text, unmodifiedText: k.text });
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
  }

  function waitForPopup(openerTabId, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const onCreated = (tab) => {
        if (tab.openerTabId !== openerTabId) return;
        cleanup(); resolve(tab);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Popup did not open')); }, timeout);
      const cleanup = () => { clearTimeout(timer); chrome.tabs.onCreated.removeListener(onCreated); };
      chrome.tabs.onCreated.addListener(onCreated);
    });
  }

  // Poll an assertion until it passes or times out (like Playwright's expect).
  async function expectState(tabId, step, check, label) {
    const end = Date.now() + STEP_TIMEOUT;
    let st = null;
    while (Date.now() < end) {
      st = await locate(tabId, step, 'state', {}, false);
      if (check(st)) return;
      await sleep(250);
    }
    throw new Error(`${label} failed (got ${JSON.stringify(st && (step.verb === 'assert_checked' ? st.checked : step.verb === 'assert_value' ? st.value : st.text))})`);
  }

  async function execStep(step) {
    let tabId = run.tabId;
    switch (step.verb) {
      case 'goto': {
        const t = await chrome.tabs.get(tabId);
        if (t.url !== step.url) {
          await chrome.tabs.update(tabId, { url: step.url });
          await sleep(300);
        }
        return waitLoad(tabId);
      }
      case 'click': {
        const r = await locate(tabId, step, 'locate');
        if (step.opensPopup) {
          const popupP = waitForPopup(tabId);
          await click(tabId, r.x, r.y);
          const popup = await popupP;
          run.tabId = popup.id;
          await attach(popup.id);
          return waitLoad(popup.id);
        }
        return click(tabId, r.x, r.y);
      }
      case 'fill':
      case 'fill_rich': {
        await locate(tabId, step, 'focusSelect');
        const v = String(step.value == null ? '' : step.value);
        if (v) await cdp(tabId, 'Input.insertText', { text: v });
        else await press(tabId, 'Delete');
        return;
      }
      case 'check':
      case 'uncheck': {
        const want = step.verb === 'check';
        const st = await locate(tabId, step, 'state');
        if (st.checked === want) return;
        const r = await locate(tabId, step, 'locate');
        await click(tabId, r.x, r.y);
        return expectState(tabId, step, (s) => s.checked === want, step.verb);
      }
      case 'select':
        await locate(tabId, step, 'select', { value: step.value });
        return;
      case 'press':
        await locate(tabId, step, 'focus');
        return press(tabId, step.value);
      case 'assert_text':
        return expectState(tabId, step, (s) => s.text.includes(String(step.value).trim()), 'Assert text');
      case 'assert_value':
        return expectState(tabId, step, (s) => s.value === String(step.value), 'Assert value');
      case 'assert_checked':
        return expectState(tabId, step, (s) => s.checked === !!step.value, 'Assert checked');
      case 'is_visible':
      case 'assert_visible':
        await locate(tabId, step, 'state', {}, true);
        return;
      case 'detect': {
        // Informational: report whether the state is currently detected.
        const st = await locate(tabId, step, 'state', {}, false).catch(() => null);
        return st && st.visible ? 'detected' : 'not detected';
      }
      default:
        return 'skipped';
    }
  }

  async function start(steps, tabId, onReport, defaultSel) {
    if (run) throw new Error('Replay already running');
    report = onReport || (() => {});
    run = { tabId, sel: defaultSel, stopped: false, log: [], attached: new Set() };
    const todo = steps.filter((s) => s.verb && s.verb !== 'pick');
    const total = todo.length;
    const send = (status, extra = {}) => report({ status, total, log: run.log, ...extra });
    let status = 'done';
    try {
      await attach(tabId);
      for (let i = 0; i < todo.length; i++) {
        if (run.stopped) { status = 'stopped'; break; }
        const step = todo[i];
        send('running', { index: i });
        try {
          const note = await execStep(step);
          run.log.push({ i, verb: step.verb, ok: true, msg: typeof note === 'string' ? note : '' });
        } catch (e) {
          if (run.stopped) { status = 'stopped'; break; }
          run.log.push({ i, verb: step.verb, ok: false, msg: String(e && e.message || e) });
          status = 'failed';
          break;
        }
        await sleep(STEP_DELAY);
        await waitLoad(run.tabId).catch(() => {});
      }
    } catch (e) {
      status = 'failed';
      run.log.push({ i: -1, verb: 'attach', ok: false, msg: String(e && e.message || e) });
    } finally {
      await detachAll();
      send(status);
      run = null;
    }
    return status;
  }

  function stop() { if (run) run.stopped = true; }
  function isRunning() { return !!run; }

  // User closed the "debugging this browser" bar, or the tab went away.
  chrome.debugger.onDetach.addListener((source) => {
    if (run && run.attached.has(source.tabId)) {
      run.attached.delete(source.tabId);
      run.stopped = true;
    }
  });

  return { start, stop, isRunning };
})();
