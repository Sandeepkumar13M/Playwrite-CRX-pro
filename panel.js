// panel.js — side panel UI controller
// The background service worker owns the recording state and the steps;
// this panel renders them and sends commands.
const state = { rec: { recording: false, paused: false }, steps: [], armed: null };
const settings = { lang: 'python-pytest', sel: 'text', testIdAttr: 'data-testid', className: 'GeneratedState' };

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
const testIdInput = $('testIdAttr');

function getRuntime() {
  try {
    const c = (typeof window !== 'undefined' && window) ? window['chrome'] : null;
    if (c && c.runtime && c.runtime.id) return c.runtime;
  } catch (_) {}
  return null;
}

const runtime = getRuntime();
const isExtensionRuntime = !!(runtime && runtime.sendMessage);

// ---------- messaging ----------
function bg(msg) {
  if (!isExtensionRuntime) return Promise.resolve(null);
  return runtime.sendMessage({ from: 'panel', ...msg }).catch(() => null);
}
function send(cmd) { return bg({ type: 'CMD', cmd }); }
function pushSteps() { return bg({ type: 'SET_STEPS', steps: state.steps }); }

// ---------- settings ----------
function opts() {
  return {
    sel: settings.sel,
    lang: settings.lang,
    className: settings.className || 'GeneratedState',
  };
}

function saveSettings() {
  if (!isExtensionRuntime) return;
  const { lang, sel, testIdAttr } = settings;
  chrome.storage.local.set({ settings: { lang, sel, testIdAttr } }).catch(() => {});
}

function applySettingsToUI() {
  const radio = document.querySelector(`input[name=sel][value="${settings.sel}"]`);
  if (radio) radio.checked = true;
  if (langSel) langSel.value = settings.lang;
  if (testIdInput) testIdInput.value = settings.testIdAttr;
}

document.querySelectorAll('input[name=sel]').forEach((r) =>
  r.addEventListener('change', () => { settings.sel = r.value; saveSettings(); regen(); })
);
if (langSel) langSel.addEventListener('change', () => { settings.lang = langSel.value; saveSettings(); regen(); });
if (testIdInput) testIdInput.addEventListener('change', () => {
  settings.testIdAttr = testIdInput.value.trim() || 'data-testid';
  testIdInput.value = settings.testIdAttr;
  saveSettings();
});
const classNameEl = $('className');
if (classNameEl) classNameEl.addEventListener('input', () => { settings.className = classNameEl.value.trim(); regen(); });

// ---------- recording UI ----------
function setRecordingUI() {
  const { recording, paused } = state.rec;
  recBtn.classList.toggle('on', recording);
  recBtn.textContent = recording ? 'Stop' : 'Record';
  pulse.classList.toggle('on', recording && !paused);
  if (pauseBtn) {
    pauseBtn.disabled = !recording;
    pauseBtn.classList.toggle('active', paused);
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  }
  if (!isExtensionRuntime) { statusTxt.textContent = 'Preview mode (no recording)'; return; }
  if (state.armed) return; // armed label wins
  const n = state.steps.length;
  const count = n ? ` · ${n} step${n === 1 ? '' : 's'}` : '';
  statusTxt.textContent = (!recording ? 'Idle' : paused ? 'Paused' : 'Recording') + count;
}

