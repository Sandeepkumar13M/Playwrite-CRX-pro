// panel.js — side panel UI controller
// The background service worker owns the recording state and the steps;
// this panel renders them and sends commands.
const state = { rec: { recording: false, paused: false }, steps: [], armed: null };
const settings = { lang: 'python-pytest', sel: 'text', className: 'GeneratedState' };

const $ = (id) => document.getElementById(id);
const pulse = $('pulse'), statusTxt = $('statusTxt'), recBtn = $('rec');
const scroll = $('scroll'), emptyEl = $('empty'), codeEl = $('code');
const detectCodeEl = $('detectCode');
const isVisibleCodeEl = $('isVisibleCode');
const pickCodeEl = $('pickCode');
const pauseBtn = $('pause');
const mainOut = $('mainOut');
const detectCard = $('detectCard');
const visibleCard = $('visibleCard');
const pickCard = $('pickCard');
const langSel = $('lang');

function getRuntime() {
  try {
    const c = (typeof window !== 'undefined' && window) ? window['chrome'] : null;
    if (c && c.runtime && c.runtime.id) return c.runtime;
  } catch (_) {}
  return null;
}

const runtime = getRuntime();
const isExtensionRuntime = !!(runtime && runtime.sendMessage);

// ---------- small UI helpers ----------
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function setLabel(btn, text) {
  if (!btn) return;
  const l = btn.querySelector('.lbl');
  if (l) l.textContent = text; else btn.textContent = text;
}
let toastTimer = null;
function toast(text) {
  const t = $('toast');
  if (!t) return;
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}
function previewOnly() { statusTxt.textContent = 'Preview mode (no recording)'; }

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  try { localStorage.setItem('crxpro.tab', name); } catch (_) {}
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ---------- messaging ----------
function bg(msg) {
  if (!isExtensionRuntime) return Promise.resolve(null);
  return runtime.sendMessage({ from: 'panel', ...msg }).catch(() => null);
}
function send(cmd) { return bg({ type: 'CMD', cmd }); }
function pushSteps() { return bg({ type: 'SET_STEPS', steps: state.steps }); }

// ---------- settings ----------
function opts() {
  return { sel: settings.sel, lang: settings.lang, className: settings.className || 'GeneratedState' };
}

function saveSettings() {
  if (!isExtensionRuntime) return;
  const { lang, sel } = settings;
  // data-testid (+ data-test, data-test-id, data-qa) are detected automatically
  chrome.storage.local.set({ settings: { lang, sel, testIdAttr: 'data-testid' } }).catch(() => {});
}

const LANG_HINT = {
  'python-pytest': 'pytest', 'python': 'python script', 'python-async': 'asyncio script',
  'playwright-test-ts': 'npx playwright test', 'playwright-test-js': 'npx playwright test', 'javascript': 'node script',
  'java-junit': 'mvn test', 'java': 'java main()', 'csharp': 'dotnet test',
  'selenium-python': 'selenium + python', 'selenium-java': 'selenium + mvn test',
};
function applySettingsToUI() {
  const radio = document.querySelector(`input[name=sel][value="${settings.sel}"]`);
  if (radio) radio.checked = true;
  if (langSel) langSel.value = settings.lang;
  const hint = $('langHint');
  if (hint) hint.textContent = LANG_HINT[settings.lang] || '';
}

document.querySelectorAll('input[name=sel]').forEach((r) =>
  r.addEventListener('change', () => { settings.sel = r.value; saveSettings(); regen(); })
);
if (langSel) langSel.addEventListener('change', () => { settings.lang = langSel.value; saveSettings(); applySettingsToUI(); regen(); });

