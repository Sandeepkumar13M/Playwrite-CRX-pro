// panel.js — UI controller (BaseState style)
const state = { recording: false, paused: false, steps: [] };
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

function getRuntime() {
  try {
    const c = (typeof window !== 'undefined' && window) ? window['chrome'] : null;
    if (c && c.runtime) return c.runtime;
  } catch (_) {}
  return null;
}

const runtime = getRuntime();
const isExtensionRuntime = !!(runtime && runtime.sendMessage);

function selectorKey(step) {
  const role = step.selector?.role || {};
  const css = step.selector?.css?.value || '';
  const frame = (step.framePath || []).join('>');
  return [step.tag || '', role.role || '', role.name || '', css, frame].join('|');
}

function opts() {
  const classNameEl = $('className');
  return {
    sel: document.querySelector('input[name=sel]:checked').value,
    className: classNameEl ? (classNameEl.value.trim() || 'GeneratedState') : 'GeneratedState',
  };
}

function syncUI() {
  // no-op: wait/timeout controls removed
}

function setRecordingUI() {
  recBtn.classList.toggle('on', state.recording);
  recBtn.textContent = state.recording ? 'Stop' : 'Record';
  pulse.classList.toggle('on', state.recording && !state.paused);
  if (pauseBtn) {
    pauseBtn.disabled = !state.recording;
    pauseBtn.classList.toggle('active', state.paused);
    pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
  }
  if (!state.recording) {
    statusTxt.textContent = 'Idle';
  } else {
    statusTxt.textContent = state.paused ? 'Paused' : 'Recording';
  }
}

function send(cmd) {
  if (!runtime || !runtime.sendMessage) return false;
  try {
    runtime.sendMessage({ from: 'panel', type: 'CMD', cmd });
  } catch (_) {
    return false;
  }
  return true;
}

recBtn.addEventListener('click', () => {
  if (!isExtensionRuntime) {
    statusTxt.textContent = 'Preview mode (no recording)';
    return;
  }
  if (!state.recording) {
    state.recording = true;
    state.paused = false;
    send('start');
  } else {
    state.recording = false;
    state.paused = false;
    send('stop');
  }
  setRecordingUI();
});

if (pauseBtn) {
  pauseBtn.addEventListener('click', () => {
    if (!isExtensionRuntime || !state.recording) return;
    state.paused = !state.paused;
    send(state.paused ? 'pause' : 'resume');
    setRecordingUI();
  });
}

$('pick').addEventListener('click', () => {
  if (!isExtensionRuntime) {
    statusTxt.textContent = 'Preview mode (no recording)';
    return;
  }
  send('pick');
  statusTxt.textContent = 'Pick…';
});

const detectBtn = $('detect');
const isVisibleBtn = $('isVisible');
detectBtn.addEventListener('click', () => {
  if (!isExtensionRuntime) {
    statusTxt.textContent = 'Preview mode (no recording)';
    return;
  }
  send('detect');
  detectBtn.classList.add('armed');
  detectBtn.textContent = 'Click element…';
  statusTxt.textContent = 'Detect…';
});
isVisibleBtn.addEventListener('click', () => {
  if (!isExtensionRuntime) {
    statusTxt.textContent = 'Preview mode (no recording)';
    return;
  }
  send('is_visible');
  isVisibleBtn.classList.add('armed');
  isVisibleBtn.textContent = 'Click element…';
  statusTxt.textContent = 'Is visible…';
});

$('clear').addEventListener('click', () => {
  state.steps = [];
  render();
});

if (runtime && runtime.onMessage && runtime.onMessage.addListener) {
  runtime.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.type === 'ACTION' && msg.action && msg.relayedByBackground) {
      const a = { ...msg.action };
      if (!a.selStrategy) a.selStrategy = opts().sel;

      if (a.verb === 'detect') {
        state.steps.push(a);
      } else if (a.verb === 'pick') {
        state.steps.push(a);
        if (a.html) {
          navigator.clipboard.writeText(a.html).catch(() => {});
        }
      } else if (a.verb === 'is_visible') {
        state.steps.push(a);
      } else {
        const isFillVerb = a.verb === 'fill' || a.verb === 'fill_rich';
        const last = state.steps[state.steps.length - 1];
        // Real-time typing: keep updating last fill step while user types
        // in the same field, instead of pushing a new step per keystroke.
        if (isFillVerb && last && (last.verb === 'fill' || last.verb === 'fill_rich') &&
            selectorKey(last) === selectorKey(a)) {
          last.value = a.value;
        } else {
          state.steps.push(a);
        }
      }

      render();
    }

    if (msg.type === 'DETECT_DONE' && msg.relayedByBackground) {
      detectBtn.classList.remove('armed');
      detectBtn.textContent = 'Detect state';
      setRecordingUI();
    }
    if (msg.type === 'IS_VISIBLE_DONE' && msg.relayedByBackground) {
      isVisibleBtn.classList.remove('armed');
      isVisibleBtn.textContent = 'Is visible';
      setRecordingUI();
    }
  });
}

