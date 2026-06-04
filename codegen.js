// codegen.js — generates BaseState-style Playwright Python (inline selectors)
(function (global) {

  function pyStr(s) {
    if (s == null) s = '';
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }

  function snake(s) {
    return (s || 'element')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/__+/g, '_')
      .toLowerCase() || 'element';
  }

  // Build "self.app.page" + optional ".frame_locator(...)" chain for the iframe path,
  // then the element locator (role-first or css).
  function locatorChain(step, strategy) {
    const sel = step.selector || {};
    const role = sel.role, css = sel.css;
    let chain = 'self.app.page';
    if (step.framePath && step.framePath.length) {
      for (const fs of step.framePath) chain += `.frame_locator(${pyStr(fs)})`;
    }
    const useRole = (strategy === 'role') || (strategy === 'auto' && role && role.role);
    if (useRole && role && role.role) {
      if (role.name) return chain + `.get_by_role(${pyStr(role.role)}, name=${pyStr(role.name)})`;
      return chain + `.get_by_role(${pyStr(role.role)})`;
    }
    if (css && css.value) return chain + `.locator(${pyStr(css.value)})`;
    if (role && role.name) return chain + `.get_by_text(${pyStr(role.name)})`;
    return chain + `.locator(${pyStr('body')})`;
  }

  function waitLines(loc, step, opts, indent) {
    const style = step.waitStyle || opts.wait;
    const state = step.waitState || opts.state;
    const t = step.timeout || opts.timeout || 10000;
    const pad = ' '.repeat(indent);
    if (style === 'none') return [];
    if (style === 'expect') {
      const map = { visible: 'to_be_visible', attached: 'to_be_attached', enabled: 'to_be_enabled' };
      return [`${pad}expect(${loc}).${map[state] || 'to_be_visible'}(timeout=${t})`];
    }
    if (state === 'enabled') {
      return [
        `${pad}${loc}.wait_for(state="visible", timeout=${t})`,
        `${pad}expect(${loc}).to_be_enabled(timeout=${t})`
      ];
    }
    return [`${pad}${loc}.wait_for(state=${pyStr(state)}, timeout=${t})`];
  }

  function actionLines(loc, step, indent) {
    const pad = ' '.repeat(indent);
    switch (step.verb) {
      case 'click': return [`${pad}${loc}.click()`];
      case 'fill': return [`${pad}${loc}.fill(${pyStr(step.value)})`];
      case 'fill_rich': return [`${pad}${loc}.click()`, `${pad}${loc}.fill(${pyStr(step.value)})`];
      case 'check': return [`${pad}${loc}.check()`];
      case 'uncheck': return [`${pad}${loc}.uncheck()`];
      case 'select': return [`${pad}${loc}.select_option(${pyStr(step.value)})`];
      default: return [`${pad}${loc}.click()`];
    }
  }

  function methodName(step, i) {
    const base = (step.selector && step.selector.role && step.selector.role.name)
      || (step.selector && step.selector.text) || step.tag || 'element';
    const vm = { click:'click', fill:'fill', fill_rich:'fill', check:'check', uncheck:'uncheck', select:'select' };
    return `${vm[step.verb] || 'do'}_${snake(base)}`;
  }

  function retLine(step) {
    const r = step.returnVal || 'true_none';
    if (r === 'true_none') return '        return True, None';
    if (r === 'true_state') return `        return True, ${pyStr(step.returnState || 'next_state')}`;
    if (r === 'none') return null;
    return '        return True, None';
  }

  function generate(steps, opts) {
    const cls = opts.className || 'GeneratedState';
    const detectStep = steps.find(s => s.isDetect || s.verb === 'detect');
    const actionSteps = steps.filter(s => !s.isDetect && s.verb !== 'detect');
    const usesExpect = actionSteps.some(s =>
      (s.waitStyle || opts.wait) === 'expect' || (s.waitState || opts.state) === 'enabled');

    const L = [];
    L.push('from ...base.base_state import BaseState');
    if (usesExpect) L.push('from playwright.sync_api import expect');
    L.push('');
    L.push('');
    L.push(`class ${cls}(BaseState):`);
    L.push('    def __init__(self, app):');
    L.push('        super().__init__(app)');
    L.push('        self.actions = {');
    actionSteps.forEach((s, i) => {
      const m = methodName(s, i);
      L.push(`            ${pyStr(m)}: self.${m},`);
    });
    L.push('        }');
    L.push('');

    // detect_state
    L.push('    def detect_state(self):');
    if (detectStep) {
      const loc = locatorChain(detectStep, detectStep.selStrategy || opts.sel);
      L.push(`        return ${loc}.is_visible()`);
    } else {
      L.push('        # TODO: mark a step as detect_state in the recorder');
      L.push('        return False');
    }
    L.push('');

    // action methods
    actionSteps.forEach((step, i) => {
      const loc = locatorChain(step, step.selStrategy || opts.sel);
      const m = methodName(step, i);
      const arg = step.verb === 'fill' || step.verb === 'fill_rich' ? ', message' : '';
      L.push(`    def ${m}(self${arg}):`);
      const frameNote = step.framePath && step.framePath.length
        ? `  # iframe depth ${step.framePath.length}` : '';
      if (frameNote) L.push(`        ${frameNote.trim()}`);
      for (const w of waitLines(loc, step, opts, 8)) L.push(w);
      // if fill uses 'message' arg, swap the literal for the param
      let acts = actionLines(loc, step, 8);
      if (arg) acts = acts.map(a => a.replace(/\.fill\(".*?"\)/, '.fill(message)'));
      for (const a of acts) L.push(a);
      const r = retLine(step);
      if (r) L.push(r);
      L.push('');
    });

    if (!steps.length) {
      L.push('    # no steps recorded yet');
    }
    return L.join('\n');
  }

  // ---- flat Playwright-Python codegen (locators + flow) ----

  function locVarName(step, used) {
    const base = snake(
      (step.selector && step.selector.role && step.selector.role.name) ||
      (step.selector && step.selector.text) || step.tag || 'element'
    );
    let name = base, n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    return name;
  }

  function locExpr(step, strategy, pageVar) {
    const sel = step.selector || {};
    const role = sel.role, css = sel.css, xpath = sel.xpath;
    const meta = sel.meta || {};
    let chain = pageVar || 'page';
    if (step.framePath && step.framePath.length)
      for (const fs of step.framePath) chain += `.frame_locator(${pyStr(fs)})`;
    const scopedChain = meta.parentCss ? `${chain}.locator(${pyStr(meta.parentCss)})` : chain;
    const withScope = (rawExpr, count) => {
      if (count > 1 && meta.parentCss) {
        return { expr: rawExpr(scopedChain), scoped: true };
      }
      return { expr: rawExpr(chain), scoped: false };
    };

    const byRole = () => {
      if (!(role && role.role)) return null;
      const built = withScope(
        (c) => role.name
          ? `${c}.get_by_role(${pyStr(role.role)}, name=${pyStr(role.name)})`
          : `${c}.get_by_role(${pyStr(role.role)})`,
        meta.roleCount || 0
      );
      return { ...built, tier: 1, fallback: false };
    };
    const byLabel = () =>
      sel.label ? { ...withScope((c) => `${c}.get_by_label(${pyStr(sel.label)})`, meta.labelCount || 0), tier: 1, fallback: false } : null;
    const byPlaceholder = () =>
      sel.placeholder ? { ...withScope((c) => `${c}.get_by_placeholder(${pyStr(sel.placeholder)})`, meta.placeholderCount || 0), tier: 1, fallback: false } : null;
    const byText = () =>
      sel.text ? { ...withScope((c) => `${c}.get_by_text(${pyStr(sel.text)})`, meta.textCount || 0), tier: 1, fallback: false } : null;
    const byAlt = () =>
      sel.alt ? { ...withScope((c) => `${c}.get_by_alt_text(${pyStr(sel.alt)})`, meta.altCount || 0), tier: 1, fallback: false } : null;
    const byTitle = () =>
      sel.title ? { ...withScope((c) => `${c}.get_by_title(${pyStr(sel.title)})`, meta.titleCount || 0), tier: 1, fallback: false } : null;
    const byTestId = () =>
      sel.testId ? { ...withScope((c) => `${c}.get_by_test_id(${pyStr(sel.testId)})`, meta.testIdCount || 0), tier: 2, fallback: true } : null;
    const byCss = () => (css && css.value) ? { expr: `${chain}.locator(${pyStr(css.value)})`, scoped: false, tier: 3, fallback: true } : null;
    const byXpath = () => (xpath && xpath.value)
      ? { expr: `${chain}.locator(${pyStr(`xpath=${xpath.value}`)})`, scoped: false, tier: 3, fallback: strategy !== 'xpath' }
      : null;

    // Playwright locator priority:
    // 1) role 2) label 3) placeholder 4) text 5) alt 6) title 7) test id 8) css/xpath
    // Strategy button only changes first preference for newly recorded steps.
    const semanticDefault = [byRole, byLabel, byPlaceholder, byText, byAlt, byTitle, byTestId, byCss, byXpath];
    const orderMap = {
      role: [byRole, ...semanticDefault],
      label: [byLabel, ...semanticDefault],
      placeholder: [byPlaceholder, ...semanticDefault],
      text: [byText, ...semanticDefault],
      alt_text: [byAlt, ...semanticDefault],
      title: [byTitle, ...semanticDefault],
      test_id: [byTestId, ...semanticDefault],
      css: [byCss, ...semanticDefault],
      xpath: [byXpath, ...semanticDefault],
    };
    let order = orderMap[strategy] || semanticDefault;
    // de-duplicate while preserving order
    order = order.filter((fn, i) => order.indexOf(fn) === i);
    for (const fn of order) {
      const r = fn();
      if (r) {
        const notes = [];
        if (r.fallback && r.tier === 2) notes.push('Tier 2 fallback: semantic locator unavailable');
        if (r.fallback && r.tier === 3) notes.push('Tier 3 fallback: CSS used as last resort');
        if (r.scoped) notes.push('Scoped from stable parent due to duplicates');
        return { expr: r.expr, tier: r.tier, comment: notes.join('; ') };
      }
    }
    return { expr: `${chain}.locator("body")`, tier: 3, comment: 'Tier 3 fallback: no semantic handle found' };
  }

  function waitLine(v, step, opts) {
    const style = step.waitStyle || opts.wait;
    if (!style || style === 'none') return null;
    const state = step.waitState || opts.state;
    if (!state) return null;
    const t = step.timeout || opts.timeout;            // undefined => no timeout arg
    const targ = t ? `timeout=${t}` : '';
    // wait_for has no native "enabled" state -> use expect(...).to_be_enabled
    if (state === 'enabled') return `    expect(${v}).to_be_enabled(${targ})`;
    return `    ${v}.wait_for(state=${pyStr(state)}${t ? `, timeout=${t}` : ''})`;
  }

  function generatePlaywright(steps, opts) {
    const actionSteps = steps.filter(s => !!s.verb);

    // pass 1: assign which page each step belongs to (popups switch the page)
    let pageVar = 'page', popupCount = 0;
    actionSteps.forEach(s => {
      s.__page = pageVar;
      if (s.opensPopup) { popupCount++; s.__popup = `page${popupCount}`; pageVar = s.__popup; }
    });

    // pass 2: build locator defs (deduped by expression) + the flow
    const used = new Set();
    const byExpr = new Map();
    const locDefs = [];
    const flow = [];
    const snap = [];

    actionSteps.forEach(step => {
      const loc = locExpr(step, step.selStrategy || opts.sel, step.__page);
      const expr = loc.expr;
      step.__expr = expr;
      step.__locMeta = loc;
      if (byExpr.has(expr)) { step.__var = byExpr.get(expr); }
      else {
        const name = locVarName(step, used);
        byExpr.set(expr, name); step.__var = name;
        locDefs.push(`${name} = ${expr}`);
      }
    });

    actionSteps.forEach(step => {
      const v = step.__var;
      const w = waitLine(v, step, opts);
      if (w) flow.push(w);
      let act;
      switch (step.verb) {
        case 'click':                  act = `${v}.click()`; break;
        case 'fill': case 'fill_rich': act = `${v}.fill(${pyStr(step.value)})`; break;
        case 'check':                  act = `${v}.check()`; break;
        case 'uncheck':                act = `${v}.uncheck()`; break;
        case 'select':                 act = `${v}.select_option(${pyStr(step.value)})`; break;
        case 'detect':                 act = `${v}.is_visible()`; break;
        case 'is_visible':             act = `${v}.is_visible(state="visible", timeout=10000)`; break;
        case 'pick':                   act = `${v}`; break;
        default:                       act = `${v}.click()`;
      }
      if (step.opensPopup) {
        flow.push(`    with ${step.__page}.expect_popup() as popup_info:`);
        flow.push(`        ${act}`);
        flow.push(`    ${step.__popup} = popup_info.value`);
      } else {
        flow.push(`    ${act}`);
      }

      // Compact "Code Snap" style (locator + action on one line).
      if (step.__locMeta && step.__locMeta.comment) {
        snap.push(`# ${step.__locMeta.comment}`);
      }
      switch (step.verb) {
        case 'click':
          snap.push(`${v} = ${step.__expr}.click()`);
          break;
        case 'fill':
        case 'fill_rich':
          snap.push(`${v} = ${step.__expr}.fill(${pyStr(step.value)})`);
          break;
        case 'check':
          snap.push(`${v} = ${step.__expr}.check()`);
          break;
        case 'uncheck':
          snap.push(`${v} = ${step.__expr}.uncheck()`);
          break;
        case 'select':
          snap.push(`${v} = ${step.__expr}.select_option(${pyStr(step.value)})`);
          break;
        case 'detect':
          snap.push(`${v} = ${step.__expr}.is_visible()`);
          break;
        case 'is_visible':
          snap.push(`${v} = ${step.__expr}.is_visible(state="visible", timeout=10000)`);
          break;
        case 'pick':
          snap.push(`${v} = ${step.__expr}`);
          break;
        default:
          snap.push(`${v} = ${step.__expr}.click()`);
      }
    });

    const code = [
      'from playwright.sync_api import Page, expect',
      '', '',
      'def test(page: Page):',
      ...(flow.length ? flow : ['    pass']),
    ].join('\n');

    return {
      locators: locDefs.join('\n') || '# no locators yet',
      code,
      snap: snap.join('\n')
    };
  }

  function highlight(code) {
    return code
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/(#[^\n]*)/g, '<span class="cm">$1</span>')
      .replace(/\b(from|import|class|def|self|return|True|None|False|with|as)\b/g, '<span class="kw">$1</span>')
      .replace(/\b(BaseState|expect|Page)\b/g, '<span class="cls">$1</span>')
      .replace(/("[^"]*?")/g, '<span class="str">$1</span>');
  }

  global.PWCodegen = { generate, generatePlaywright, highlight };
})(window);
