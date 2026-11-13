// content.js — runs in every frame (all_frames: true)
// Records user interactions and computes:
//   - a robust selector (role-first, CSS fallback)
//   - the iframe chain (frame path) so deep (4-5 level) iframes can be reached
// One-shot "armed" modes: pick, detect, is_visible, assert_text, assert_value.

(() => {
  // Re-injection guard. After an extension reload the old copy is orphaned
  // (its chrome.runtime is dead), so we allow a fresh copy to take over.
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  if (window.__pwRecAlive && window.__pwRecAlive()) return;
  window.__pwRecAlive = alive;

  let recording = false;
  let armed = null;          // null | 'pick' | 'detect' | 'is_visible' | 'assert_text' | 'assert_value'
  let testIdAttr = 'data-testid';
  let lastContextTarget = null;

  // ---------- Frame path computation ----------
  // Each frame can ask its parent "what selector points to my frame element?"
  // We walk up window.parent chain, asking each parent for the iframe selector
  // that contains the requesting child. Result: ordered list of frame_locator selectors.

  const FRAME_REQ = '__pw_frame_req__';
  const FRAME_RES = '__pw_frame_res__';
  const OFF_REQ = '__pw_off_req__';
  const OFF_RES = '__pw_off_res__';
  const pending = new Map();
  let reqCounter = 0;

  function iframeSelectorFor(el) {
    // Build a selector for an <iframe> element as seen from its parent doc.
    if (el.id) return `#${cssEscape(el.id)}`;
    if (el.name) return `iframe[name="${attrEscape(el.name)}"]`;
    const src = el.getAttribute('src');
    if (src) return `iframe[src="${attrEscape(src)}"]`;
    // positional fallback
    const all = Array.from(el.ownerDocument.querySelectorAll('iframe'));
    const idx = all.indexOf(el);
    return `iframe >> nth=${idx}`;
  }

  function childFrameElement(source) {
    for (const f of document.querySelectorAll('iframe, frame')) {
      if (f.contentWindow === source) return f;
    }
    return null;
  }

  function onWindowMessage(e) {
    if (!alive()) return teardown();
    const d = e.data;
    if (!d || typeof d !== 'object') return;

    if (d.__t === OFF_REQ) {
      // A child frame asks for its viewport offset relative to the top window (used by replay).
      const f = childFrameElement(e.source);
      if (!f) return;
      try { f.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); } catch (_) {}
      const r = f.getBoundingClientRect();
      const cs = getComputedStyle(f);
      const dx = r.left + f.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      const dy = r.top + f.clientTop + (parseFloat(cs.paddingTop) || 0);
      getFrameOffset().then((p) => e.source.postMessage({ __t: OFF_RES, id: d.id, x: p.x + dx, y: p.y + dy }, '*'));
      return;
    }
    if (d.__t === OFF_RES) {
      const cb = pending.get(d.id);
      if (cb) { pending.delete(d.id); cb({ x: d.x, y: d.y }); }
      return;
    }

    if (d.__t === FRAME_REQ) {
      // A child is asking: which iframe element in THIS document is you?
      const frames = document.querySelectorAll('iframe, frame');
      let selector = null;
      for (const f of frames) {
        if (f.contentWindow === e.source) { selector = iframeSelectorFor(f); break; }
      }
      if (!selector) return; // not our child (or answered by another copy)
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
  }
  window.addEventListener('message', onWindowMessage);

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

  function getFrameOffset() {
    // Promise of {x, y}: this frame's viewport origin in top-window coordinates.
    return new Promise((resolve) => {
      if (window.parent === window) { resolve({ x: 0, y: 0 }); return; }
      const id = `${Date.now()}_${reqCounter++}`;
      pending.set(id, resolve);
      window.parent.postMessage({ __t: OFF_REQ, id }, '*');
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ x: 0, y: 0 }); } }, 1500);
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

  // Test id: the configured attribute first, then common fallbacks.
  function testIdOf(el) {
    for (const attr of [testIdAttr, 'data-testid', 'data-test', 'data-test-id', 'data-qa']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v && v.trim()) return { attr, value: v.trim() };
    }
    return null;
  }

  const ROLE_MAP = {
    BUTTON: 'button', A: 'link', INPUT: null, SELECT: 'combobox',
    TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading',
    H4: 'heading', H5: 'heading', H6: 'heading', IMG: 'img'
  };

  function inputRole(el) {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
    if (t === 'search') return 'searchbox';
    if (t === 'range') return 'slider';
    if (t === 'number') return 'spinbutton';
    if (t === 'hidden') return null;
    return 'textbox';
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
    const ph = el.getAttribute('placeholder');
    if (ph) return ph.trim();
    if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim() || null;
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type || '')) return (el.value || '').trim() || null;
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
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
    if (el.tagName === 'A' && !el.hasAttribute('href')) role = null;
    if (el.tagName === 'INPUT') role = inputRole(el);
    if (el.getAttribute('role')) role = el.getAttribute('role').trim().split(/\s+/)[0];
    if (!role) return null;
    const name = accessibleName(el);
    return { kind: 'role', role, name };
  }

  function cssSelector(el) {
    if (el.id && !isDynamicId(el.id)) return { kind: 'css', value: `#${cssEscape(el.id)}` };
    const tid = testIdOf(el);
    if (tid) return { kind: 'css', value: `[${tid.attr}="${attrEscape(tid.value)}"]` };
    if (el.id) return { kind: 'css', value: `#${cssEscape(el.id)}` };
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
      if (node.id && !isDynamicId(node.id)) { parts[0] = `#${cssEscape(node.id)}`; break; }
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

  // If user clicks nested text inside a heading, prefer the heading itself.
  // This produces stable selectors like get_by_role("heading", name="...").
  // Clicking an <svg>/<span> inside a button/link records the button/link itself.
  const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[role="button"],[role="link"],' +
    '[role="checkbox"],[role="radio"],[role="menuitem"],[role="tab"],[role="option"],[role="switch"],[role="combobox"],[contenteditable="true"]';
  function resolveTarget(el) {
    if (!el || !el.closest) return el;
    const interactive = el.closest(INTERACTIVE);
    if (interactive) return interactive;
    const headingAncestor = el.closest('h1,h2,h3,h4,h5,h6,[role="heading"]');
    return headingAncestor || el;
  }

  function buildSelector(el) {
    const target = resolveTarget(el);

    // Capture semantic selector candidates for codegen priority resolution.
    const role = roleSelector(target);
    const css = cssSelector(target);
    const xpath = xpathSelector(target);
    // Form controls have no meaningful text (a <select>'s text is all its options glued together).
    const text = isFormControl(target) ? '' : (target.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const placeholder = (target.getAttribute('placeholder') || '').trim() || null;
    const alt = (target.getAttribute('alt') || '').trim() || null;
    const title = (target.getAttribute('title') || '').trim() || null;
    const tid = testIdOf(target);
    const testId = tid ? tid.value : null;
    const label = labelText(target);
    const meta = selectorMeta(target, { role, label, placeholder, text, alt, title, tid, css });
    try { meta.uniq = uniqInfo(target, { role, label, placeholder, text, alt, title, tid, css, xpath }); } catch (_) {}
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
      testIdAttr: tid ? tid.attr : null,
      meta,
    };
  }

  // For every candidate locator: how many elements it matches on this page (Playwright
  // semantics) and where our target is in that list — loose and exact. Codegen uses this
  // to pick a locator that is unique, adding exact=True or .nth() only when needed.
  function uniqInfo(target, s) {
    const cands = {
      role: s.role && s.role.role ? { k: 'role', role: s.role.role, name: s.role.name || null } : null,
      label: s.label ? { k: 'label', v: s.label } : null,
      placeholder: s.placeholder ? { k: 'placeholder', v: s.placeholder } : null,
      text: s.text ? { k: 'text', v: s.text } : null,
      alt_text: s.alt ? { k: 'alt', v: s.alt } : null,
      title: s.title ? { k: 'title', v: s.title } : null,
      test_id: s.tid ? (s.tid.attr === 'data-testid' ? { k: 'testid', v: s.tid.value } : { k: 'locator', v: `[${s.tid.attr}="${attrEscape(s.tid.value)}"]` }) : null,
      css: s.css && s.css.value ? { k: 'locator', v: s.css.value } : null,
      xpath: s.xpath && s.xpath.value ? { k: 'locator', v: 'xpath=' + s.xpath.value } : null,
    };
    const indexOf = (list) => {
      let i = list.indexOf(target);
      if (i < 0) i = list.findIndex((e) => target.contains(e));
      if (i < 0) i = list.findIndex((e) => e.contains(target));
      return i;
    };
    const out = {};
    for (const [key, p] of Object.entries(cands)) {
      if (!p) continue;
      const loose = resolveParts([p]);
      const u = { n: loose.length, i: indexOf(loose) };
      if (p.k !== 'locator' && p.k !== 'testid' && (p.k !== 'role' || p.name)) {
        const exact = resolveParts([{ ...p, exact: true }]);
        u.en = exact.length; u.ei = indexOf(exact);
      }
      out[key] = u;
    }
    return out;
  }

  function stableParentCss(el) {
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const tid = testIdOf(p);
      if (tid) return `[${tid.attr}="${attrEscape(tid.value)}"]`;
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
      const t = (n.textContent || '').trim().replace(/\s+/g, ' ');
      if (t === text) c++;
    });
    return c;
  }

  function safeCount(sel) {
    try { return document.querySelectorAll(sel).length; } catch (_) { return 0; }
  }

  function selectorMeta(el, s) {
    return {
      parentCss: stableParentCss(el),
      roleCount: s.role && s.role.role ? roleMatchCount(s.role.role, s.role.name || null) : 0,
      labelCount: labelMatchCount(s.label),
      placeholderCount: s.placeholder ? safeCount(`[placeholder="${attrEscape(s.placeholder)}"]`) : 0,
      textCount: textMatchCount(s.text),
      altCount: s.alt ? safeCount(`[alt="${attrEscape(s.alt)}"]`) : 0,
      titleCount: s.title ? safeCount(`[title="${attrEscape(s.title)}"]`) : 0,
      testIdCount: s.tid ? safeCount(`[${s.tid.attr}="${attrEscape(s.tid.value)}"]`) : 0,
      cssCount: (s.css && s.css.value) ? safeCount(s.css.value) : 0,
    };
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

  // Quick, cheap locator preview for the hover tooltip (no match counting).
  function previewLocator(el) {
    const t = resolveTarget(el);
    const q = (s) => JSON.stringify(String(s).slice(0, 50));
    const role = roleSelector(t);
    if (role && role.role && role.name) return `get_by_role(${q(role.role)}, name=${q(role.name)})`;
    const label = labelText(t);
    if (label) return `get_by_label(${q(label)})`;
    const ph = t.getAttribute('placeholder');
    if (ph) return `get_by_placeholder(${q(ph)})`;
    const tid = testIdOf(t);
    if (tid) return tid.attr === 'data-testid' ? `get_by_test_id(${q(tid.value)})` : `locator(${q(`[${tid.attr}="${tid.value}"]`)})`;
    const txt = (t.textContent || '').trim().replace(/\s+/g, ' ');
    if (txt && txt.length <= 40) return `get_by_text(${q(txt)})`;
    if (role && role.role) return `get_by_role(${q(role.role)})`;
    return `locator(${q(cssSelector(t).value)})`;
  }

  // ---------- Visual highlight + tooltip ----------
  let hoverBox = null, tip = null;
  function ensureBox() {
    if (hoverBox && hoverBox.isConnected) return hoverBox;
    const root = document.documentElement || document.body;
    if (!root) return null;
    hoverBox = document.createElement('div');
    hoverBox.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #ff5c38;' +
      'background:rgba(255,92,56,.12);border-radius:3px;transition:all .05s;display:none;';
    tip = document.createElement('div');
    tip.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:420px;' +
      'background:#0f172a;color:#e2e8f0;font:12px/1.4 ui-monospace,Consolas,monospace;' +
      'padding:4px 8px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.3);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    root.appendChild(hoverBox);
    root.appendChild(tip);
    return hoverBox;
  }
  const MODE_LABEL = {
    pick: 'pick', detect: 'detect_state', is_visible: 'is_visible',
    assert_text: 'assert text', assert_value: 'assert value', assert_visible: 'assert visible',
  };
  function highlight(el) {
    const b = ensureBox();
    if (!b) return;
    const r = el.getBoundingClientRect();
    b.style.display = 'block';
    b.style.left = r.left + 'px'; b.style.top = r.top + 'px';
    b.style.width = r.width + 'px'; b.style.height = r.height + 'px';
    b.style.borderColor = armed ? '#0a84ff' : '#ff5c38';
    b.style.background = armed ? 'rgba(10,132,255,.12)' : 'rgba(255,92,56,.12)';
    if (armed && tip) {
      let txt = '';
      try { txt = previewLocator(el); } catch (_) { txt = el.tagName.toLowerCase(); }
      tip.textContent = `${MODE_LABEL[armed] || armed} · ${txt}`;
      tip.style.display = 'block';
      const top = r.top - 28 >= 0 ? r.top - 28 : r.bottom + 6;
      tip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 430)) + 'px';
      tip.style.top = top + 'px';
    } else if (tip) {
      tip.style.display = 'none';
    }
  }
  function clearHL() {
    if (hoverBox) hoverBox.style.display = 'none';
    if (tip) tip.style.display = 'none';
  }

  // ---------- Emit ----------
  function send(msg) {
    if (!alive()) return;
    try { chrome.runtime.sendMessage({ from: 'content', ...msg }).catch(() => {}); } catch (_) {}
  }

  async function emit(action) {
    const framePath = await getFramePath();
    send({ type: 'ACTION', action: { ...action, framePath, url: location.href } });
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      } else {
        fallbackCopy(text);
      }
    } catch (_) { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (_) {}
  }

  function textOf(el) {
    return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  }
  function isFormControl(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  }

  // Build and emit the action for an armed / context-menu mode.
  function emitModeAction(mode, el) {
    const selector = buildSelector(el);
    const target = resolveTarget(el);
    const base = { selector, tag: target.tagName };
    if (mode === 'pick') {
      const html = el.outerHTML || '';
      copyText(html);
      emit({ verb: 'pick', ...base, html });
    } else if (mode === 'detect') {
      emit({ verb: 'detect', ...base, html: el.outerHTML || '' });
    } else if (mode === 'is_visible') {
      emit({ verb: 'is_visible', ...base, html: el.outerHTML || '' });
    } else if (mode === 'assert_visible') {
      emit({ verb: 'assert_visible', ...base });
    } else if (mode === 'assert_value' && isFormControl(el)) {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') emit({ verb: 'assert_checked', ...base, value: !!el.checked });
      else emit({ verb: 'assert_value', ...base, value: el.value });
    } else {
      // assert_text (and assert_value on non form elements)
      emit({ verb: 'assert_text', ...base, value: textOf(target) });
    }
  }

  // ---------- Typing (debounced) ----------
  let pendingFill = null; // { el, timer }
  const lastFilled = new WeakMap(); // el -> last value emitted (avoids duplicate fill on change/blur)
  function fillAction(el) {
    const rich = el.isContentEditable && !isFormControl(el);
    const v = rich ? (el.innerText || '') : String(el.value || '');
    if (!v.trim() || lastFilled.get(el) === v) return null;
    lastFilled.set(el, v);
    return { verb: rich ? 'fill_rich' : 'fill', selector: buildSelector(el), value: v, tag: el.tagName };
  }
  function flushFill() {
    if (!pendingFill) return;
    clearTimeout(pendingFill.timer);
    const el = pendingFill.el;
    pendingFill = null;
    const a = fillAction(el);
    if (a) emit(a);
  }
  function scheduleFill(el) {
    if (pendingFill && pendingFill.el !== el) flushFill();
    if (pendingFill) clearTimeout(pendingFill.timer);
    pendingFill = { el, timer: setTimeout(flushFill, 300) };
  }

  // ---------- Event handlers ----------
  function onMouseOver(e) {
    if (!alive()) return teardown();
    if (!recording && !armed) return;
    highlight(e.target);
  }

  function isChoiceInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const t = (el.getAttribute('type') || '').toLowerCase();
    return t === 'checkbox' || t === 'radio';
  }

  function onClick(e) {
    if (!alive()) return teardown();
    if (!recording && !armed) return;
    const el = e.target;

    // one-shot armed modes: capture this element, then disarm everywhere
    if (armed) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const mode = armed;
      armed = null; clearHL();
      emitModeAction(mode, el);
      send({ type: 'MODE_DONE', mode });
      return;
    }

    flushFill();
    // Checkboxes / radios / <select> are recorded by the change handler
    // (check / uncheck / select_option) — don't add a duplicate click.
    if (isChoiceInput(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION') return;
    const lbl = el.closest && el.closest('label');
    if (lbl && lbl.control && isChoiceInput(lbl.control)) return;

    // Record the click for EVERY other element, including text inputs/textareas/contenteditable.
    // Typing is captured separately, so click + fill become two ordered steps.
    emit({ verb: 'click', selector: buildSelector(el), tag: el.tagName, opensPopup: opensPopup(el) });
  }

  // Swallow mousedown/up while armed so menus/links don't react to the pick click.
  function onMouseDownUp(e) {
    if (!armed || !alive()) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  }

  function onChange(e) {
    if (!alive()) return teardown();
    if (!recording) return;
    const el = e.target;
    if (el.tagName === 'SELECT') {
      flushFill();
      const values = Array.from(el.selectedOptions || []).map(o => o.value);
      emit({ verb: 'select', selector: buildSelector(el), value: el.multiple ? values : el.value, tag: el.tagName });
    } else if (isChoiceInput(el)) {
      flushFill();
      emit({ verb: el.checked ? 'check' : 'uncheck', selector: buildSelector(el), tag: el.tagName });
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (pendingFill && pendingFill.el === el) { flushFill(); return; }
      const a = fillAction(el);
      if (a) emit(a);
    }
  }

  function onInput(e) {
    if (!alive()) return teardown();
    if (!recording) return;
    const el = e.target;
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !isChoiceInput(el)) {
      scheduleFill(el);
    } else if (el.isContentEditable) {
      // rich text / <p> editors — record the editable root, not the inner node
      let root = el;
      while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
      scheduleFill(root);
    }
  }

  function onBlur(e) {
    if (!recording) return;
    if (pendingFill && pendingFill.el === e.target) flushFill();
  }

  const PRESS_KEYS = new Set(['Enter', 'Tab', 'Escape']);
  function onKeyDown(e) {
    if (!alive()) return teardown();
    if (armed && e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      const mode = armed;
      armed = null; clearHL();
      send({ type: 'MODE_CANCELLED', mode });
      return;
    }
    if (!recording || !PRESS_KEYS.has(e.key)) return;
    if (e.key === 'Enter' && e.target && e.target.tagName === 'TEXTAREA') return; // newline, part of fill
    flushFill();
    const el = e.target === document.body || !e.target ? null : e.target;
    if (!el) return;
    let key = e.key;
    if (e.shiftKey && key === 'Tab') key = 'Shift+Tab';
    emit({ verb: 'press', selector: buildSelector(el), value: key, tag: el.tagName });
  }

  function onContextMenu(e) { lastContextTarget = e.target; }

  const listeners = [
    ['mouseover', onMouseOver], ['click', onClick], ['mousedown', onMouseDownUp],
    ['mouseup', onMouseDownUp], ['input', onInput], ['change', onChange],
    ['blur', onBlur], ['keydown', onKeyDown], ['contextmenu', onContextMenu],
  ];
  listeners.forEach(([t, fn]) => document.addEventListener(t, fn, true));

  function teardown() {
    listeners.forEach(([t, fn]) => document.removeEventListener(t, fn, true));
    window.removeEventListener('message', onWindowMessage);
    clearHL();
    recording = false; armed = null;
  }

  // ---------- Replay: resolve Playwright-style locators in this frame ----------
  // Called by background.js via chrome.scripting.executeScript (same isolated world).
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const hasCILoose = (hay, needle) => norm(hay).toLowerCase().includes(norm(needle).toLowerCase());
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK']);

  function isOverlay(n) { return n === hoverBox || n === tip; }

  function queryPart(scope, p) {
    const all = (sel) => { try { return Array.from(scope.querySelectorAll(sel)); } catch (_) { return []; } };
    // exact: full, case-sensitive match (whitespace normalised); default: case-insensitive "contains"
    const hasCI = p.exact ? (hay, needle) => norm(hay) === norm(needle) : hasCILoose;
    switch (p.k) {
      case 'locator': {
        let v = p.v;
        if (v.startsWith('xpath=') || /^\(*\/\//.test(v) || v.startsWith('..')) {
          const xp = v.startsWith('xpath=') ? v.slice(6) : v;
          const out = [];
          try {
            const snap = document.evaluate(xp, scope, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < snap.snapshotLength; i++) { const n = snap.snapshotItem(i); if (n.nodeType === 1) out.push(n); }
          } catch (_) {}
          return out;
        }
        if (v.startsWith('css=')) v = v.slice(4);
        return all(v);
      }
      case 'role':
        return all('*').filter((n) => {
          if (isOverlay(n)) return false;
          const r = roleSelector(n);
          return r && r.role === p.role && (!p.name || hasCI(r.name || '', p.name));
        });
      case 'label': return all('input,textarea,select,[aria-label]').filter((n) => { const t = labelText(n); return t && hasCI(t, p.v); });
      case 'placeholder': return all('[placeholder]').filter((n) => hasCI(n.getAttribute('placeholder'), p.v));
      case 'alt': return all('[alt]').filter((n) => hasCI(n.getAttribute('alt'), p.v));
      case 'title': return all('[title]').filter((n) => hasCI(n.getAttribute('title'), p.v));
      case 'testid': return all(`[data-testid="${attrEscape(p.v)}"]`);
      case 'text': {
        // Smallest elements whose text contains the value (like get_by_text).
        const hits = all('*').filter((n) => !SKIP_TAGS.has(n.tagName) && !isOverlay(n) && hasCI(n.textContent, p.v));
        return hits.filter((n) => !Array.from(n.children).some((c) => hits.includes(c)));
      }
      default: return [];
    }
  }

  function resolveParts(parts) {
    let scopes = [document];
    for (const p of parts) {
      if (p.k === 'nth') { scopes = scopes[p.v] ? [scopes[p.v]] : []; continue; }
      const next = [];
      for (const s of scopes) for (const el of queryPart(s, p)) if (!next.includes(el)) next.push(el);
      scopes = next;
      if (!scopes.length) break;
    }
    return scopes;
  }

  function isVisibleEl(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function flash(el) {
    highlight(el);
    setTimeout(() => { if (!armed) clearHL(); }, 600);
  }

  window.__pwRecReplay = async (c) => {
    if (!alive() || !c) return null;
    const mine = await getFramePath();
    if (JSON.stringify(mine) !== JSON.stringify(c.framePath || [])) return null; // not this frame
    const els = resolveParts(c.parts || []);
    if (!els.length) return { found: false, count: 0 };
    const el = els.find(isVisibleEl) || els[0];
    const base = { found: true, count: els.length, visible: isVisibleEl(el) };
    switch (c.op) {
      case 'locate': {
        try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
        const off = await getFrameOffset();
        const r = el.getBoundingClientRect();
        flash(el);
        return { ...base, visible: isVisibleEl(el), x: off.x + r.left + r.width / 2, y: off.y + r.top + r.height / 2 };
      }
      case 'focus':
        el.focus();
        return base;
      case 'focusSelect': {
        el.focus();
        if (isFormControl(el)) {
          let selected = false;
          try { el.select(); selected = el.selectionStart === 0 && el.selectionEnd === String(el.value).length; } catch (_) {}
          if (!selected) el.value = '';
        } else if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = getSelection();
          sel.removeAllRanges(); sel.addRange(range);
        }
        flash(el);
        return base;
      }
      case 'select': {
        if (el.tagName !== 'SELECT') return { ...base, error: 'element is not a <select>' };
        const vals = (Array.isArray(c.value) ? c.value : [c.value]).map(String);
        let any = false;
        for (const o of el.options) {
          o.selected = vals.includes(o.value) || vals.includes(norm(o.label));
          any = any || o.selected;
        }
        if (!any) return { ...base, error: `option ${JSON.stringify(c.value)} not found` };
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        flash(el);
        return base;
      }
      case 'state':
      default:
        return {
          ...base,
          text: norm(el.innerText || el.textContent),
          value: 'value' in el ? String(el.value) : null,
          checked: !!el.checked,
        };
    }
  };

  // ---------- Commands from background ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.from !== 'bg') return;
    if (msg.type === 'STATE') {
      recording = !!msg.recording;
      if (!recording) { flushFill(); if (!armed) clearHL(); }
    }
    if (msg.type === 'ARM') {
      armed = msg.mode || null;
      if (!armed) clearHL();
    }
    if (msg.type === 'CTX' && lastContextTarget) {
      emitModeAction(msg.mode, lastContextTarget);
      send({ type: 'MODE_DONE', mode: msg.mode });
    }
  });

  try {
    chrome.storage.local.get(['settings'], (d) => {
      if (d && d.settings && d.settings.testIdAttr) testIdAttr = d.settings.testIdAttr;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings && changes.settings.newValue) {
        testIdAttr = changes.settings.newValue.testIdAttr || 'data-testid';
      }
    });
  } catch (_) {}

  // Pick up the recording state on every page load, so recording continues
  // after navigations (clicking links, submitting forms, ...).
  try {
    chrome.runtime.sendMessage({ from: 'content', type: 'GET_STATE' }, (res) => {
      void chrome.runtime.lastError;
      if (res) recording = !!res.recording;
    });
  } catch (_) {}
})();