const RET = [['true_none', 'return True, None'], ['true_state', 'return True, "…"'], ['none', 'no return']];

function selHtml(arr, i, key, cur) {
  return `<select data-i="${i}" data-k="${key}">` +
    arr.map(([v, l]) =>
      `<option value="${v}" ${v === (cur || '') ? 'selected' : ''}>${l}</option>`
    ).join('') +
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
    const selTxt = step.selector?.role?.role
      ? `get_by_role("${step.selector.role.role}"${name ? `, name="${name}"` : ''})`
      : (step.selector?.css?.value || '');

    const frame = step.framePath?.length
      ? `<div class="frame-tag">▣ iframe × ${step.framePath.length}</div>`
      : '';

    const isFill = step.verb === 'fill' || step.verb === 'fill_rich';
    const isPick = step.verb === 'pick';
    const isVisibleCheck = step.verb === 'is_visible';

    if (step.verb === 'detect') {
      div.innerHTML = `
        <div class="step-top">
          <span class="chip c-detect">detect_state</span>
          <span class="num-badge">detector</span>
          <button class="del" data-i="${i}">×</button>
        </div>
        ${frame}
        <div class="sel">${selTxt}.is_visible()</div>`;
      scroll.appendChild(div);
      return;
    }

    div.innerHTML = `
      <div class="step-top">
        <span class="chip c-${step.verb}">${step.verb}</span>
        <button class="del" data-i="${i}">×</button>
      </div>
      ${frame}
      <div class="sel">${selTxt}</div>
      ${(isFill || isPick || isVisibleCheck) ? '' : `<div class="ctrls">${selHtml(RET, i, 'returnVal', step.returnVal || 'true_none')}</div>`}
      <div class="detect-toggle">
        <span>Use as detect_state</span>
        <label class="sw">
          <input type="checkbox" data-detect="${i}" ${step.isDetect ? 'checked' : ''}>
          <span class="track"></span>
        </label>
      </div>`;

    scroll.appendChild(div);
  });

  scroll.querySelectorAll('.del').forEach(b =>
    b.addEventListener('click', () => {
      state.steps.splice(+b.dataset.i, 1);
      render();
    })
  );

  scroll.querySelectorAll('select').forEach(s =>
    s.addEventListener('change', () => {
      state.steps[+s.dataset.i][s.dataset.k] = s.value || undefined;
      regen();
    })
  );

  scroll.querySelectorAll('input[data-detect]').forEach(c =>
    c.addEventListener('change', () => {
      const idx = +c.dataset.detect;

      if (c.checked) {
        state.steps = state.steps.filter(s => s.verb !== 'detect');
      }

      state.steps.forEach((st, j) => {
        st.isDetect = (j === idx) ? c.checked : false;
      });

      render();
    })
  );

  regen();
}

function regen() {
  if (!window.PWCodegen || !PWCodegen.generatePlaywright || !PWCodegen.highlight) {
    const msg = '# codegen.js not loaded in this preview context';
    codeEl.textContent = msg;
    if (detectCodeEl) detectCodeEl.textContent = msg;
    if (isVisibleCodeEl) isVisibleCodeEl.textContent = msg;
    if (pickCodeEl) pickCodeEl.textContent = msg;
    state._code = msg;
    return;
  }
  const { snap, detectSnap, isVisibleSnap, pickSnap } = PWCodegen.generatePlaywright(state.steps, opts());
  codeEl.innerHTML = PWCodegen.highlight(snap || '');
  if (detectCodeEl) detectCodeEl.innerHTML = PWCodegen.highlight(detectSnap || '');
  if (isVisibleCodeEl) isVisibleCodeEl.innerHTML = PWCodegen.highlight(isVisibleSnap || '');
  if (pickCodeEl) pickCodeEl.textContent = pickSnap || '<!-- no picked element yet -->';
  state._code = snap || '';
  state._detectSnap = detectSnap || '';
  state._isVisibleSnap = isVisibleSnap || '';
  state._pickSnap = pickSnap || '';
  $('fnLabel').textContent = 'code_snap.py';
  autoGrowBlocks();
}