// ---------- recording UI ----------
function setRecordingUI() {
  const { recording, paused } = state.rec;
  recBtn.classList.toggle('on', recording);
  setLabel(recBtn, recording ? 'Stop' : 'Record');
  pulse.classList.toggle('on', recording && !paused);
  if (pauseBtn) {
    pauseBtn.disabled = !recording;
    pauseBtn.classList.toggle('active', paused);
    setLabel(pauseBtn, paused ? 'Resume' : 'Pause');
  }
  const n = state.steps.length;
  const sc = $('stepCount');
  if (sc) sc.textContent = n;
  if (!isExtensionRuntime) { previewOnly(); return; }
  if (state.armed || replayRunning) return; // armed / replay label wins
  const count = n ? ` · ${n} step${n === 1 ? '' : 's'}` : '';
  statusTxt.textContent = (!recording ? 'Idle' : paused ? 'Paused' : 'Recording') + count;
}

recBtn.addEventListener('click', () => {
  if (!isExtensionRuntime) return previewOnly();
  send(state.rec.recording ? 'stop' : 'start');
});

if (pauseBtn) {
  pauseBtn.addEventListener('click', () => {
    if (!isExtensionRuntime || !state.rec.recording) return;
    send(state.rec.paused ? 'resume' : 'pause');
  });
}

// ---------- ▶ Play (replay) ----------
const playBtn = $('play');
const replayCard = $('replayCard');
const replayLog = $('replayLog');
const replayTitle = $('replayTitle');
const replayDot = $('replayDot');
let replayRunning = false;

function stepName(s) {
  return s.selector?.role?.name || s.selector?.label || s.selector?.placeholder || s.selector?.text || s.selector?.testId || (s.tag || '').toLowerCase();
}
function stepLabel(s) {
  const where = s.page && s.page !== 'page' ? `[${s.page}] ` : '';
  if (s.verb === 'new_page') return `${where}new tab`;
  if (s.verb === 'goto') return `${where}goto ${s.url}`;
  const val = s.value !== undefined && s.verb !== 'click' ? ` = ${JSON.stringify(s.value)}` : '';
  const popup = s.popupAlias ? ` → opens ${s.popupAlias}` : '';
  return `${where}${s.verb} ${String(stepName(s)).slice(0, 40)}${val}${popup}`;
}

function setPlayUI(running) {
  replayRunning = running;
  if (!playBtn) return;
  playBtn.classList.toggle('running', running);
  setLabel(playBtn, running ? 'Stop' : 'Play');
}

function renderReplay(r) {
  if (!replayCard) return;
  replayCard.hidden = false;
  const re = $('replayEmpty');
  if (re) re.style.display = 'none';
  const todo = state.steps.filter((s) => s.verb && s.verb !== 'pick');
  const byIndex = new Map((r.log || []).map((e) => [e.i, e]));
  const rows = todo.map((s, i) => {
    const e = byIndex.get(i);
    let icon = '·', cls = 'wait', msg = '';
    if (e) { icon = e.ok ? '✓' : '✗'; cls = e.ok ? 'ok' : 'bad'; msg = e.msg; }
    else if (r.status === 'running' && r.index === i) { icon = '▶'; cls = 'run'; }
    return `<li><span class="${cls}">${icon}</span><span>${i + 1}. ${escHtml(stepLabel(s))}` +
      `${msg ? `<div class="${e && e.ok ? 'ok' : 'msg'}">${escHtml(msg)}</div>` : ''}</span></li>`;
  });
  for (const e of (r.log || []).filter((x) => x.i < 0)) {
    rows.unshift(`<li><span class="bad">✗</span><span class="msg">${escHtml(e.msg)}</span></li>`);
  }
  replayLog.innerHTML = rows.join('');
  const passed = (r.log || []).filter((e) => e.ok).length;
  const label = {
    running: `Replaying ${Math.min((r.index || 0) + 1, r.total)}/${r.total}…`,
    done: `Replay passed ✓ ${passed}/${r.total}`,
    failed: `Replay failed ✗ at step ${(r.log || []).filter((e) => e.i >= 0).length}`,
    stopped: 'Replay stopped',
  }[r.status] || r.status;
  replayTitle.textContent = label;
  statusTxt.textContent = label;
  if (replayDot) replayDot.className = 'dot ' + (r.status === 'running' ? 'run' : r.status === 'done' ? 'ok' : 'bad');
  setPlayUI(r.status === 'running');
  if (r.status !== 'running') setTimeout(setRecordingUI, 2500);
}

