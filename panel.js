// panel.js — UI controller (BaseState style)
const state = { recording: false, steps: [] };
const $ = (id) => document.getElementById(id);
const pulse = $('pulse'), statusTxt = $('statusTxt'), recBtn = $('rec');
const scroll = $('scroll'), emptyEl = $('empty'), codeEl = $('code');
const outEl = document.querySelector('.out');
const isExtensionRuntime = !!(window.chrome && chrome.runtime && chrome.runtime.sendMessage);

function selectorKey(step) {
  const role = step.selector?.role || {};
  const css = step.selector?.css?.value || '';
  const frame = (step.framePath || []).join('>');
  return [step.tag || '', role.role || '', role.name || '', css, frame].join('|');
}

function opts() {
  return {
    sel: document.querySelector('input[name=sel]:checked').value,
    className: $('className').value.trim() || 'GeneratedState',
  };
}

function syncUI() {
  // no-op: wait/timeout controls removed
}

function send(cmd) {
  if (!isExtensionRuntime) return false;
  chrome.runtime.sendMessage({ from: 'panel', type: 'CMD', cmd });
  return true;
}

recBtn.addEventListener('click', () => {
  if (!isExtensionRuntime) {
    statusTxt.textContent = 'Preview mode (no recording)';
    return;
  }
  state.recording = !state.recording;
  recBtn.classList.toggle('on', state.recording);
  recBtn.textContent = state.recording ? 'Stop' : 'Record';
  pulse.classList.toggle('on', state.recording);
  statusTxt.textContent = state.recording ? 'Recording' : 'Idle';
  send(state.recording ? 'start' : 'stop');
});

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

if (window.chrome && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.type === 'ACTION' && msg.action && msg.relayedByBackground) {
      const a = { ...msg.action };
      if (!a.selStrategy) a.selStrategy = opts().sel;

      if (a.verb === 'detect') {
        state.steps = state.steps.filter(s => s.verb !== 'detect');
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
      statusTxt.textContent = state.recording ? 'Recording' : 'Idle';
    }
    if (msg.type === 'IS_VISIBLE_DONE' && msg.relayedByBackground) {
      isVisibleBtn.classList.remove('armed');
      isVisibleBtn.textContent = 'Is visible';
      statusTxt.textContent = state.recording ? 'Recording' : 'Idle';
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
  emptyEl.style.display = state.steps.length ? 'none' : 'block';
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
        <span class="num-badge">#${i + 1}</span>
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
    state._code = msg;
    return;
  }
  const { snap } = PWCodegen.generatePlaywright(state.steps, opts());
  codeEl.innerHTML = PWCodegen.highlight(snap || '');
  state._code = snap || '';
  $('fnLabel').textContent = 'code_snap.py';
}

document.querySelectorAll('.sheet input').forEach(el =>
  el.addEventListener('input', () => {
    syncUI();
    regen();
  })
);

$('className').addEventListener('input', regen);

function onSettingsChanged() {
  syncUI();
  regen();
}

$('copy').addEventListener('click', () => {
  navigator.clipboard.writeText(state._code || '');
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

const outToggle = $('outToggle');
if (outToggle && outEl) {
  outToggle.addEventListener('click', () => {
    const collapsed = outEl.classList.toggle('collapsed');
    outToggle.textContent = collapsed ? 'v' : '^';
    outToggle.title = collapsed ? 'Expand output' : 'Collapse output';
  });
}

syncUI();
render();
if (!isExtensionRuntime) {
  statusTxt.textContent = 'Preview mode (no recording)';
}