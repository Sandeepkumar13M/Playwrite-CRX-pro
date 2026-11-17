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
  let selStrategy = 'text';
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

  // ---------- Shadow DOM aware queries ----------
  // Playwright's CSS and get_by_* locators pierce OPEN shadow roots, so we do the same.
  function shadowRoots(root) {
    const out = [root];
    const walk = (r) => {
      if (r.shadowRoot) { out.push(r.shadowRoot); walk(r.shadowRoot); }
      for (const el of r.querySelectorAll('*')) if (el.shadowRoot) { out.push(el.shadowRoot); walk(el.shadowRoot); }
    };
    try { walk(root); } catch (_) {}
    return out;
  }
  function deepQueryAll(root, sel) {
    const res = [];
    for (const r of shadowRoots(root)) {
      try { for (const el of r.querySelectorAll(sel)) if (!res.includes(el)) res.push(el); } catch (_) { return []; }
    }
    return res;
  }

  function iframeSelectorFor(el) {
    // Build a STABLE selector for an <iframe>/<frame> as seen from its parent document:
    // stable id > name > title > src without query/hash (tokens change) > position.
    const doc = el.ownerDocument;
    const tag = el.tagName.toLowerCase();
    const cands = [];
    if (el.id && !isDynamicId(el.id)) cands.push(`#${cssEscape(el.id)}`);
    const name = el.getAttribute('name');
    if (name && !isDynamicId(name)) cands.push(`${tag}[name="${attrEscape(name)}"]`);
    const title = el.getAttribute('title');
    if (title) cands.push(`${tag}[title="${attrEscape(title)}"]`);
    const src = el.getAttribute('src');
    if (src && !/^(data|javascript|blob|about):/i.test(src)) {
      const stable = src.split(/[?#]/)[0];
      if (stable && stable.length <= 200) cands.push(stable === src ? `${tag}[src="${attrEscape(src)}"]` : `${tag}[src^="${attrEscape(stable)}"]`);
    }
    for (const c of cands) if (deepQueryAll(doc, c).length === 1) return c;
    const all = deepQueryAll(doc, tag);
    return `${tag} >> nth=${Math.max(0, all.indexOf(el))}`;
  }

  function childFrameElement(source) {
    for (const f of deepQueryAll(document, 'iframe, frame')) {
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
      const f = childFrameElement(e.source);
      const selector = f ? iframeSelectorFor(f) : null;
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
  // Generated ids change on every page load / build — never build selectors on them.
  // React useId (":r1a:"), Radix / Headless UI / MUI / Ember / Angular ids, GUIDs, hashes, long numbers.
  function isDynamicId(id) {
    if (!id) return true;
    return /(^[a-f0-9]{8,}$)|([a-f0-9]{6,}-[a-f0-9]{4,})|(_\d{4,})|\d{5,}|:/i.test(id) ||
      /^(radix-|headlessui-|mui-|react-|rc[-_]|ember\d|ext-|gwt-|ng-|cdk-|mat-|el-id|__next|yui_|jsx-|uid-|id-\d)/i.test(id);
  }

  // Utility-CSS (Tailwind, Bootstrap helpers) and hashed CSS-module / CSS-in-JS classes are unstable.
  const UTILITY_CLASS = /^(?:[a-z0-9-]+:|-?(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|items|justify|content|self|place|gap|space|p[xytrbl]?|m[xytrbl]?|w|h|min|max|size|text|font|leading|tracking|bg|border|rounded|shadow|ring|outline|opacity|z|top|left|right|bottom|inset|overflow|cursor|select|pointer|transition|duration|ease|delay|animate|transform|translate|rotate|scale|origin|truncate|whitespace|break|sr|group|peer|dark|hover|focus|active|col|row|order|grow|shrink|basis|object|aspect|fill|stroke|decoration|underline|list|align|visible|invisible|container|d|float|clearfix|mx-auto|btn-sm|btn-lg)(?:-|$))/;
  const HASHED_CLASS = /^(?:css|sc|jsx|emotion|styled|svelte|astro|tw)-|[_-](?=[a-zA-Z0-9]*\d)[a-zA-Z0-9]{5,}$|[[\]:/!.%#]|\d{3,}/;
  function stableClasses(n) {
    return Array.from(n.classList || []).filter((c) => c.length <= 32 && !UTILITY_CLASS.test(c) && !HASHED_CLASS.test(c));
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

  // Roles that are never named by their content (accname spec / Playwright): a text box's
  // "content" is what the user typed, a listbox's content is its options, ...
  const NO_NAME_FROM_CONTENT = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox',
    'tree', 'grid', 'table', 'list', 'menu', 'menubar', 'tablist', 'toolbar', 'radiogroup', 'group', 'region', 'navigation', 'main', 'form', 'dialog']);

  // Text like the browser shows it: block-level children are separated by spaces
  // ("Dev Test" + "dev@x.dev" → "Dev Test dev@x.dev"), hidden text is left out.
  function visibleText(el) {
    const t = typeof el.innerText === 'string' && el.isConnected ? el.innerText : el.textContent;
    return (t || '').replace(/\s+/g, ' ').trim();
  }

  function accessibleName(el, role) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().replace(/\s+/g, ' ');
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const doc = el.getRootNode();
      const txt = lb.split(/\s+/).map((id) => doc.getElementById && doc.getElementById(id)).filter(Boolean).map(visibleText).join(' ').trim();
      if (txt) return txt;
    }
    if (el.labels && el.labels.length) return visibleText(el.labels[0]) || null;
    const ph = el.getAttribute('placeholder');
    if (ph && ph.trim()) return ph.trim();
    if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim() || null;
    if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type || '')) return (el.value || '').trim() || null;
    const title = (el.getAttribute('title') || '').trim() || null;
    if (NO_NAME_FROM_CONTENT.has(role) || isFormControl(el) || el.isContentEditable) return title;
    const txt = visibleText(el);
    if (txt && txt.length <= 80) return txt;
    return title;
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
    const name = accessibleName(el, role);
    return { kind: 'role', role, name };
  }

  // Attributes that identify an element and survive redesigns (in priority order).
  const STABLE_ATTRS = ['name', 'aria-label', 'placeholder', 'title', 'alt', 'for', 'data-id', 'data-name', 'data-key', 'aria-controls', 'role', 'type', 'value'];
  function attrUsable(a, v) {
    if (!v || v.length > 80 || /\n/.test(v)) return false;
    if ((a === 'aria-controls' || a === 'for' || a.startsWith('data-')) && isDynamicId(v)) return false;
    return true;
  }

  // CSS selector, most stable first: #id → test id → [stable attribute] → .stable-class → short
  // path anchored on the nearest ancestor that has one of those (never on utility classes).
  function cssSelector(el) {
    const root = el.getRootNode();
    const unique = (sel) => { try { const l = root.querySelectorAll(sel); return l.length === 1 && l[0] === el; } catch (_) { return false; } };
    const own = ownCssCandidates(el);
    for (const c of own) if (unique(c)) return { kind: 'css', value: c };
    // combine two attributes, e.g. input[type="email"][name="q"]
    const tag = el.tagName.toLowerCase();
    const attrs = own.filter((c) => c.startsWith(tag + '['));
    for (let i = 0; i < attrs.length; i++) for (let j = i + 1; j < attrs.length; j++) {
      const c = attrs[i] + attrs[j].slice(tag.length);
      if (unique(c)) return { kind: 'css', value: c };
    }
    const parts = [];
    let positionalOnly = null; // unique, but only by position (nth-of-type) — keep looking for an anchor
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const cands = ownCssCandidates(node);
      // anchor: an ancestor that is unique by itself → shortest unique path below it
      const anchor = node !== el && cands.find((c) => { try { return root.querySelectorAll(c).length === 1; } catch (_) { return false; } });
      if (anchor) {
        for (let k = 1; k <= parts.length; k++) {
          const sel = `${anchor} ${parts.slice(parts.length - k).join(' > ')}`;
          if (unique(sel)) return { kind: 'css', value: sel };
        }
      }
      let seg = cands.find((c) => !c.startsWith('#') && !c.startsWith('[')) || node.tagName.toLowerCase();
      const parent = node.parentElement || (node.parentNode && node.parentNode.host ? null : node.parentNode);
      if (parent && parent.children) {
        let same = [];
        try { same = Array.from(parent.querySelectorAll(':scope > ' + seg)); } catch (_) {}
        if (same.length > 1) {
          const sib = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          seg = `${seg}:nth-of-type(${sib.indexOf(node) + 1})`;
        }
      }
      parts.unshift(seg);
      const path = parts.join(' > ');
      if (!positionalOnly && unique(path)) {
        if (!path.includes(':nth-of-type')) return { kind: 'css', value: path };
        positionalOnly = path;
      }
      if (!node.parentElement) break;
      node = node.parentElement;
    }
    return { kind: 'css', value: positionalOnly || parts.join(' > ') };
  }

  // Landmarks make good anchors when they are unique on the page.
  const LANDMARKS = new Set(['main', 'nav', 'header', 'footer', 'aside', 'form', 'dialog', 'section', 'article', 'table', 'ul', 'ol']);

  function ownCssCandidates(n) {
    const tag = n.tagName.toLowerCase();
    const out = [];
    if (n.id && !isDynamicId(n.id)) out.push(`#${cssEscape(n.id)}`);
    const tid = testIdOf(n);
    if (tid) out.push(`[${tid.attr}="${attrEscape(tid.value)}"]`);
    for (const a of STABLE_ATTRS) {
      const v = n.getAttribute(a);
      if (attrUsable(a, v)) out.push(`${tag}[${a}="${attrEscape(v)}"]`);
    }
    if (tag === 'a') {
      const href = n.getAttribute('href');
      if (href && href.length <= 100 && !/[?#]|^javascript:/i.test(href)) out.push(`a[href="${attrEscape(href)}"]`);
    }
    const cls = stableClasses(n).slice(0, 2);
    if (cls.length) out.push(tag + cls.map((c) => '.' + cssEscape(c)).join(''));
    if (LANDMARKS.has(tag)) out.push(tag);
    return out;
  }

  // XPath predicates for one element, most stable first.
  function xpPredicates(n) {
    const out = [];
    if (n.id && !isDynamicId(n.id)) out.push(`@id=${xpLit(n.id)}`);
    const tid = testIdOf(n);
    if (tid) out.push(`@${tid.attr}=${xpLit(tid.value)}`);
    for (const a of ['name', 'aria-label', 'placeholder', 'title', 'alt', 'data-id', 'data-name']) {
      const v = n.getAttribute(a);
      if (attrUsable(a, v)) out.push(`@${a}=${xpLit(v)}`);
    }
    const txt = norm(n.textContent);
    if (txt && txt.length <= 50 && !isFormControl(n) && !n.isContentEditable) out.push(`normalize-space(.)=${xpLit(txt)}`);
    for (const c of stableClasses(n).slice(0, 1)) out.push(`contains(concat(' ', normalize-space(@class), ' '), ${xpLit(' ' + c + ' ')})`);
    return out;
  }

  // Relative XPath (never /html[1]/body[1]/... unless nothing else exists):
  // //tag[@attr='…'] → //tag[normalize-space(.)='text'] → //anchor//relative/path
  function xpathSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.getRootNode() !== document) return null; // XPath cannot reach into shadow DOM
    const snap = (xp) => { try { return document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); } catch (_) { return null; } };
    const isOnly = (xp, node) => { const s = snap(xp); return !!s && s.snapshotLength === 1 && s.snapshotItem(0) === node; };
    const tag = el.tagName.toLowerCase();
    for (const p of xpPredicates(el)) {
      const xp = p.startsWith('@id=') ? `//*[${p}]` : `//${tag}[${p}]`;
      if (isOnly(xp, el)) return { kind: 'xpath', value: xp };
    }
    const steps = [];
    let positionalOnly = null; // unique only by position ([2]) — keep looking for an anchor
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const t = node.tagName.toLowerCase();
      if (node !== el) {
        // container text changes with its content — anchors use attributes/classes only
        const anchors = xpPredicates(node).filter((p) => !p.startsWith('normalize-space'))
          .map((p) => (p.startsWith('@id=') ? `//*[${p}]` : `//${t}[${p}]`));
        if (LANDMARKS.has(t)) anchors.push(`//${t}`);
        for (const anchor of anchors) {
          if (!isOnly(anchor, node)) continue;
          // shortest relative path below the anchor
          for (let k = 1; k <= steps.length; k++) {
            const tail = steps.slice(steps.length - k);
            const xp = k === steps.length ? `${anchor}/${tail.join('/')}` : `${anchor}//${tail.join('/')}`;
            if (isOnly(xp, el)) return { kind: 'xpath', value: xp };
          }
        }
      }
      const parent = node.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.tagName === node.tagName) : [node];
      steps.unshift(same.length > 1 ? `${t}[${same.indexOf(node) + 1}]` : t);
      const rel = `//${steps.join('/')}`;
      if (!positionalOnly && isOnly(rel, el)) {
        if (!/\[\d+\]/.test(rel)) return { kind: 'xpath', value: rel };
        positionalOnly = rel;
      }
      node = parent;
    }
    return { kind: 'xpath', value: positionalOnly || `/html/${steps.join('/')}` };
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
    // Editable rich-text areas: their text is what the user typed — never a locator.
    const text = isFormControl(target) || target.isContentEditable ? '' : (target.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const placeholder = (target.getAttribute('placeholder') || '').trim() || null;
    const alt = (target.getAttribute('alt') || '').trim() || null;
    const title = (target.getAttribute('title') || '').trim() || null;
    const tid = testIdOf(target);
    const testId = tid ? tid.value : null;
    const label = labelText(target);
    const meta = selectorMeta(target, { role, label, placeholder, text, alt, title, tid, css });
    try { meta.uniq = uniqInfo(target, { role, label, placeholder, text, alt, title, tid, css, xpath }); } catch (_) {}
    let selenium = null;
    try { selenium = seleniumInfo(target, { role, label, placeholder, text, alt, title, tid, css, xpath }); } catch (_) {}
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
      selenium,
    };
  }

  // ---------- Selenium locators (By.ID / NAME / CSS_SELECTOR / XPATH) ----------
  function xpLit(s) {
    s = String(s);
    if (!s.includes("'")) return `'${s}'`;
    if (!s.includes('"')) return `"${s}"`;
    return 'concat(' + s.split("'").map((p) => `'${p}'`).join(`, "'", `) + ')';
  }
  // Every candidate is counted on the page, like the Playwright ones, so codegen can pick a unique one.
  // Elements in shadow DOM: Selenium can only use CSS inside a shadow root, reached via the host chain.
  function seleniumInfo(t, s) {
    const root = t.getRootNode();
    const inShadow = root !== document;
    const pos = (list) => {
      let i = list.indexOf(t);
      if (i < 0) i = list.findIndex((e) => t.contains(e));
      return { n: list.length, i };
    };
    const countCss = (css) => { try { return pos(Array.from(root.querySelectorAll(css))); } catch (_) { return null; } };
    const countXp = (xp) => {
      if (inShadow) return null;
      try {
        const r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const l = [];
        for (let k = 0; k < r.snapshotLength; k++) l.push(r.snapshotItem(k));
        return pos(l);
      } catch (_) { return null; }
    };
    const cands = {};
    const add = (key, by, v) => {
      if (!v || cands[key]) return;
      const m = by === 'xpath' ? countXp(v)
        : by === 'id' ? countCss(`#${cssEscape(v)}`)
        : by === 'name' ? countCss(`[name="${attrEscape(v)}"]`)
        : countCss(v);
      if (m && m.n) cands[key] = { by, v, ...m };
    };
    const tag = t.tagName.toLowerCase();
    const aria = t.getAttribute('aria-label');
    const textEq = (x) => `normalize-space(.)=${xpLit(norm(x))}`;

    if (t.id && !isDynamicId(t.id)) add('id', 'id', t.id);
    const nm = t.getAttribute('name');
    if (nm && isFormControl(t)) add('name', 'name', nm);
    if (s.tid) add('test_id', 'css', `[${s.tid.attr}="${attrEscape(s.tid.value)}"]`);
    if (s.placeholder) add('placeholder', 'css', `${tag}[placeholder="${attrEscape(s.placeholder)}"]`);
    if (s.alt) add('alt_text', 'css', `${tag}[alt="${attrEscape(s.alt)}"]`);
    if (s.title) add('title', 'css', `${tag}[title="${attrEscape(s.title)}"]`);

    const lab = t.labels && t.labels[0];
    if (lab && !inShadow) {
      const lt = norm(lab.textContent);
      if (lab.htmlFor) add('label', 'xpath', `//*[@id=//label[${textEq(lt)}]/@for]`);
      else add('label', 'xpath', `//label[${textEq(lt)}]//${tag}`);
    } else if (aria) add('label', 'css', `${tag}[aria-label="${attrEscape(aria)}"]`);

    if (s.role && s.role.name) {
      const name = s.role.name;
      if (aria) add('role', 'css', `${tag}[aria-label="${attrEscape(aria)}"]`);
      else if (tag === 'img') add('role', 'css', `img[alt="${attrEscape(name)}"]`);
      else if (tag === 'input' && /^(submit|button|reset)$/i.test(t.type) && t.value) add('role', 'css', `input[value="${attrEscape(t.value)}"]`);
      else if (lab && !inShadow) add('role', 'xpath', cands.label ? cands.label.v : `//label[${textEq(lab.textContent)}]//${tag}`);
      else if (t.getAttribute('placeholder') && norm(t.getAttribute('placeholder')) === norm(name)) add('role', 'css', `${tag}[placeholder="${attrEscape(t.getAttribute('placeholder'))}"]`);
      else if (!inShadow && norm(t.textContent) === norm(name)) add('role', 'xpath', `//${tag}[${textEq(name)}]`);
    }
    if (s.text && !inShadow && !isFormControl(t)) {
      // deepest element whose whole text is the value
      add('text', 'xpath', `//*[${textEq(s.text)} and not(*[${textEq(s.text)}])]`);
    }
    if (s.css && s.css.value) add('css', 'css', s.css.value);
    if (s.xpath && s.xpath.value) add('xpath', 'xpath', s.xpath.value);

    // open shadow root chain: CSS for each host, outermost first
    const shadow = [];
    let r = root;
    while (r && r !== document && r.host) { shadow.unshift(cssSelector(r.host).value); r = r.host.getRootNode(); }
    return { cands, shadow };
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


  // Quick, cheap locator preview for the hover tooltip (no match counting).
  // Follows the selected strategy pill (falls back in Playwright's priority order).
  function previewLocator(el) {
    const t = resolveTarget(el);
    const q = (s) => JSON.stringify(String(s).slice(0, 50));
    const role = roleSelector(t);
    const tid = testIdOf(t);
    const txt = isFormControl(t) ? '' : (t.textContent || '').trim().replace(/\s+/g, ' ');
    const c = {
      role: () => role && role.role ? (role.name ? `get_by_role(${q(role.role)}, name=${q(role.name)})` : `get_by_role(${q(role.role)})`) : null,
      label: () => { const l = labelText(t); return l ? `get_by_label(${q(l)})` : null; },
      placeholder: () => { const p = t.getAttribute('placeholder'); return p ? `get_by_placeholder(${q(p)})` : null; },
      test_id: () => tid ? (tid.attr === 'data-testid' ? `get_by_test_id(${q(tid.value)})` : `locator(${q(`[${tid.attr}="${tid.value}"]`)})`) : null,
      text: () => txt && txt.length <= 80 ? `get_by_text(${q(txt)})` : null,
      alt_text: () => { const a = t.getAttribute('alt'); return a ? `get_by_alt_text(${q(a)})` : null; },
      title: () => { const a = t.getAttribute('title'); return a ? `get_by_title(${q(a)})` : null; },
      css: () => `locator(${q(cssSelector(t).value)})`,
      xpath: () => `locator(${q('xpath=' + xpathSelector(t).value)})`,
    };
    const order = [selStrategy, 'role', 'label', 'placeholder', 'test_id', 'text', 'alt_text', 'title', 'css'];
    for (const k of order) { const v = c[k] && c[k](); if (v) return v; }
    return c.css();
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
    // Time of the user action: iframe actions need a moment to compute their frame path,
    // so the background orders steps by this, not by arrival.
    const t = Date.now();
    const framePath = await getFramePath();
    send({ type: 'ACTION', action: { ...action, framePath, url: location.href, t } });
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
  // The real element under the pointer, even inside (open) shadow DOM.
  function realTarget(e) {
    let t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (t && t.nodeType === 3) t = t.parentElement;
    return t && t.nodeType === 1 ? t : null;
  }

  function onMouseOver(e) {
    if (!alive()) return teardown();
    if (!recording && !armed) return;
    const el = realTarget(e);
    if (el && !isOverlay(el)) highlight(el);
  }

  function isChoiceInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const t = (el.getAttribute('type') || '').toLowerCase();
    return t === 'checkbox' || t === 'radio';
  }

  // Click recording happens at POINTER-DOWN time:
  //  - modals/menus that close or re-render on mousedown (e.g. "Cancel"/"Proceed" dialogs)
  //    would otherwise send the click to the backdrop, or no click at all;
  //  - when mousedown and mouseup hit different elements, the browser sends the click
  //    to their common ancestor — we still record what the user pressed.
  let downInfo = null;      // { el, action, at }
  let swallowGesture = false; // swallow the rest of ONE pick gesture (mouseup/click), nothing after it

  function clickActionFor(el) {
    if (!el || isOverlay(el)) return null;
    // Checkboxes / radios / <select> are recorded by the change handler
    // (check / uncheck / select_option) — don't add a duplicate click.
    if (isChoiceInput(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION') return null;
    const lbl = el.closest && el.closest('label');
    if (lbl && lbl.control && isChoiceInput(lbl.control)) return null;
    // New tabs / popup windows are detected by the background (chrome.webNavigation),
    // which then marks this step as "opens popup" — works for links, window.open, Ctrl+click, ...
    return { verb: 'click', selector: buildSelector(el), tag: resolveTarget(el).tagName };
  }

  function finishArmed(e, el) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const mode = armed;
    armed = null; clearHL();
    swallowGesture = e.type === 'pointerdown'; // a click event ends the gesture itself
    if (el) emitModeAction(mode, el);
    send({ type: 'MODE_DONE', mode });
  }

  function onPointerDown(e) {
    if (!alive()) return teardown();
    const el = realTarget(e);
    swallowGesture = false; // a new gesture starts
    if (armed) { if (e.button === 0) finishArmed(e, el); return; }
    // left click, or middle click (opens links in a new tab)
    if (!recording || (e.button !== 0 && e.button !== 1) || !e.isTrusted || !el) return;
    flushFill();
    // A previous press whose click never arrived (its element vanished on mousedown):
    // record it now, before this new one, so nothing is lost and order is kept.
    if (downInfo) { const prev = downInfo; downInfo = null; if (prev.action) emit(prev.action); }
    // Build the selector NOW, while the element still exists.
    const action = clickActionFor(el);
    if (action) {
      // Ctrl/Cmd+click and Shift+click open links in a new tab / window — keep them.
      const mods = [];
      if (e.ctrlKey || e.metaKey) mods.push('ControlOrMeta');
      if (e.shiftKey) mods.push('Shift');
      if (e.altKey) mods.push('Alt');
      if (mods.length) action.modifiers = mods;
      if (e.button === 1) action.button = 'middle';
    }
    downInfo = { el, action, at: Date.now() };
  }

  function onPointerUp(e) {
    if (swallowGesture) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      setTimeout(() => { swallowGesture = false; }, 300); // in case no click event follows
      return;
    }
    if (!recording || !downInfo) return;
    const d = downInfo;
    // If no click event arrives (element removed on mousedown), record it anyway.
    setTimeout(() => { if (downInfo === d) { downInfo = null; if (d.action) emit(d.action); } }, 600);
  }

  // Swallow mousedown/mouseup that belong to a pick gesture so menus/links don't react.
  function onMouseDownUp(e) {
    if (!alive()) return;
    if (armed || swallowGesture) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
  }

  function onClick(e) {
    if (!alive()) return teardown();
    if (swallowGesture) { swallowGesture = false; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return; }
    if (armed) { finishArmed(e, realTarget(e)); return; } // e.g. keyboard-activated pick
    if (!recording) return;

    if (downInfo && Date.now() - downInfo.at < 3000) {
      const d = downInfo;
      downInfo = null;
      if (d.action) emit(d.action);
      return;
    }
    // No pointer-down seen: ignore clicks made by page scripts (el.click()) and
    // keyboard activation (Enter/Space are recorded as "press").
    if (!e.isTrusted || e.detail === 0) return;
    flushFill();
    const a = clickActionFor(realTarget(e));
    if (a) emit(a);
  }

  function onChange(e) {
    if (!alive()) return teardown();
    if (!recording) return;
    const el = realTarget(e);
    if (!el) return;
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
    if (!recording || !e.isTrusted) return;
    const el = realTarget(e);
    if (!el) return;
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
    if (pendingFill && pendingFill.el === realTarget(e)) flushFill();
  }

  const PRESS_KEYS = new Set(['Enter', 'Tab', 'Escape', ' ']);
  function isEditable(el) {
    return !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
      (el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|image|file|color|range)$/i.test(el.type || '')));
  }
  function onKeyDown(e) {
    if (!alive()) return teardown();
    if (armed && e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      const mode = armed;
      armed = null; clearHL();
      send({ type: 'MODE_CANCELLED', mode });
      return;
    }
    if (!recording || !e.isTrusted || !PRESS_KEYS.has(e.key)) return;
    const el = realTarget(e);
    if (!el || el === document.body || el === document.documentElement) return;
    if (e.key === 'Enter' && el.tagName === 'TEXTAREA') return; // newline, part of fill
    if (e.key === ' ' && isEditable(el)) return;               // typing a space
    flushFill();
    let key = e.key === ' ' ? 'Space' : e.key;
    if (e.shiftKey && key === 'Tab') key = 'Shift+Tab';
    emit({ verb: 'press', selector: buildSelector(el), value: key, tag: el.tagName });
  }

  function onContextMenu(e) { lastContextTarget = realTarget(e); }

  // Capture phase on WINDOW: we run before page / other-extension listeners that call
  // stopPropagation() on document or window (common in modals and overlays).
  const listeners = [
    ['mouseover', onMouseOver], ['pointerdown', onPointerDown], ['pointerup', onPointerUp],
    ['mousedown', onMouseDownUp], ['mouseup', onMouseDownUp], ['click', onClick],
    ['input', onInput], ['change', onChange], ['blur', onBlur], ['keydown', onKeyDown],
    ['contextmenu', onContextMenu],
  ];
  listeners.forEach(([t, fn]) => window.addEventListener(t, fn, true));

  function teardown() {
    listeners.forEach(([t, fn]) => window.removeEventListener(t, fn, true));
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
    const all = (sel) => deepQueryAll(scope, sel);
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
        // Like Playwright's get_by_role: elements hidden from accessibility don't count
        // (display:none, visibility:hidden, aria-hidden="true", hidden, inert) — e.g. the
        // duplicate profile button ChatGPT keeps in its collapsed sidebar.
        return all('*').filter((n) => {
          if (isOverlay(n)) return false;
          const r = roleSelector(n);
          return r && r.role === p.role && (!p.name || hasCI(r.name || '', p.name)) && !hiddenForA11y(n);
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

  function hiddenForA11y(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode() && n.getRootNode().host) || null) {
      if (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert')) return true;
      if (getComputedStyle(n).display === 'none') return true;
    }
    const v = getComputedStyle(el).visibility;
    return v === 'hidden' || v === 'collapse';
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

  function deepElementFromPoint(x, y) {
    let h = document.elementFromPoint(x, y);
    while (h && h.shadowRoot) {
      const inner = h.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === h) break;
      h = inner;
    }
    return h;
  }
  // el contains node, also across shadow boundaries
  function composedContains(el, node) {
    for (let n = node; n; n = n.parentNode || n.host) if (n === el) return true;
    return false;
  }
  function describeEl(n) {
    const cls = n.classList && n.classList.length ? '.' + Array.from(n.classList).slice(0, 2).join('.') : '';
    return `<${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${cls}>`;
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
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        // Like Playwright: the element must actually receive the click (not covered by a modal/overlay).
        const hitEl = deepElementFromPoint(cx, cy);
        const hit = !!hitEl && composedContains(el, hitEl);
        const off = await getFrameOffset();
        flash(el);
        return {
          ...base, visible: isVisibleEl(el), hit,
          coveredBy: hit || !hitEl ? null : describeEl(hitEl),
          x: off.x + cx, y: off.y + cy,
        };
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
      if (d && d.settings && d.settings.sel) selStrategy = d.settings.sel;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings && changes.settings.newValue) {
        testIdAttr = changes.settings.newValue.testIdAttr || 'data-testid';
        selStrategy = changes.settings.newValue.sel || 'text';
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