if (playBtn) playBtn.addEventListener('click', () => {
  if (!isExtensionRuntime) return previewOnly();
  if (replayRunning) { send('stop_replay'); return; }
  setPlayUI(true);
  statusTxt.textContent = 'Starting replay…';
  showTab('replay');
  send('play');
});
const closeReplay = $('closeReplay');
if (closeReplay) closeReplay.addEventListener('click', () => {
  replayCard.hidden = true;
  const re = $('replayEmpty');
  if (re) re.style.display = '';
  if (replayDot) replayDot.className = 'dot';
});

// ---------- one-shot "armed" buttons ----------
const ARM_BUTTONS = {
  pick: { btn: $('pick'), label: 'Pick', status: 'Click an element to pick…' },
  detect: { btn: $('detect'), label: 'Detect', status: 'Click an element for detect_state…' },
  is_visible: { btn: $('isVisible'), label: 'Visible', status: 'Click an element for is_visible…' },
};

function disarmUI() {
  for (const { btn, label } of Object.values(ARM_BUTTONS)) {
    if (!btn) continue;
    btn.classList.remove('armed');
    setLabel(btn, label);
  }
  state.armed = null;
  setRecordingUI();
}

for (const [mode, cfg] of Object.entries(ARM_BUTTONS)) {
  if (!cfg.btn) continue;
  cfg.btn.addEventListener('click', () => {
    if (!isExtensionRuntime) return previewOnly();
    if (state.armed === mode) { send('disarm'); disarmUI(); return; } // click again = cancel
    disarmUI();
    state.armed = mode;
    cfg.btn.classList.add('armed');
    setLabel(cfg.btn, 'Esc to cancel');
    statusTxt.textContent = cfg.status;
    send(mode);
  });
}

$('clear').addEventListener('click', () => {
  if (!state.steps.length) return;
  state.steps = [];
  pushSteps();
  render();
  toast('All steps cleared');
});

const undoBtn = $('undo');
if (undoBtn) undoBtn.addEventListener('click', () => {
  if (!state.steps.length) return;
  state.steps.pop();
  pushSteps();
  render();
  toast('Last step removed');
});

// ---------- messages from background ----------
if (isExtensionRuntime && runtime.onMessage) {
  runtime.onMessage.addListener((msg) => {
    if (!msg || msg.from !== 'bg') return;
    if (msg.type === 'STEPS') { state.steps = msg.steps || []; render(); }
    if (msg.type === 'REC') { state.rec = msg.rec; setRecordingUI(); }
    if (msg.type === 'MODE_DONE' || msg.type === 'MODE_CANCELLED') {
      disarmUI();
      if (msg.type === 'MODE_DONE') {
        const tab = { pick: 'pick', detect: 'pom', is_visible: 'pom' }[msg.mode];
        if (tab) showTab(tab);
        if (msg.mode === 'pick') toast('Element HTML copied');
      }
    }
    if (msg.type === 'REPLAY') renderReplay(msg);
  });
}

// ---------- step list ----------
const RET = [['true_none', 'return True, None'], ['true_state', 'return True, "…"'], ['none', 'no return']];
const POM_VERBS = new Set(['click', 'check', 'uncheck', 'select']);

function selHtml(arr, i, key, cur) {
  return `<select data-i="${i}" data-k="${key}" title="POM return value">` +
    arr.map(([v, l]) => `<option value="${v}" ${v === (cur || '') ? 'selected' : ''}>${l}</option>`).join('') +
    `</select>`;
}

