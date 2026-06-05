// content.js — runs in every frame (all_frames: true)
// Records user interactions and computes:
//   - a robust selector (role-first, CSS fallback)
//   - the iframe chain (frame path) so deep (4-5 level) iframes can be reached

(() => {
  if (window.__pwRecInjected) return;
  window.__pwRecInjected = true;

  let recording = false;
  let picking = false;
  let detecting = false;
  let checkingVisible = false;

  // ---------- Frame path computation ----------
  // Each frame can ask its parent "what selector points to my frame element?"
  // We walk up window.parent chain, asking each parent for the iframe selector
  // that contains the requesting child. Result: ordered list of frame_locator selectors.

  const FRAME_REQ = '__pw_frame_req__';
  const FRAME_RES = '__pw_frame_res__';
  const pending = new Map();
  let reqCounter = 0;

  function iframeSelectorFor(el) {
    // Build a selector for an <iframe> element as seen from its parent doc.
    if (el.id) return `#${cssEscape(el.id)}`;
    if (el.name) return `iframe[name="${el.name}"]`;
    const src = el.getAttribute('src');
    if (src) return `iframe[src="${src}"]`;
    // positional fallback
    const all = Array.from(el.ownerDocument.querySelectorAll('iframe'));
    const idx = all.indexOf(el);
    return `iframe >> nth=${idx}`;
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;

    if (d.__t === FRAME_REQ) {
      // A child is asking: which iframe element in THIS document is you?
      const frames = document.querySelectorAll('iframe');
      let selector = null;
      for (const f of frames) {
        if (f.contentWindow === e.source) { selector = iframeSelectorFor(f); break; }
      }
      // Ask our own parent to continue building the chain above us.
      if (window.parent !== window) {
        const id = `${Date.now()}_${reqCounter++}`;
        pending.set(id, (parentChain) => {
          e.source.postMessage({ __t: FRAME_RES, id: d.id, chain: [...parentChain, selector] }, '*');
        });
        window.parent.postMessage({ __t: FRAME_REQ, id }, '*');
      } else {
        e.source.postMessage({ __t: FRAME_RES, id: d.id, chain: [selector] }, '*');
      }
    }

    if (d.__t === FRAME_RES) {
      const cb = pending.get(d.id);
      if (cb) { pending.delete(d.id); cb(d.chain); }
    }
  });

  function getFramePath() {
    // Returns a promise of an ordered array of iframe selectors from top -> this frame.
    return new Promise((resolve) => {
      if (window.parent === window) { resolve([]); return; }
      const id = `${Date.now()}_${reqCounter++}`;
      pending.set(id, (chain) => resolve(chain));
      window.parent.postMessage({ __t: FRAME_REQ, id }, '*');
      // safety timeout
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve([]); } }, 1500);
    });
  }

  // ---------- Selector generation ----------
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
  function attrEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
  function isDynamicId(id) {
    if (!id) return true;
    // Heuristic: long hash/guid-like ids are treated as unstable.
    return /(^[a-f0-9]{8,}$)|([a-f0-9]{6,}-[a-f0-9]{4,})|(_\d{4,})/i.test(id);
  }

  const ROLE_MAP = {
    BUTTON: 'button', A: 'link', INPUT: null, SELECT: 'combobox',
    TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading'
  };

  function inputRole(el) {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'submit' || t === 'button') return 'button';
    return 'textbox';
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
    const ph = el.getAttribute('placeholder');
    if (ph) return ph.trim();
    const txt = (el.textContent || '').trim();
    if (txt && txt.length <= 60) return txt;
    return null;
  }

  function labelText(el) {
    if (el.labels && el.labels.length) {
      const txt = (el.labels[0].textContent || '').trim();
      if (txt) return txt;
    }
    const aria = (el.getAttribute('aria-label') || '').trim();
    return aria || null;
  }

  function roleSelector(el) {
    let role = ROLE_MAP[el.tagName];
    if (el.tagName === 'INPUT') role = inputRole(el);
    if (el.getAttribute('role')) role = el.getAttribute('role');
    if (!role) return null;
    const name = accessibleName(el);
    return { kind: 'role', role, name };
  }

  function cssSelector(el) {
    if (el.id) return { kind: 'css', value: `#${cssEscape(el.id)}` };
    const dt = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (dt) return { kind: 'css', value: `[data-testid="${dt}"]` };
    // build a short path
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.classList.length) {
        const cls = Array.from(node.classList).slice(0, 2).map(c => '.' + cssEscape(c)).join('');
        part += cls;
      }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node.id) { parts[0] = `#${cssEscape(node.id)}`; break; }
      node = node.parentElement;
    }
    return { kind: 'css', value: parts.join(' > ') };
  }

  function xpathSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    const id = el.getAttribute('id');
    if (id) return { kind: 'xpath', value: `//*[@id="${attrEscape(id)}"]` };
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      let idx = 1;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        idx = same.indexOf(node) + 1;
      }
      parts.unshift(`${tag}[${idx}]`);
      if (!parent) break;
      node = parent;
    }
    return { kind: 'xpath', value: '/' + parts.join('/') };
  }

  function buildSelector(el) {
    // If user clicks nested text inside a heading, prefer the heading itself.
    // This produces stable selectors like get_by_role("heading", name="...").
    let target = el;
    const headingAncestor = el.closest && el.closest('h1,h2,h3,h4,h5,h6,[role="heading"]');
    if (headingAncestor) target = headingAncestor;

    // Capture semantic selector candidates for codegen priority resolution.
    const role = roleSelector(target);
    const css = cssSelector(target);
    const xpath = xpathSelector(target);
    const text = (target.textContent || '').trim().slice(0, 80);
    const placeholder = (target.getAttribute('placeholder') || '').trim() || null;
    const alt = (target.getAttribute('alt') || '').trim() || null;
    const title = (target.getAttribute('title') || '').trim() || null;
    const testId = (target.getAttribute('data-testid') || target.getAttribute('data-test') || '').trim() || null;
    const label = labelText(target);
    const meta = selectorMeta(target, { role, label, placeholder, text, alt, title, testId, css });
    if (target.tagName === 'INPUT') {
      const type = (target.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        const formCss = formContextCss(target);
        if (formCss) meta.formCss = formCss;
      }
    }
    return {
      role,
      css,
      xpath,
      text: text || null,
      label,
      placeholder,
      alt,
      title,
      testId,
      meta,
    };
  }

  function stableParentCss(el) {
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const dt = p.getAttribute('data-testid') || p.getAttribute('data-test');
      if (dt) return `[data-testid="${attrEscape(dt)}"]`;
      if (p.id && !isDynamicId(p.id)) return `#${cssEscape(p.id)}`;
      p = p.parentElement;
    }
    return null;
  }

  function roleMatchCount(role, name) {
    if (!role) return 0;
    let c = 0;
    document.querySelectorAll('*').forEach((n) => {
      const r = roleSelector(n);
      if (!r || r.role !== role) return;
      if (name && (r.name || '') !== name) return;
      c++;
    });
    return c;
  }

  function labelMatchCount(label) {
    if (!label) return 0;
    let c = 0;
    document.querySelectorAll('input,textarea,select,[aria-label]').forEach((n) => {
      if (labelText(n) === label) c++;
    });
    return c;
  }

  function textMatchCount(text) {
    if (!text) return 0;
    let c = 0;
    document.querySelectorAll('*').forEach((n) => {
      const t = (n.textContent || '').trim();
      if (t === text) c++;
    });
    return c;
  }

  function selectorMeta(el, s) {
    const meta = {
      parentCss: stableParentCss(el),
      roleCount: s.role && s.role.role ? roleMatchCount(s.role.role, s.role.name || null) : 0,
      labelCount: labelMatchCount(s.label),
      placeholderCount: s.placeholder ? document.querySelectorAll(`[placeholder="${attrEscape(s.placeholder)}"]`).length : 0,
      textCount: textMatchCount(s.text),
      altCount: s.alt ? document.querySelectorAll(`[alt="${attrEscape(s.alt)}"]`).length : 0,
      titleCount: s.title ? document.querySelectorAll(`[title="${attrEscape(s.title)}"]`).length : 0,
      testIdCount: s.testId ? document.querySelectorAll(`[data-testid="${attrEscape(s.testId)}"], [data-test="${attrEscape(s.testId)}"]`).length : 0,
      cssCount: (s.css && s.css.value) ? document.querySelectorAll(s.css.value).length : 0,
    };
    return meta;
  }

  function formContextCss(el) {
    let node = el && el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.tagName === 'FORM' || node.getAttribute('role') === 'form') {
        const c = cssSelector(node);
        return c && c.value ? c.value : null;
      }
      node = node.parentElement;
    }
    return null;
  }

  function opensPopup(el) {
    // Best effort: anchors that open a new tab. window.open() can't be
    // reliably detected from a content script.
    const a = el.closest && el.closest('a[target="_blank"], a[target="_new"]');
    return !!a;
  }

  // ---------- Visual highlight ----------
  let hoverBox = null;
  function ensureBox() {
    if (hoverBox) return hoverBox;
    const root = document.documentElement || document.body;
    if (!root) return null;
    hoverBox = document.createElement('div');
    hoverBox.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #ff5c38;' +
      'background:rgba(255,92,56,.12);border-radius:3px;transition:all .05s;display:none;';
    root.appendChild(hoverBox);
    return hoverBox;
  }
  function highlight(el) {
    const b = ensureBox();
    if (!b) return;
    const r = el.getBoundingClientRect();
    b.style.display = 'block';
    b.style.left = r.left + 'px'; b.style.top = r.top + 'px';
    b.style.width = r.width + 'px'; b.style.height = r.height + 'px';
  }
  function clearHL() { if (hoverBox) hoverBox.style.display = 'none'; }

  // ---------- Emit ----------
  function getRuntime() {
    try {
      const c = (typeof window !== 'undefined' && window) ? window['chrome'] : null;
      if (c && c.runtime) return c.runtime;
    } catch (_) {}
    return null;
  }

  async function emit(action) {
    const framePath = await getFramePath();
    const runtime = getRuntime();
    if (!runtime || !runtime.sendMessage) return;
    try {
      runtime.sendMessage({ from: 'content', type: 'ACTION', action: { ...action, framePath } });
    } catch (_) {
      // Ignore when extension context is unavailable/reloading.
    }
  }

  // ---------- Event handlers ----------
  function onMouseOver(e) {
    if (!recording && !picking) return;
    highlight(e.target);
  }

  function onClick(e) {
    if (!recording && !picking && !detecting && !checkingVisible) return;
    const el = e.target;

    // one-shot DETECT mode: capture this element as the state detector, then auto-disable
    if (detecting) {
      e.preventDefault(); e.stopPropagation();
      emit({ verb: 'detect', selector: buildSelector(el), tag: el.tagName, html: el.outerHTML || '' });
      detecting = false; clearHL();
      try {
        const runtime = getRuntime();
        if (runtime && runtime.sendMessage) runtime.sendMessage({ from: 'content', type: 'DETECT_DONE' });
      } catch (_) {}
      return;
    }
    if (checkingVisible) {
      e.preventDefault(); e.stopPropagation();
      emit({ verb: 'is_visible', selector: buildSelector(el), tag: el.tagName, html: el.outerHTML || '' });
      checkingVisible = false; clearHL();
      try {
        const runtime = getRuntime();
        if (runtime && runtime.sendMessage) runtime.sendMessage({ from: 'content', type: 'IS_VISIBLE_DONE' });
      } catch (_) {}
      return;
    }

    if (picking) {
      e.preventDefault(); e.stopPropagation();
      emit({ verb: 'pick', selector: buildSelector(el), tag: el.tagName, html: el.outerHTML || '' });
      picking = false; clearHL();
      return;
    }

    // Record the click for EVERY element, including text inputs/textareas/contenteditable.
    // Typing is captured separately on change/blur, so click + fill become two ordered steps.
    emit({ verb: 'click', selector: buildSelector(el), tag: el.tagName, opensPopup: opensPopup(el) });
  }

  function onChange(e) {
    if (!recording) return;
    const el = e.target;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') {
        emit({ verb: el.checked ? 'check' : 'uncheck', selector: buildSelector(el), tag: el.tagName });
      } else if (el.tagName === 'SELECT') {
        emit({ verb: 'select', selector: buildSelector(el), value: el.value, tag: el.tagName });
      } else {
        if (!String(el.value || '').trim()) return;
        emit({ verb: 'fill', selector: buildSelector(el), value: el.value, tag: el.tagName });
      }
    } else if (el.tagName === 'SELECT') {
      emit({ verb: 'select', selector: buildSelector(el), value: el.value, tag: el.tagName });
    }
  }

  function onInput(e) {
    if (!recording) return;
    const el = e.target;
    // Real-time typing capture while still focused in the same field.
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t !== 'checkbox' && t !== 'radio') {
        if (!String(el.value || '').trim()) return;
        emit({ verb: 'fill', selector: buildSelector(el), value: el.value, tag: el.tagName });
      }
    } else if (el.isContentEditable) {
      if (!String(el.innerText || '').trim()) return;
      emit({ verb: 'fill_rich', selector: buildSelector(el), value: el.innerText, tag: el.tagName });
    }
  }

  function onBlur(e) {
    if (!recording) return;
    const el = e.target;
    if (el.isContentEditable) {
      // rich text / <p> editors
      if (!String(el.innerText || '').trim()) return;
      emit({ verb: 'fill_rich', selector: buildSelector(el), value: el.innerText, tag: el.tagName });
    }
  }

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('blur', onBlur, true);

  // ---------- Commands from panel ----------
  const runtimeForListener = getRuntime();
  if (runtimeForListener && runtimeForListener.onMessage && runtimeForListener.onMessage.addListener) {
    runtimeForListener.onMessage.addListener((msg) => {
      if (!msg || msg.from !== 'panel') return;
      if (msg.type === 'CMD') {
        if (msg.cmd === 'start') { recording = true; }
        if (msg.cmd === 'stop') { recording = false; picking = false; detecting = false; checkingVisible = false; clearHL(); }
        if (msg.cmd === 'pause') { recording = false; clearHL(); }
        if (msg.cmd === 'resume') { recording = true; }
        if (msg.cmd === 'pick') { picking = true; }
        if (msg.cmd === 'detect') { detecting = true; }
        if (msg.cmd === 'is_visible') { checkingVisible = true; }
      }
    });
  }
})();