recBtn.addEventListener('click', () => {
  if (!isExtensionRuntime) { statusTxt.textContent = 'Preview mode (no recording)'; return; }
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
let replayRunning = false;

function stepLabel(s) {
  if (s.verb === 'goto') return `goto ${s.url}`;
  const name = s.selector?.role?.name || s.selector?.label || s.selector?.placeholder || s.selector?.text || s.selector?.testId || s.tag || '';
  const val = s.value !== undefined && s.verb !== 'click' ? ` = ${JSON.stringify(s.value)}` : '';
  return `${s.verb} ${String(name).slice(0, 40)}${val}`;
}

function setPlayUI(running) {
  replayRunning = running;
  if (!playBtn) return;
  playBtn.classList.toggle('running', running);
  playBtn.textContent = running ? '■ Stop' : '▶ Play';
}

function renderReplay(r) {
  if (!replayCard) return;
  replayCard.hidden = false;
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
  const label = { running: `replaying ${Math.min((r.index || 0) + 1, r.total)}/${r.total}…`, done: `replay passed ✓ ${passed}/${r.total}`, failed: `replay failed ✗ at step ${(r.log || []).filter((e) => e.i >= 0).length}`, stopped: 'replay stopped' }[r.status] || r.status;
  replayTitle.textContent = label;
  statusTxt.textContent = label;
  setPlayUI(r.status === 'running');
  if (r.status !== 'running') setTimeout(setRecordingUI, 2500);
}

if (playBtn) playBtn.addEventListener('click', () => {
  if (!isExtensionRuntime) { statusTxt.textContent = 'Preview mode (no recording)'; return; }
  if (replayRunning) { send('stop_replay'); return; }
  setPlayUI(true);
  statusTxt.textContent = 'Starting replay…';
  send('play');
});
const closeReplay = $('closeReplay');
if (closeReplay) closeReplay.addEventListener('click', () => { replayCard.hidden = true; });

// ---------- one-shot "armed" buttons ----------
const ARM_BUTTONS = {
  pick: { btn: $('pick'), label: 'Pick element', status: 'Pick…' },
  detect: { btn: $('detect'), label: 'Detect state', status: 'Detect…' },
  is_visible: { btn: $('isVisible'), label: 'Is visible', status: 'Is visible…' },
  assert_visible: { btn: $('assertVisible'), label: 'Assert visible', status: 'Assert visible…' },
  assert_text: { btn: $('assertText'), label: 'Assert text', status: 'Assert text…' },
  assert_value: { btn: $('assertValue'), label: 'Assert value', status: 'Assert value…' },
};

function disarmUI() {
  for (const { btn, label } of Object.values(ARM_BUTTONS)) {
    if (!btn) continue;
    btn.classList.remove('armed');
    btn.textContent = label;
  }
  state.armed = null;
  setRecordingUI();
}

for (const [mode, cfg] of Object.entries(ARM_BUTTONS)) {
  if (!cfg.btn) continue;
  cfg.btn.addEventListener('click', () => {
    if (!isExtensionRuntime) { statusTxt.textContent = 'Preview mode (no recording)'; return; }
    if (state.armed === mode) { send('disarm'); disarmUI(); return; } // click again = cancel
    disarmUI();
    state.armed = mode;
    cfg.btn.classList.add('armed');
    cfg.btn.textContent = 'Click element… (Esc)';
    statusTxt.textContent = cfg.status;
    send(mode);
  });
}

$('clear').addEventListener('click', () => {
  state.steps = [];
  pushSteps();
  render();
});

const undoBtn = $('undo');
if (undoBtn) undoBtn.addEventListener('click', () => {
  if (!state.steps.length) return;
  state.steps.pop();
  pushSteps();
  render();
});

// ---------- messages from background ----------
if (isExtensionRuntime && runtime.onMessage) {
  runtime.onMessage.addListener((msg) => {
    if (!msg || msg.from !== 'bg') return;
    if (msg.type === 'STEPS') { state.steps = msg.steps || []; render(); }
    if (msg.type === 'REC') { state.rec = msg.rec; setRecordingUI(); }
    if (msg.type === 'MODE_DONE' || msg.type === 'MODE_CANCELLED') disarmUI();
    if (msg.type === 'REPLAY') renderReplay(msg);
  });
}

// ---------- step list (hidden in the clean layout, kept for detect toggles) ----------
const RET = [['true_none', 'return True, None'], ['true_state', 'return True, "…"'], ['none', 'no return']];
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function selHtml(arr, i, key, cur) {
  return `<select data-i="${i}" data-k="${key}">` +
    arr.map(([v, l]) => `<option value="${v}" ${v === (cur || '') ? 'selected' : ''}>${l}</option>`).join('') +
    `</select>`;
}

function render() {
  emptyEl.style.display = 'none';
  scroll.querySelectorAll('.step').forEach(n => n.remove());

  state.steps.forEach((step, i) => {
    const div = document.createElement('div');
    const isDetect = step.verb === 'detect' || step.isDetect;
    div.className = 'step' + (isDetect ? ' detect' : '');

    const name = step.selector?.role?.name || step.selector?.text || step.tag || '';
    const selTxt = step.verb === 'goto' ? step.url
      : step.selector?.role?.role
        ? `get_by_role("${step.selector.role.role}"${name ? `, name="${name}"` : ''})`
        : (step.selector?.css?.value || '');

    const frame = step.framePath?.length
      ? `<div class="frame-tag">▣ iframe × ${step.framePath.length}</div>` : '';
    const plain = ['fill', 'fill_rich', 'pick', 'is_visible', 'goto', 'press'].includes(step.verb) || step.verb.startsWith('assert');

    if (step.verb === 'detect') {
      div.innerHTML = `
        <div class="step-top">
          <span class="chip c-detect">detect_state</span>
          <span class="num-badge">detector</span>
          <button class="del" data-i="${i}">×</button>
        </div>
        ${frame}
        <div class="sel">${escHtml(selTxt)}.is_visible()</div>`;
      scroll.appendChild(div);
      return;
    }

    div.innerHTML = `
      <div class="step-top">
        <span class="chip c-${escHtml(step.verb)}">${escHtml(step.verb)}</span>
        <button class="del" data-i="${i}">×</button>
      </div>
      ${frame}
      <div class="sel">${escHtml(selTxt)}</div>
      ${plain ? '' : `<div class="ctrls">${selHtml(RET, i, 'returnVal', step.returnVal || 'true_none')}</div>`}
      ${step.verb === 'goto' ? '' : `<div class="detect-toggle">
        <span>Use as detect_state</span>
        <label class="sw">
          <input type="checkbox" data-detect="${i}" ${step.isDetect ? 'checked' : ''}>
          <span class="track"></span>
        </label>
      </div>`}`;
    scroll.appendChild(div);
  });

  scroll.querySelectorAll('.del').forEach(b =>
    b.addEventListener('click', () => { state.steps.splice(+b.dataset.i, 1); pushSteps(); render(); })
  );
  scroll.querySelectorAll('select').forEach(s =>
    s.addEventListener('change', () => { state.steps[+s.dataset.i][s.dataset.k] = s.value || undefined; pushSteps(); regen(); })
  );
  scroll.querySelectorAll('input[data-detect]').forEach(c =>
    c.addEventListener('change', () => {
      const idx = +c.dataset.detect;
      const target = state.steps[idx];
      if (c.checked) state.steps = state.steps.filter(s => s.verb !== 'detect');
      state.steps.forEach((st) => { st.isDetect = st === target ? c.checked : false; });
      pushSteps();
      render();
    })
  );

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

function flash(btn, text) {
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1100);
}
function copy(text, btn) {
  navigator.clipboard.writeText(text || '').then(() => flash(btn, 'Copied'), () => flash(btn, 'Failed'));
}

$('copy').addEventListener('click', () => copy(state._code, $('copy')));

$('download').addEventListener('click', () => {
  const blob = new Blob([state._code || ''], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state._fileName || 'code_snap.py';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

function wireAuxButtons() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => fn(el)); };
  on('copyDetect', (b) => copy(state._detectSnap, b));
  on('copyVisible', (b) => copy(state._isVisibleSnap, b));
  on('copyPick', (b) => copy(state._pickSnap, b));
  on('clearDetect', () => {
    state.steps = state.steps.map((s) => ({ ...s, isDetect: false })).filter((s) => s.verb !== 'detect');
    pushSteps(); render();
  });
  on('clearVisible', () => { state.steps = state.steps.filter((s) => s.verb !== 'is_visible'); pushSteps(); render(); });
  on('clearPick', () => { state.steps = state.steps.filter((s) => s.verb !== 'pick'); pushSteps(); render(); });

  const toggleSize = (btnId, el) => on(btnId, (btn) => {
    if (!el) return;
    el.classList.toggle('expanded');
    btn.textContent = el.classList.contains('expanded') ? 'Size -' : 'Size +';
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
  autoGrowPre(codeEl, 320, mainOut && mainOut.classList.contains('expanded') ? 860 : 560);
  autoGrowPre(detectCodeEl, 120, detectCard && detectCard.classList.contains('expanded') ? 520 : 300);
  autoGrowPre(isVisibleCodeEl, 120, visibleCard && visibleCard.classList.contains('expanded') ? 520 : 300);
  autoGrowPre(pickCodeEl, 120, pickCard && pickCard.classList.contains('expanded') ? 520 : 300);
}

// ---------- boot ----------
async function boot() {
  wireAuxButtons();
  const ver = $('ver');
  if (ver && isExtensionRuntime) {
    const m = chrome.runtime.getManifest();
    ver.textContent = m.version_name || m.version;
  }
  if (isExtensionRuntime) {
    try {
      const d = await chrome.storage.local.get(['settings']);
      if (d.settings) Object.assign(settings, d.settings);
    } catch (_) {}
    const all = await bg({ type: 'GET_ALL' });
    if (all) { state.rec = all.rec || state.rec; state.steps = all.steps || []; setPlayUI(!!all.replaying); }
  }
  applySettingsToUI();
  render();
}
boot();