function locatorPreview(step) {
  if (step.verb === 'goto') return step.url;
  if (step.verb === 'new_page') return 'opens a new tab';
  try {
    if (window.PWCodegen && PWCodegen.locParts) {
      return PWCodegen.renderLoc('py', 'page', PWCodegen.locParts(step, settings.sel || step.selStrategy).parts).replace(/^page\./, '');
    }
  } catch (_) {}
  return step.selector?.css?.value || '';
}

const X_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function render() {
  emptyEl.style.display = state.steps.length ? 'none' : '';
  scroll.querySelectorAll('.step').forEach((n) => n.remove());

  state.steps.forEach((step, i) => {
    const div = document.createElement('div');
    const isDetect = step.verb === 'detect' || step.isDetect;
    div.className = 'step' + (isDetect ? ' detect' : '');
    const verb = step.verb === 'detect' ? 'detect_state' : step.verb;
    const pageTag = step.page && step.page !== 'page' ? `<span class="ptag">${escHtml(step.page)}</span>` : '';
    const frame = step.framePath?.length ? `<span class="frame-tag">iframe × ${step.framePath.length}</span>` : '';
    const popup = step.popupAlias ? `<span class="ptag">→ ${escHtml(step.popupAlias)}</span>` : '';
    const val = step.value !== undefined && !['click', 'detect', 'pick', 'is_visible'].includes(step.verb)
      ? `<span class="val">${escHtml(JSON.stringify(step.value).slice(0, 60))}</span>` : '';
    const pom = POM_VERBS.has(step.verb)
      ? `<div class="ctrls">${selHtml(RET, i, 'returnVal', step.returnVal || 'true_none')}
           <label class="detect-toggle"><span class="sw"><input type="checkbox" data-detect="${i}" ${step.isDetect ? 'checked' : ''}><span class="track"></span></span>use as detect_state</label>
         </div>` : '';
    div.innerHTML = `
      <span class="idx">${String(i + 1).padStart(2, '0')}</span>
      <div class="step-main">
        <div class="step-top"><span class="chip c-${escHtml(step.verb)}">${escHtml(verb)}</span>${pageTag}${frame}${popup}${val}</div>
        <div class="sel">${escHtml(locatorPreview(step))}</div>
        ${pom}
      </div>
      <button class="del" data-i="${i}" title="Delete step">${X_ICON}</button>`;
    scroll.appendChild(div);
  });

  scroll.querySelectorAll('.del').forEach((b) =>
    b.addEventListener('click', () => { state.steps.splice(+b.dataset.i, 1); pushSteps(); render(); })
  );
  scroll.querySelectorAll('select').forEach((s) =>
    s.addEventListener('change', () => { state.steps[+s.dataset.i][s.dataset.k] = s.value || undefined; pushSteps(); regen(); })
  );
  scroll.querySelectorAll('input[data-detect]').forEach((c) =>
    c.addEventListener('change', () => {
      const target = state.steps[+c.dataset.detect];
      if (c.checked) state.steps = state.steps.filter((s) => s.verb !== 'detect');
      state.steps.forEach((st) => { st.isDetect = st === target ? c.checked : false; });
      pushSteps();
      render();
    })
  );
  // keep the newest step in view while recording
  if (state.rec.recording) { const last = scroll.lastElementChild; if (last && last.scrollIntoView) last.scrollIntoView({ block: 'nearest' }); }

  setRecordingUI();
  regen();
}

// ---------- code output ----------
function regen() {
  if (!window.PWCodegen || !PWCodegen.generatePlaywright || !PWCodegen.highlight) {
    const msg = '# codegen.js not loaded in this preview context';
    codeEl.textContent = msg;
    state._code = msg;
    return;
  }
  const out = PWCodegen.generatePlaywright(state.steps, opts());
  codeEl.innerHTML = PWCodegen.highlight(out.snap || '', out.family);
  if (detectCodeEl) detectCodeEl.innerHTML = PWCodegen.highlight(out.detectSnap || '', 'py');
  if (isVisibleCodeEl) isVisibleCodeEl.innerHTML = PWCodegen.highlight(out.isVisibleSnap || '', 'py');
  if (pickCodeEl) pickCodeEl.textContent = out.pickSnap || '<!-- no picked element yet -->';
  state._code = out.snap || '';
  state._detectSnap = out.detectSnap || '';
  state._isVisibleSnap = out.isVisibleSnap || '';
  state._pickSnap = out.pickSnap || '';
  state._fileName = out.fileName;
  $('fnLabel').textContent = out.fileName;
  autoGrowBlocks();
}