document.querySelectorAll('.sheet input').forEach(el =>
  el.addEventListener('input', () => {
    syncUI();
    regen();
  })
);

const classNameEl = $('className');
if (classNameEl) classNameEl.addEventListener('input', regen);

function onSettingsChanged() {
  syncUI();
  regen();
}

$('copy').addEventListener('click', () => {
  navigator.clipboard.writeText(state._code || '').catch(() => {});
  const b = $('copy');
  b.textContent = 'Copied';
  setTimeout(() => b.textContent = 'Copy', 1100);
});

$('download').addEventListener('click', () => {
  const blob = new Blob([state._code || ''], { type: 'text/x-python' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = $('fnLabel').textContent;
  a.click();
});

function wireAuxButtons() {
  const copyDetect = $('copyDetect');
  const copyVisible = $('copyVisible');
  const copyPick = $('copyPick');
  const clearDetect = $('clearDetect');
  const clearVisible = $('clearVisible');
  const clearPick = $('clearPick');
  const growMain = $('growMain');
  const growDetect = $('growDetect');
  const growVisible = $('growVisible');
  const growPick = $('growPick');

  if (copyDetect) copyDetect.addEventListener('click', () => navigator.clipboard.writeText(state._detectSnap || '').catch(() => {}));
  if (copyVisible) copyVisible.addEventListener('click', () => navigator.clipboard.writeText(state._isVisibleSnap || '').catch(() => {}));
  if (copyPick) copyPick.addEventListener('click', () => navigator.clipboard.writeText(state._pickSnap || '').catch(() => {}));

  if (clearDetect) clearDetect.addEventListener('click', () => {
    state.steps = state.steps.map((s) => ({ ...s, isDetect: false })).filter((s) => s.verb !== 'detect');
    render();
  });
  if (clearVisible) clearVisible.addEventListener('click', () => {
    state.steps = state.steps.filter((s) => s.verb !== 'is_visible');
    render();
  });
  if (clearPick) clearPick.addEventListener('click', () => {
    state.steps = state.steps.filter((s) => s.verb !== 'pick');
    render();
  });

  const toggleSize = (btn, el) => {
    if (!btn || !el) return;
    btn.addEventListener('click', () => {
      el.classList.toggle('expanded');
      btn.textContent = el.classList.contains('expanded') ? 'Size -' : 'Size +';
      autoGrowBlocks();
    });
  };
  toggleSize(growMain, mainOut);
  toggleSize(growDetect, detectCard);
  toggleSize(growVisible, visibleCard);
  toggleSize(growPick, pickCard);
}

function autoGrowPre(preEl, containerEl, minPx, maxPx) {
  if (!preEl || !containerEl) return;
  const lines = (preEl.textContent || '').split('\n').length;
  const lineHeight = 20;
  const target = Math.max(minPx, Math.min(maxPx, 40 + (lines * lineHeight)));
  preEl.style.maxHeight = `${target}px`;
}

function autoGrowBlocks() {
  autoGrowPre(codeEl, mainOut, 320, mainOut && mainOut.classList.contains('expanded') ? 860 : 560);
  autoGrowPre(detectCodeEl, detectCard, 120, detectCard && detectCard.classList.contains('expanded') ? 520 : 300);
  autoGrowPre(isVisibleCodeEl, visibleCard, 120, visibleCard && visibleCard.classList.contains('expanded') ? 520 : 300);
  autoGrowPre(pickCodeEl, pickCard, 120, pickCard && pickCard.classList.contains('expanded') ? 520 : 300);
}

wireAuxButtons();
syncUI();
render();
if (!isExtensionRuntime) {
  statusTxt.textContent = 'Preview mode (no recording)';
} else {
  setRecordingUI();
}