function copy(text, what) {
  navigator.clipboard.writeText(text || '').then(() => toast(`${what} copied`), () => toast('Copy failed'));
}

$('copy').addEventListener('click', () => copy(state._code, 'Code'));

$('download').addEventListener('click', () => {
  const blob = new Blob([state._code || ''], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state._fileName || 'test_example.py';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Saved ${a.download}`);
});

function wireAuxButtons() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => fn(el)); };
  on('copyDetect', () => copy(state._detectSnap, 'detect_state'));
  on('copyVisible', () => copy(state._isVisibleSnap, 'is_visible'));
  on('copyPick', () => copy(state._pickSnap, 'HTML'));
  on('clearDetect', () => {
    state.steps = state.steps.map((s) => ({ ...s, isDetect: false })).filter((s) => s.verb !== 'detect');
    pushSteps(); render();
  });
  on('clearVisible', () => { state.steps = state.steps.filter((s) => s.verb !== 'is_visible'); pushSteps(); render(); });
  on('clearPick', () => { state.steps = state.steps.filter((s) => s.verb !== 'pick'); pushSteps(); render(); });

  const toggleSize = (btnId, el) => on(btnId, (btn) => {
    if (!el) return;
    el.classList.toggle('expanded');
    setLabel(btn, el.classList.contains('expanded') ? 'Size −' : 'Size +');
    autoGrowBlocks();
  });
  toggleSize('growMain', mainOut);
  toggleSize('growDetect', detectCard);
  toggleSize('growVisible', visibleCard);
  toggleSize('growPick', pickCard);
}

function autoGrowPre(preEl, minPx, maxPx) {
  if (!preEl) return;
  const lines = (preEl.textContent || '').split('\n').length;
  preEl.style.maxHeight = `${Math.max(minPx, Math.min(maxPx, 40 + lines * 20))}px`;
}

function autoGrowBlocks() {
  autoGrowPre(codeEl, 320, mainOut && mainOut.classList.contains('expanded') ? 2000 : 620);
  autoGrowPre(detectCodeEl, 120, detectCard && detectCard.classList.contains('expanded') ? 900 : 300);
  autoGrowPre(isVisibleCodeEl, 120, visibleCard && visibleCard.classList.contains('expanded') ? 900 : 300);
  autoGrowPre(pickCodeEl, 160, pickCard && pickCard.classList.contains('expanded') ? 2000 : 420);
}

// ---------- boot ----------
async function boot() {
  wireAuxButtons();
  try { const t = localStorage.getItem('crxpro.tab'); if (t && t !== 'replay') showTab(t); } catch (_) {}
  const ver = $('ver');
  if (ver && isExtensionRuntime) {
    const m = chrome.runtime.getManifest();
    ver.textContent = 'v' + (m.version_name || m.version);
  }
  if (isExtensionRuntime) {
    try {
      const d = await chrome.storage.local.get(['settings']);
      if (d.settings) Object.assign(settings, d.settings);
      if (settings.lang === 'playwright-test') settings.lang = 'playwright-test-ts'; // renamed in 1.0.0
    } catch (_) {}
    const all = await bg({ type: 'GET_ALL' });
    if (all) { state.rec = all.rec || state.rec; state.steps = all.steps || []; setPlayUI(!!all.replaying); }
  }
  applySettingsToUI();
  render();
}
boot();
