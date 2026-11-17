// codegen.js — Playwright code generation
//  - generate():           BaseState-style Python POM class (unchanged API)
//  - generatePlaywright(): main "Code Snap" in 6 languages + detect / is_visible / pick snaps
//  - highlight():          tiny tokenizer-based syntax highlighter
(function (global) {

  // ---------- string helpers ----------
  function pyStr(s) {
    if (s == null) s = '';
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
  }
  const dqStr = pyStr; // Java / C# use the same escaping for regular strings
  function jsStr(s) {
    if (s == null) s = '';
    return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
  }

  function snake(s) {
    return (s || 'element')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/__+/g, '_')
      .toLowerCase() || 'element';
  }

  // Valid ARIA roles accepted by Playwright's get_by_role (and the Java/C# AriaRole enum).
  const ARIA_ROLES = new Set(('alert alertdialog application article banner blockquote button caption cell checkbox ' +
    'code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis ' +
    'feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main mark ' +
    'marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph ' +
    'presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator ' +
    'slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time ' +
    'timer toolbar tooltip tree treegrid treeitem').split(' '));

  function xpathSelectorString(value) {
    // Playwright only auto-detects XPath that starts with "//" or "..".
    // Absolute paths like "/html[1]/body[1]" need the explicit "xpath=" engine prefix.
    return /^\(*\/\//.test(value) || value.startsWith('..') ? value : `xpath=${value}`;
  }

  // =====================================================================
  // BaseState POM generator (kept for compatibility)
  // =====================================================================
  function locatorChain(step, strategy) {
    const sel = step.selector || {};
    const role = sel.role, css = sel.css;
    let chain = 'self.app.page';
    if (step.framePath && step.framePath.length) {
      for (const fs of step.framePath) chain += `.frame_locator(${pyStr(fs)})`;
    }
    const useRole = (strategy === 'role') || (strategy === 'auto' && role && role.role);
    if (useRole && role && role.role && ARIA_ROLES.has(role.role)) {
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
    if (!style || style === 'none') return [];
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
    return [`${pad}${loc}.wait_for(state=${pyStr(state || 'visible')}, timeout=${t})`];
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
      case 'press': return [`${pad}${loc}.press(${pyStr(step.value)})`];
      default: return [`${pad}${loc}.click()`];
    }
  }

  function methodName(step) {
    const base = (step.selector && step.selector.role && step.selector.role.name)
      || (step.selector && step.selector.text) || step.tag || 'element';
    const vm = { click: 'click', fill: 'fill', fill_rich: 'fill', check: 'check', uncheck: 'uncheck', select: 'select', press: 'press' };
    return `${vm[step.verb] || 'do'}_${snake(base)}`;
  }

  function retLine(step) {
    const r = step.returnVal || 'true_none';
    if (r === 'true_none') return '        return True, None';
    if (r === 'true_state') return `        return True, ${pyStr(step.returnState || 'next_state')}`;
    if (r === 'none') return null;
    return '        return True, None';
  }

  const POM_VERBS = new Set(['click', 'fill', 'fill_rich', 'check', 'uncheck', 'select', 'press']);

  function generate(steps, opts) {
    const cls = opts.className || 'GeneratedState';
    const detectStep = steps.find(s => s.isDetect || s.verb === 'detect');
    const actionSteps = steps.filter(s => !s.isDetect && POM_VERBS.has(s.verb));
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
    const names = new Map();
    const uniq = (step) => {
      const base = methodName(step);
      const n = (names.get(base) || 0) + 1;
      names.set(base, n);
      return n === 1 ? base : `${base}_${n}`;
    };
    const methods = actionSteps.map(uniq);
    methods.forEach((m) => L.push(`            ${pyStr(m)}: self.${m},`));
    L.push('        }');
    L.push('');

    L.push('    def detect_state(self):');
    if (detectStep) {
      L.push(`        return ${locatorChain(detectStep, opts.sel || detectStep.selStrategy)}.is_visible()`);
    } else {
      L.push('        # TODO: mark a step as detect_state in the recorder');
      L.push('        return False');
    }
    L.push('');

    actionSteps.forEach((step, i) => {
      const loc = locatorChain(step, opts.sel || step.selStrategy);
      const m = methods[i];
      const arg = step.verb === 'fill' || step.verb === 'fill_rich' ? ', message' : '';
      L.push(`    def ${m}(self${arg}):`);
      if (step.framePath && step.framePath.length) L.push(`        # iframe depth ${step.framePath.length}`);
      for (const w of waitLines(loc, step, opts, 8)) L.push(w);
      let acts = actionLines(loc, step, 8);
      if (arg) acts = acts.map(a => a.replace(/\.fill\(".*?"\)$/, '.fill(message)'));
      for (const a of acts) L.push(a);
      const r = retLine(step);
      if (r) L.push(r);
      L.push('');
    });

    if (!steps.length) L.push('    # no steps recorded yet');
    return L.join('\n');
  }

  // =====================================================================
  // Language-neutral locator model
  // =====================================================================
  // A locator is { parts: [{k, ...}], tier, used } rendered per language later.
  // `used` = which strategy actually produced it (may differ from the selected one).
  const KIND_TO_STRATEGY = { role: 'role', label: 'label', placeholder: 'placeholder', text: 'text', alt: 'alt_text', title: 'title', testid: 'test_id' };
  function locParts(step, strategy) {
    const r = locPartsInner(step, strategy);
    const last = r.parts.filter((p) => p.k !== 'nth' && p.k !== 'frame').pop();
    let used = last ? KIND_TO_STRATEGY[last.k] : null;
    if (last && last.k === 'locator') {
      const sel = step.selector || {};
      const tidAttr = sel.testIdAttr;
      if (last.v.startsWith('xpath=') || /^\(*\/\//.test(last.v)) used = 'xpath';
      else if (sel.css && last.v === sel.css.value) used = 'css';
      else if (tidAttr && last.v.startsWith(`[${tidAttr}=`)) used = 'test_id';
      else used = 'css';
    }
    return { ...r, used };
  }

  const STRATEGY_REASON = {
    role: 'element has no ARIA role', label: 'element has no <label>/aria-label', placeholder: 'element has no placeholder',
    text: 'element has no short text', alt_text: 'element has no alt attribute', title: 'element has no title attribute',
    test_id: 'element has no test id attribute', css: 'no css', xpath: 'no xpath',
  };
  function fallbackNote(step, strategy, loc) {
    if (!strategy || !loc.used || loc.used === strategy) return '';
    const sel = step.selector || {};
    const has = {
      role: !!(sel.role && sel.role.role && ARIA_ROLES.has(sel.role.role)), label: !!sel.label, placeholder: !!sel.placeholder,
      text: !!sel.text, alt_text: !!sel.alt, title: !!sel.title, test_id: !!sel.testId, css: true, xpath: true,
    }[strategy];
    const why = has ? `"${strategy}" matches several elements` : STRATEGY_REASON[strategy];
    return `${why} → used ${loc.used}`;
  }

  function locPartsInner(step, strategy) {
    const sel = step.selector || {};
    const role = sel.role && sel.role.role && ARIA_ROLES.has(sel.role.role) ? sel.role : null;
    const css = sel.css, xpath = sel.xpath;
    const meta = sel.meta || {};
    const frames = (step.framePath || []).map((v) => ({ k: 'frame', v }));
    const isChoiceInput = !!(role && (role.role === 'checkbox' || role.role === 'radio'));
    const scope = (isChoiceInput && meta.formCss) ? [{ k: 'locator', v: meta.formCss }] : [];
    const semantic = (p) => ({ parts: [...frames, ...scope, p], tier: 1 });

    const byRole = () => role ? semantic({ k: 'role', role: role.role, name: role.name || null }) : null;
    const byLabel = () => sel.label ? semantic({ k: 'label', v: sel.label }) : null;
    const byPlaceholder = () => sel.placeholder ? semantic({ k: 'placeholder', v: sel.placeholder }) : null;
    const byText = () => sel.text ? semantic({ k: 'text', v: sel.text }) : null;
    const byAlt = () => sel.alt ? semantic({ k: 'alt', v: sel.alt }) : null;
    const byTitle = () => sel.title ? semantic({ k: 'title', v: sel.title }) : null;
    const byTestId = () => {
      if (!sel.testId) return null;
      const attr = sel.testIdAttr || 'data-testid';
      const p = attr === 'data-testid'
        ? { k: 'testid', v: sel.testId }
        : { k: 'locator', v: `[${attr}="${String(sel.testId).replace(/"/g, '\\"')}"]` };
      return { parts: [...frames, ...scope, p], tier: 2 };
    };
    // CSS anchored on an id / test id ("#result", "[data-qa=…]") is stable → tier 2
    const byCss = () => (css && css.value) ? { parts: [...frames, { k: 'locator', v: css.value }], tier: (!/:nth-of-type|>|\s/.test(css.value) && /[#[.]/.test(css.value)) ? 2 : 3 } : null;
    const byXpath = () => (xpath && xpath.value)
      ? { parts: [...frames, { k: 'locator', v: xpathSelectorString(xpath.value) }], tier: strategy === 'xpath' ? 1 : 3 }
      : null;

    // Playwright locator priority:
    // 1) role 2) label 3) placeholder 4) test id 5) text 6) alt 7) title 8) css/xpath
    // The strategy pill only changes the first preference.
    const semanticDefault = [byRole, byLabel, byPlaceholder, byTestId, byText, byAlt, byTitle, byCss, byXpath];
    const first = {
      role: byRole, label: byLabel, placeholder: byPlaceholder, text: byText, alt_text: byAlt,
      title: byTitle, test_id: byTestId, css: byCss, xpath: byXpath,
    }[strategy];
    const order = first ? [first, ...semanticDefault.filter((f) => f !== first)] : semanticDefault;
    const KEY = new Map([[byRole, 'role'], [byLabel, 'label'], [byPlaceholder, 'placeholder'], [byText, 'text'],
      [byAlt, 'alt_text'], [byTitle, 'title'], [byTestId, 'test_id'], [byCss, 'css'], [byXpath, 'xpath']]);
    const U = meta.uniq; // match counts measured on the page at record time (newer recordings)

    if (!U) { // older recordings: first available candidate
      for (const fn of order) { const r = fn(); if (r) return r; }
      return { parts: [...frames, { k: 'locator', v: 'body' }], tier: 3 };
    }

    // Structural CSS/XPath (e.g. "body > ul > li:nth-of-type(2)") is brittle: only use it when the
    // user picked that strategy, or when it is anchored on an id / test id.
    // stable = one segment built on an id, attribute or meaningful class ("div.ContentEditable__root"),
    // not a positional path ("main > div:nth-of-type(2) > span")
    const stableCss = !!(css && css.value && !/:nth-of-type|>|\s/.test(css.value) && /[#[.]/.test(css.value));
    const structural = (fn) => (fn === byCss && strategy !== 'css' && !stableCss) || (fn === byXpath && strategy !== 'xpath');
    // An "Assert text" locator must not be built from the text it asserts.
    // Fields you type into must not be located by their (changing) text either.
    const TEXT_UNSAFE = new Set(['assert_text', 'fill', 'fill_rich', 'press']);
    const usable = (fn) => !(TEXT_UNSAFE.has(step.verb) && fn === byText);

    // 1) first candidate that matches exactly one element (loose, then exact=True)
    let nthFallback = null;
    for (const fn of order) {
      if (structural(fn) || !usable(fn)) continue;
      const r = fn();
      const u = U[KEY.get(fn)];
      if (!r || !u) continue;
      const last = r.parts[r.parts.length - 1];
      if (u.n === 1 && u.i === 0) return r;
      if (u.en === 1 && u.ei === 0) {
        r.parts[r.parts.length - 1] = { ...last, exact: true };
        return r;
      }
      // 2) remember the first usable one for a positional fallback
      if (!nthFallback && u.n > 1 && u.i >= 0) {
        const unscoped = r.parts.filter((p) => !scope.includes(p)); // index was measured unscoped
        nthFallback = { parts: [...unscoped, { k: 'nth', v: u.i }], tier: Math.max(r.tier, 2) };
      }
    }
    if (nthFallback) return nthFallback;
    // 3) structural CSS / XPath that is unique, then anything at all
    for (const fn of order) {
      const r = structural(fn) ? fn() : null;
      const u = r && U[KEY.get(fn)];
      if (u && u.n === 1 && u.i === 0) return { ...r, tier: 3 };
    }
    for (const fn of order) { const r = fn(); if (r) return { ...r, tier: 3 }; }
    return { parts: [...frames, { k: 'locator', v: 'body' }], tier: 3 };
  }

  const PY_M = { frame: 'frame_locator', locator: 'locator', role: 'get_by_role', label: 'get_by_label', placeholder: 'get_by_placeholder', text: 'get_by_text', alt: 'get_by_alt_text', title: 'get_by_title', testid: 'get_by_test_id' };
  const JS_M = { frame: 'frameLocator', locator: 'locator', role: 'getByRole', label: 'getByLabel', placeholder: 'getByPlaceholder', text: 'getByText', alt: 'getByAltText', title: 'getByTitle', testid: 'getByTestId' };
  const CS_M = Object.fromEntries(Object.entries(JS_M).map(([k, v]) => [k, v[0].toUpperCase() + v.slice(1)]));

  // Java option class names for exact=True on the get_by_* helpers
  const JAVA_OPT = { label: 'GetByLabelOptions', placeholder: 'GetByPlaceholderOptions', text: 'GetByTextOptions', alt: 'GetByAltTextOptions', title: 'GetByTitleOptions' };

  function renderLoc(lang, root, parts) {
    let out = root;
    let recv = 'Page'; // Java options classes depend on the receiver type
    for (const p of parts) {
      const ex = !!p.exact;
      if (p.k === 'nth') {
        const first = p.v === 0;
        if (lang === 'py') out += first ? '.first' : `.nth(${p.v})`;
        else if (lang === 'cs') out += first ? '.First' : `.Nth(${p.v})`;
        else out += first ? '.first()' : `.nth(${p.v})`;
      } else if (lang === 'py') {
        if (p.k === 'role') out += `.${PY_M.role}(${pyStr(p.role)}${p.name ? `, name=${pyStr(p.name)}` : ''}${ex ? ', exact=True' : ''})`;
        else out += `.${PY_M[p.k]}(${pyStr(p.v)}${ex ? ', exact=True' : ''})`;
      } else if (lang === 'js') {
        if (p.k === 'role') out += `.${JS_M.role}(${jsStr(p.role)}${p.name ? `, { name: ${jsStr(p.name)}${ex ? ', exact: true' : ''} }` : ''})`;
        else out += `.${JS_M[p.k]}(${jsStr(p.v)}${ex ? ', { exact: true }' : ''})`;
      } else if (lang === 'java') {
        if (p.k === 'role') {
          out += `.getByRole(AriaRole.${p.role.toUpperCase()}${p.name ? `, new ${recv}.GetByRoleOptions().setName(${dqStr(p.name)})${ex ? '.setExact(true)' : ''}` : ''})`;
        } else out += `.${JS_M[p.k]}(${dqStr(p.v)}${ex && JAVA_OPT[p.k] ? `, new ${recv}.${JAVA_OPT[p.k]}().setExact(true)` : ''})`;
      } else if (lang === 'cs') {
        if (p.k === 'role') {
          const r = p.role[0].toUpperCase() + p.role.slice(1);
          out += `.GetByRole(AriaRole.${r}${p.name ? `, new() { Name = ${dqStr(p.name)}${ex ? ', Exact = true' : ''} }` : ''})`;
        } else out += `.${CS_M[p.k]}(${dqStr(p.v)}${ex ? ', new() { Exact = true }' : ''})`;
      }
      recv = p.k === 'frame' ? 'FrameLocator' : 'Locator';
    }
    return out;
  }

  // =====================================================================
  // Multi-language "Code Snap"
  // =====================================================================
  const LANGS = {
    'python-pytest':      { family: 'py',   file: 'test_example.py',     label: 'Playwright · Python Pytest', indent: 4, root: 'page', aw: '' },
    'python':             { family: 'py',   file: 'example.py',          label: 'Playwright · Python Library', indent: 4, root: 'page', aw: '' },
    'python-async':       { family: 'py',   file: 'example_async.py',    label: 'Playwright · Python Async', indent: 4, root: 'page', aw: 'await ' },
    'playwright-test-ts': { family: 'js',   file: 'example.spec.ts',     label: 'Playwright Test · TypeScript', indent: 2, root: 'page' },
    'playwright-test-js': { family: 'js',   file: 'example.spec.js',     label: 'Playwright Test · JavaScript', indent: 2, root: 'page' },
    'javascript':         { family: 'js',   file: 'example.js',          label: 'Playwright · JavaScript Library', indent: 2, root: 'page' },
    'java-junit':         { family: 'java', file: 'TestExample.java',    label: 'Playwright · Java JUnit 5', indent: 4, root: 'page' },
    'java':               { family: 'java', file: 'Example.java',        label: 'Playwright · Java Library', indent: 6, root: 'page' },
    'csharp':             { family: 'cs',   file: 'Tests.cs',            label: 'Playwright · C# NUnit', indent: 8, root: 'Page' },
    'selenium-python':    { family: 'sepy', file: 'test_selenium.py',    label: 'Selenium · Python', indent: 4, root: 'page' },
    'selenium-java':      { family: 'sejava', file: 'SeleniumTest.java', label: 'Selenium · Java JUnit 5', indent: 4, root: 'page' },
  };
  const LANG_ALIASES = { 'playwright-test': 'playwright-test-ts' }; // settings saved by older versions

  function valueList(lang, v) {
    const arr = Array.isArray(v) ? v : null;
    const q = lang === 'js' ? jsStr : dqStr;
    if (!arr) return q(v);
    if (lang === 'py') return `[${arr.map(pyStr).join(', ')}]`;
    if (lang === 'js') return `[${arr.map(jsStr).join(', ')}]`;
    if (lang === 'java') return `new String[] {${arr.map(dqStr).join(', ')}}`;
    return `new[] { ${arr.map(dqStr).join(', ')} }`;
  }

  // Returns the statement (without indentation / popup wrapping) for one step.
  function statement(cfg, step, L, P) {
    const f = cfg.family, aw = cfg.aw || '';
    const v = step.value;
    const call = (py, js, java, cs) => {
      if (f === 'py') return `${aw}${py}`;
      if (f === 'js') return `await ${js};`;
      if (f === 'java') return `${java};`;
      return `await ${cs};`;
    };
    const q = f === 'js' ? jsStr : dqStr;
    switch (step.verb) {
      case 'goto':
        return call(`${P}.goto(${pyStr(step.url)})`, `${P}.goto(${jsStr(step.url)})`, `${P}.navigate(${dqStr(step.url)})`, `${P}.GotoAsync(${dqStr(step.url)})`);
      case 'fill': case 'fill_rich':
        return call(`${L}.fill(${pyStr(v)})`, `${L}.fill(${jsStr(v)})`, `${L}.fill(${dqStr(v)})`, `${L}.FillAsync(${dqStr(v)})`);
      case 'check':
        return call(`${L}.check()`, `${L}.check()`, `${L}.check()`, `${L}.CheckAsync()`);
      case 'uncheck':
        return call(`${L}.uncheck()`, `${L}.uncheck()`, `${L}.uncheck()`, `${L}.UncheckAsync()`);
      case 'select':
        return call(`${L}.select_option(${valueList('py', v)})`, `${L}.selectOption(${valueList('js', v)})`, `${L}.selectOption(${valueList('java', v)})`, `${L}.SelectOptionAsync(${valueList('cs', v)})`);
      case 'press':
        return call(`${L}.press(${pyStr(v)})`, `${L}.press(${jsStr(v)})`, `${L}.press(${dqStr(v)})`, `${L}.PressAsync(${dqStr(v)})`);
      case 'assert_text':
        return call(`expect(${L}).to_contain_text(${pyStr(v)})`, `expect(${L}).toContainText(${q(v)})`, `assertThat(${L}).containsText(${dqStr(v)})`, `Expect(${L}).ToContainTextAsync(${dqStr(v)})`);
      case 'assert_value':
        return call(`expect(${L}).to_have_value(${pyStr(v)})`, `expect(${L}).toHaveValue(${q(v)})`, `assertThat(${L}).hasValue(${dqStr(v)})`, `Expect(${L}).ToHaveValueAsync(${dqStr(v)})`);
      case 'assert_checked':
        return v
          ? call(`expect(${L}).to_be_checked()`, `expect(${L}).toBeChecked()`, `assertThat(${L}).isChecked()`, `Expect(${L}).ToBeCheckedAsync()`)
          : call(`expect(${L}).not_to_be_checked()`, `expect(${L}).not.toBeChecked()`, `assertThat(${L}).not().isChecked()`, `Expect(${L}).Not.ToBeCheckedAsync()`);
      case 'assert_visible':
        return call(`expect(${L}).to_be_visible()`, `expect(${L}).toBeVisible()`, `assertThat(${L}).isVisible()`, `Expect(${L}).ToBeVisibleAsync()`);
      case 'click': default: {
        // modifiers (Ctrl/Cmd, Shift, Alt) and middle button — e.g. "open in new tab"
        const mods = step.modifiers || [];
        const mid = step.button === 'middle';
        if (!mods.length && !mid) return call(`${L}.click()`, `${L}.click()`, `${L}.click()`, `${L}.ClickAsync()`);
        const up = (m) => m.toUpperCase();
        const py = [mid ? 'button="middle"' : '', mods.length ? `modifiers=[${mods.map(pyStr).join(', ')}]` : ''].filter(Boolean).join(', ');
        const js = [mid ? "button: 'middle'" : '', mods.length ? `modifiers: [${mods.map(jsStr).join(', ')}]` : ''].filter(Boolean).join(', ');
        const java = `new Locator.ClickOptions()${mid ? '.setButton(MouseButton.MIDDLE)' : ''}${mods.length ? `.setModifiers(Arrays.asList(${mods.map((m) => `KeyboardModifier.${up(m)}`).join(', ')}))` : ''}`;
        const cs = [mid ? 'Button = MouseButton.Middle' : '', mods.length ? `Modifiers = new[] { ${mods.map((m) => `KeyboardModifier.${m}`).join(', ')} }` : ''].filter(Boolean).join(', ');
        return call(`${L}.click(${py})`, `${L}.click({ ${js} })`, `${L}.click(${java})`, `${L}.ClickAsync(new() { ${cs} })`);
      }
    }
  }

  // New tab / popup window opened by `stmt`; waits until it has fully loaded.
  // byContext: tabs opened with Ctrl/Shift/middle click have no opener, so Playwright's
  // "popup" event doesn't fire — wait for the context's "page" event instead.
  function popupLines(cfg, P, NEW, stmt, pad, byContext) {
    const one = ' '.repeat(cfg.family === 'py' ? 4 : cfg.indent > 4 ? 4 : 2);
    switch (cfg.family) {
      case 'py': {
        const waiter = byContext ? `${P}.context.expect_page()` : `${P}.expect_popup()`;
        if (cfg.aw) return [`${pad}async with ${waiter} as ${NEW}_info:`, `${pad}${one}${stmt}`, `${pad}${NEW} = await ${NEW}_info.value`, `${pad}await ${NEW}.wait_for_load_state()`];
        return [`${pad}with ${waiter} as ${NEW}_info:`, `${pad}${one}${stmt}`, `${pad}${NEW} = ${NEW}_info.value`, `${pad}${NEW}.wait_for_load_state()`];
      }
      case 'js': {
        const waiter = byContext ? `${P}.context().waitForEvent('page')` : `${P}.waitForEvent('popup')`;
        return [`${pad}const ${NEW}Promise = ${waiter};`, `${pad}${stmt}`, `${pad}const ${NEW} = await ${NEW}Promise;`, `${pad}await ${NEW}.waitForLoadState();`];
      }
      case 'java': {
        const waiter = byContext ? `${P}.context().waitForPage` : `${P}.waitForPopup`;
        return [`${pad}Page ${NEW} = ${waiter}(() -> {`, `${pad}  ${stmt}`, `${pad}});`, `${pad}${NEW}.waitForLoadState();`];
      }
      default: {
        const waiter = byContext ? `${P}.Context.RunAndWaitForPageAsync` : `${P}.RunAndWaitForPopupAsync`;
        return [`${pad}var ${NEW} = await ${waiter}(async () =>`, `${pad}{`, `${pad}    ${stmt}`, `${pad}});`, `${pad}await ${NEW}.WaitForLoadStateAsync();`];
      }
    }
  }

  // A tab the user switched to that wasn't opened by a recorded page.
  function newPageLine(cfg, root, NEW) {
    switch (cfg.family) {
      case 'py': return cfg.aw ? `${NEW} = await ${root}.context.new_page()` : `${NEW} = ${root}.context.new_page()`;
      case 'js': return `const ${NEW} = await ${root}.context().newPage();`;
      case 'java': return `Page ${NEW} = ${root}.context().newPage();`;
      default: return `var ${NEW} = await ${root}.Context.NewPageAsync();`;
    }
  }

  // Switching back to another tab (e.g. after a "Sign in with Google" popup closed itself):
  // bring it to the front first — focus-sensitive apps (rich-text editors, keyboard shortcuts)
  // ignore input while their tab is in the background.
  function bringToFrontLine(cfg, P) {
    switch (cfg.family) {
      case 'py': return `${cfg.aw || ''}${P}.bring_to_front()`;
      case 'js': return `await ${P}.bringToFront();`;
      case 'java': return `${P}.bringToFront();`;
      default: return `await ${P}.BringToFrontAsync();`;
    }
  }

  const SNAP_SKIP = new Set(['detect', 'is_visible', 'pick']);

  function bodyLines(steps, opts, cfg) {
    const pad = ' '.repeat(cfg.indent);
    const out = [];
    const pageVar = (alias) => (!alias || alias === 'page' ? cfg.root : alias);
    let legacyP = cfg.root, legacyPopups = 0; // steps recorded by versions without page aliases
    let front = cfg.root; // the page currently in front
    for (const step of steps) {
      if (!step.verb || step.isDetect || SNAP_SKIP.has(step.verb)) continue;
      const P = step.page ? pageVar(step.page) : legacyP;
      if (step.verb === 'new_page') { out.push(pad + newPageLine(cfg, cfg.root, pageVar(step.page))); front = pageVar(step.page); continue; }
      if (P !== front) { out.push(pad + bringToFrontLine(cfg, P)); front = P; }
      const loc = step.verb === 'goto' ? null : locParts(step, opts.sel || step.selStrategy);
      const L = loc ? renderLoc(cfg.family, P, loc.parts) : null;
      const cm = cfg.family === 'py' ? '#' : '//';
      if (loc && opts.comments !== false) {
        const note = fallbackNote(step, opts.sel, loc);
        if (note) out.push(`${pad}${cm} ${note}`);
        else if (loc.tier === 3 && loc.used !== opts.sel) out.push(`${pad}${cm} fallback locator: no unique semantic locator found`);
      }
      const stmt = statement(cfg, step, L, P);
      if (step.opensPopup) {
        const NEW = step.popupAlias || `page${++legacyPopups}`;
        const byContext = !!((step.modifiers && step.modifiers.length) || step.button === 'middle');
        out.push(...popupLines(cfg, P, NEW, stmt, pad, byContext));
        if (!step.page) legacyP = NEW;
        // a normal popup opens in front; a Ctrl/middle-click tab opens in the background
        if (!byContext) front = NEW;
      } else {
        out.push(pad + stmt);
      }
    }
    return out;
  }

  function wrap(lang, body) {
    const empty = (b, fallback) => (b.length ? b : [fallback]);
    switch (lang) {
      case 'python':
        return [
          'import re',
          'from playwright.sync_api import Playwright, sync_playwright, expect',
          '', '',
          'def run(playwright: Playwright) -> None:',
          '    browser = playwright.chromium.launch(headless=False)',
          '    context = browser.new_context()',
          '    page = context.new_page()',
          ...body,
          '',
          '    # ---------------------',
          '    context.close()',
          '    browser.close()',
          '', '',
          'with sync_playwright() as playwright:',
          '    run(playwright)',
        ];
      case 'python-async':
        return [
          'import asyncio',
          'import re',
          'from playwright.async_api import Playwright, async_playwright, expect',
          '', '',
          'async def run(playwright: Playwright) -> None:',
          '    browser = await playwright.chromium.launch(headless=False)',
          '    context = await browser.new_context()',
          '    page = await context.new_page()',
          ...body,
          '',
          '    # ---------------------',
          '    await context.close()',
          '    await browser.close()',
          '', '',
          'async def main() -> None:',
          '    async with async_playwright() as playwright:',
          '        await run(playwright)',
          '', '',
          'asyncio.run(main())',
        ];
      case 'playwright-test-ts':
        return [
          "import { test, expect } from '@playwright/test';",
          '',
          "test('test', async ({ page }) => {",
          ...body,
          '});',
        ];
      case 'playwright-test-js':
        return [
          '// @ts-check',
          "const { test, expect } = require('@playwright/test');",
          '',
          "test('test', async ({ page }) => {",
          ...body,
          '});',
        ];
      case 'javascript':
        return [
          "const { chromium } = require('playwright');",
          "const { expect } = require('@playwright/test');",
          '',
          '(async () => {',
          '  const browser = await chromium.launch({ headless: false });',
          '  const context = await browser.newContext();',
          '  const page = await context.newPage();',
          ...body,
          '',
          '  // ---------------------',
          '  await context.close();',
          '  await browser.close();',
          '})();',
        ];
      case 'java-junit':
        return [
          'import com.microsoft.playwright.junit.UsePlaywright;',
          'import com.microsoft.playwright.*;',
          'import com.microsoft.playwright.options.*;',
          'import org.junit.jupiter.api.*;',
          '',
          'import java.util.*;',
          '',
          'import static com.microsoft.playwright.assertions.PlaywrightAssertions.*;',
          '',
          '@UsePlaywright',
          'public class TestExample {',
          '  @Test',
          '  void test(Page page) {',
          ...body,
          '  }',
          '}',
        ];
      case 'java':
        return [
          'import com.microsoft.playwright.*;',
          'import com.microsoft.playwright.options.*;',
          'import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;',
          'import java.util.*;',
          '',
          'public class Example {',
          '  public static void main(String[] args) {',
          '    try (Playwright playwright = Playwright.create()) {',
          '      Browser browser = playwright.chromium().launch(new BrowserType.LaunchOptions()',
          '        .setHeadless(false));',
          '      BrowserContext context = browser.newContext();',
          '      Page page = context.newPage();',
          ...body,
          '    }',
          '  }',
          '}',
        ];
      case 'csharp':
        return [
          'using System.Text.RegularExpressions;',
          'using Microsoft.Playwright;',
          'using Microsoft.Playwright.NUnit;',
          'using NUnit.Framework;',
          '',
          '[Parallelizable(ParallelScope.Self)]',
          '[TestFixture]',
          'public class Tests : PageTest',
          '{',
          '    [Test]',
          '    public async Task MyTest()',
          '    {',
          ...body,
          '    }',
          '}',
        ];
      case 'python-pytest':
      default:
        return [
          'import re',
          'from playwright.sync_api import Page, expect',
          '', '',
          'def test_example(page: Page) -> None:',
          ...empty(body, '    pass'),
        ];
    }
  }

  // =====================================================================
  // Selenium (Python + Java/JUnit 5)
  // =====================================================================
  const SE_ORDER = ['id', 'test_id', 'name', 'role', 'label', 'placeholder', 'text', 'alt_text', 'title', 'css', 'xpath'];
  const PY_BY = { id: 'By.ID', name: 'By.NAME', css: 'By.CSS_SELECTOR', xpath: 'By.XPATH' };
  const JAVA_BY = { id: 'By.id', name: 'By.name', css: 'By.cssSelector', xpath: 'By.xpath' };
  const SE_KEYS = {
    sepy: { Enter: 'Keys.ENTER', Tab: 'Keys.TAB', 'Shift+Tab': 'Keys.SHIFT + Keys.TAB', Escape: 'Keys.ESCAPE', Space: 'Keys.SPACE' },
    sejava: { Enter: 'Keys.ENTER', Tab: 'Keys.TAB', 'Shift+Tab': 'Keys.chord(Keys.SHIFT, Keys.TAB)', Escape: 'Keys.ESCAPE', Space: 'Keys.SPACE' },
  };

  // Selenium locator: first candidate (selected strategy first) that matched exactly one
  // element while recording; otherwise the first that contains the element, with an index.
  function seLocator(step, strategy) {
    const S = (step.selector && step.selector.selenium) || null;
    const c = (S && S.cands) || {};
    const order = [strategy, ...SE_ORDER.filter((k) => k !== strategy)];
    for (const k of order) { const x = c[k]; if (x && x.n === 1 && x.i === 0) return { ...x, index: 0, used: k }; }
    for (const k of order) { const x = c[k]; if (x && x.i >= 0) return { ...x, index: x.i, used: k }; }
    const sel = step.selector || {};
    if (sel.css && sel.css.value) return { by: 'css', v: sel.css.value, index: 0, used: 'css' };
    if (sel.xpath && sel.xpath.value) return { by: 'xpath', v: sel.xpath.value, index: 0, used: 'xpath' };
    return { by: 'css', v: 'body', index: 0, used: 'css' };
  }

  function seEl(f, step, loc) {
    const frames = step.framePath || [];
    const shadow = (step.selector && step.selector.selenium && step.selector.selenium.shadow) || [];
    if (f === 'sepy') {
      let s = `el(${PY_BY[loc.by]}, ${pyStr(loc.v)}`;
      if (loc.index) s += `, index=${loc.index}`;
      if (frames.length) s += `, frames=[${frames.map(pyStr).join(', ')}]`;
      if (shadow.length) s += `, shadow=[${shadow.map(pyStr).join(', ')}]`;
      return s + ')';
    }
    const by = `${JAVA_BY[loc.by]}(${dqStr(loc.v)})`;
    if (!loc.index && !frames.length && !shadow.length) return `el(${by})`;
    const arr = (a) => (a.length ? `new String[] {${a.map(dqStr).join(', ')}}` : 'new String[0]');
    return `el(${by}, ${loc.index || 0}, ${arr(frames)}, ${arr(shadow)})`;
  }

  function seStatements(f, step, E) {
    const py = f === 'sepy';
    const q = py ? pyStr : dqStr;
    const end = py ? '' : ';';
    const v = step.value;
    const key = (k) => SE_KEYS[f][k] || q(k);
    switch (step.verb) {
      case 'goto': return [`driver.get(${q(step.url)})${end}`];
      case 'fill': case 'fill_rich': return [py ? `type_into(${E}, ${q(v)})` : `typeInto(${E}, ${q(v)});`];
      case 'check': return [py ? `set_checked(${E}, True)` : `setChecked(${E}, true);`];
      case 'uncheck': return [py ? `set_checked(${E}, False)` : `setChecked(${E}, false);`];
      case 'select': {
        const vals = Array.isArray(v) ? v : [v];
        return vals.map((x) => (py ? `Select(${E}).select_by_value(${q(x)})` : `new Select(${E}).selectByValue(${q(x)});`));
      }
      case 'press': return [`${E}.${py ? 'send_keys' : 'sendKeys'}(${key(v)})${end}`];
      case 'assert_text': return [py ? `wait.until(lambda d: ${q(v)} in ${E}.text)` : `wait.until(d -> ${E}.getText().contains(${q(v)}));`];
      case 'assert_value': return [py ? `wait.until(lambda d: ${E}.get_property("value") == ${q(v)})` : `wait.until(d -> ${q(v)}.equals(${E}.getDomProperty("value")));`];
      case 'assert_checked': return [py ? `wait.until(lambda d: ${E}.is_selected() == ${v ? 'True' : 'False'})` : `wait.until(d -> ${E}.isSelected() == ${v ? 'true' : 'false'});`];
      case 'assert_visible': return [py ? `assert ${E}.is_displayed()` : `assertTrue(${E}.isDisplayed());`];
      case 'click': default: {
        // Ctrl/Shift(+middle) click = open in new tab / window: hold the key while clicking
        const mods = (step.modifiers || []).slice();
        if (step.button === 'middle' && !mods.length) mods.push('ControlOrMeta');
        if (!mods.length) return [`${E}.click()${end}`];
        // MOD = Cmd on macOS, Ctrl elsewhere (defined at the top of the generated file)
        const K = { ControlOrMeta: 'MOD', Shift: 'Keys.SHIFT', Alt: 'Keys.ALT' };
        const keys = mods.map((m) => K[m] || 'MOD');
        if (py) return [`ActionChains(driver)${keys.map((k) => `.key_down(${k})`).join('')}.click(${E})${keys.map((k) => `.key_up(${k})`).join('')}.perform()`];
        return [`new Actions(driver)${keys.map((k) => `.keyDown(${k})`).join('')}.click(${E})${keys.map((k) => `.keyUp(${k})`).join('')}.perform();`];
      }
    }
  }

  function seleniumBody(steps, opts, cfg) {
    const f = cfg.family, py = f === 'sepy';
    const pad = ' '.repeat(cfg.indent);
    const cm = py ? '#' : '//';
    const out = [];
    let cur = 'page';
    const switchTo = (alias) => {
      if (!alias || alias === cur) return;
      out.push(pad + (py ? `driver.switch_to.window(windows[${pyStr(alias)}])` : `driver.switchTo().window(windows.get(${dqStr(alias)}));`));
      cur = alias;
    };
    for (const step of steps) {
      if (!step.verb || step.isDetect || SNAP_SKIP.has(step.verb)) continue;
      if (step.verb === 'new_page') {
        out.push(pad + (py ? 'driver.switch_to.new_window("tab")' : 'driver.switchTo().newWindow(WindowType.TAB);'));
        out.push(pad + (py ? `windows[${pyStr(step.page)}] = driver.current_window_handle` : `windows.put(${dqStr(step.page)}, driver.getWindowHandle());`));
        cur = step.page;
        continue;
      }
      switchTo(step.page);
      let E = null;
      if (step.verb !== 'goto') {
        const loc = seLocator(step, opts.sel || step.selStrategy);
        if (opts.sel && loc.used !== opts.sel && opts.comments !== false) {
          out.push(`${pad}${cm} "${opts.sel}" is not available/unique for this element in Selenium → used ${loc.used}`);
        }
        E = seEl(f, step, loc);
      }
      const lines = seStatements(f, step, E);
      if (step.opensPopup && step.popupAlias) {
        const before = py ? 'before' : `before${step.popupAlias[0].toUpperCase()}${step.popupAlias.slice(1)}`;
        out.push(pad + (py ? 'before = driver.window_handles' : `Set<String> ${before} = driver.getWindowHandles();`));
        lines.forEach((l) => out.push(pad + l));
        out.push(pad + (py ? `windows[${pyStr(step.popupAlias)}] = new_window(before)` : `windows.put(${dqStr(step.popupAlias)}, newWindow(${before}));`));
        cur = step.popupAlias;
      } else {
        lines.forEach((l) => out.push(pad + l));
      }
    }
    return out;
  }

  function seleniumWrap(lang, body) {
    if (lang === 'selenium-java') {
      return [
        'import org.junit.jupiter.api.*;',
        'import org.openqa.selenium.*;',
        'import org.openqa.selenium.chrome.ChromeDriver;',
        'import org.openqa.selenium.interactions.Actions;',
        'import org.openqa.selenium.support.ui.Select;',
        'import org.openqa.selenium.support.ui.WebDriverWait;',
        '',
        'import java.time.Duration;',
        'import java.util.*;',
        '',
        'import static org.junit.jupiter.api.Assertions.*;',
        '',
        'public class SeleniumTest {',
        '  /** Cmd on macOS, Ctrl on Windows / Linux (for "open in new tab" clicks). */',
        '  static final Keys MOD = System.getProperty("os.name").toLowerCase().contains("mac") ? Keys.COMMAND : Keys.CONTROL;',
        '',
        '  WebDriver driver;',
        '  WebDriverWait wait;',
        '  Map<String, String> windows = new HashMap<>();',
        '',
        '  @BeforeEach',
        '  void setUp() {',
        '    driver = new ChromeDriver();',
        '    wait = new WebDriverWait(driver, Duration.ofSeconds(10));',
        '    // pages re-render and iframes reload while we wait: retry instead of failing',
        '    wait.ignoreAll(List.of(StaleElementReferenceException.class, NoSuchFrameException.class,',
        '        NoSuchShadowRootException.class, org.openqa.selenium.NoSuchElementException.class));',
        '    windows.put("page", driver.getWindowHandle());',
        '  }',
        '',
        '  @AfterEach',
        '  void tearDown() {',
        '    if (driver != null) {',
        '      driver.quit();',
        '    }',
        '  }',
        '',
        '  /** CSS search that also looks inside open shadow roots (for iframes inside web components). */',
        '  static final String DEEP_CSS = "const out = [], walk = (r) => { r.querySelectorAll(arguments[0]).forEach((e) => out.push(e)); "',
        '      + "r.querySelectorAll(\'*\').forEach((e) => e.shadowRoot && walk(e.shadowRoot)); }; walk(document); return out;";',
        '',
        '  /** Returns the element once visible; enters the iframe chain and open shadow roots first. */',
        '  @SuppressWarnings("unchecked")',
        '  WebElement el(By by, int index, String[] frames, String[] shadow) {',
        '    return wait.until(d -> {',
        '      d.switchTo().defaultContent();',
        '      for (String frame : frames) {',
        '        String[] p = frame.split(" >> nth=");',
        '        int n = p.length > 1 ? Integer.parseInt(p[1]) : 0;',
        '        List<WebElement> found = (List<WebElement>) ((JavascriptExecutor) d).executeScript(DEEP_CSS, p[0]);',
        '        if (found.size() <= n) return null;',
        '        d.switchTo().frame(found.get(n));',
        '      }',
        '      SearchContext root = d;',
        '      List<WebElement> found;',
        '      try {',
        '        for (String host : shadow) root = root.findElement(By.cssSelector(host)).getShadowRoot();',
        '        found = root.findElements(by);',
        '      } catch (org.openqa.selenium.NoSuchElementException e) {',
        '        found = List.of();',
        '      }',
        '      if (found.isEmpty() && shadow.length > 0 && by instanceof By.ByCssSelector) {',
        '        // the shadow hosts changed: search every open shadow root for the element',
        '        String css = by.toString().replaceFirst("^By\\\\.cssSelector: ", "");',
        '        found = (List<WebElement>) ((JavascriptExecutor) d).executeScript(DEEP_CSS, css);',
        '      }',
        '      return found.size() > index && found.get(index).isDisplayed() ? found.get(index) : null;',
        '    });',
        '  }',
        '',
        '  WebElement el(By by) {',
        '    return el(by, 0, new String[0], new String[0]);',
        '  }',
        '',
        '  void typeInto(WebElement e, String text) {',
        '    e.clear();',
        '    e.sendKeys(text);',
        '  }',
        '',
        '  void setChecked(WebElement e, boolean checked) {',
        '    if (e.isSelected() != checked) e.click();',
        '  }',
        '',
        '  /** Waits for a new tab / popup window, switches to it once loaded and returns its handle. */',
        '  String newWindow(Set<String> before) {',
        '    wait.until(d -> d.getWindowHandles().size() > before.size());',
        '    String handle = driver.getWindowHandles().stream().filter(h -> !before.contains(h)).findFirst().get();',
        '    driver.switchTo().window(handle);',
        '    wait.until(d -> "complete".equals(((JavascriptExecutor) d).executeScript("return document.readyState")));',
        '    return handle;',
        '  }',
        '',
        '  @Test',
        '  void test() {',
        ...body,
        '  }',
        '}',
      ];
    }
    return [
      'import sys',
      '',
      'from selenium import webdriver',
      'from selenium.common.exceptions import (NoSuchElementException, NoSuchFrameException,',
      '                                        NoSuchShadowRootException, StaleElementReferenceException)',
      'from selenium.webdriver.common.action_chains import ActionChains',
      'from selenium.webdriver.common.by import By',
      'from selenium.webdriver.common.keys import Keys',
      'from selenium.webdriver.support.ui import Select, WebDriverWait',
      '',
      'driver = webdriver.Chrome()',
      '# pages re-render and iframes reload while we wait: retry instead of failing',
      'wait = WebDriverWait(driver, 10, ignored_exceptions=(NoSuchElementException, StaleElementReferenceException,',
      '                                                     NoSuchFrameException, NoSuchShadowRootException))',
      'windows = {"page": driver.current_window_handle}',
      'MOD = Keys.COMMAND if sys.platform == "darwin" else Keys.CONTROL  # for "open in new tab" clicks',
      '',
      '# CSS search that also looks inside open shadow roots (for iframes inside web components)',
      'DEEP_CSS = ("const out = [], walk = (r) => { r.querySelectorAll(arguments[0]).forEach((e) => out.push(e)); "',
      '            "r.querySelectorAll(\'*\').forEach((e) => e.shadowRoot && walk(e.shadowRoot)); }; walk(document); return out;")',
      '',
      '',
      'def el(by, value, index=0, frames=(), shadow=()):',
      '    """Return the element once visible; enters the iframe chain and open shadow roots first."""',
      '    def find(d):',
      '        d.switch_to.default_content()',
      '        for frame in frames:',
      '            css, _, nth = frame.partition(" >> nth=")',
      '            found = d.execute_script(DEEP_CSS, css)',
      '            if len(found) <= int(nth or 0):',
      '                return False',
      '            d.switch_to.frame(found[int(nth or 0)])',
      '        root = d',
      '        try:',
      '            for host in shadow:',
      '                root = root.find_element(By.CSS_SELECTOR, host).shadow_root',
      '            found = root.find_elements(by, value)',
      '        except NoSuchElementException:',
      '            found = []',
      '        if not found and shadow and by == By.CSS_SELECTOR:',
      '            found = d.execute_script(DEEP_CSS, value)  # shadow hosts changed: search all open shadow roots',
      '        return found[index] if len(found) > index and found[index].is_displayed() else False',
      '    return wait.until(find)',
      '',
      '',
      'def type_into(element, text):',
      '    element.clear()',
      '    element.send_keys(text)',
      '',
      '',
      'def set_checked(element, checked):',
      '    if element.is_selected() != checked:',
      '        element.click()',
      '',
      '',
      'def new_window(before):',
      '    """Wait for a new tab / popup window, switch to it once loaded and return its handle."""',
      '    wait.until(lambda d: len(d.window_handles) > len(before))',
      '    handle = [h for h in driver.window_handles if h not in before][0]',
      '    driver.switch_to.window(handle)',
      '    wait.until(lambda d: d.execute_script("return document.readyState") == "complete")',
      '    return handle',
      '',
      '',
      'def test_example():',
      ...(body.length ? body : ['    pass']),
      '',
      '',
      'def teardown_module():',
      '    driver.quit()',
      '',
      '',
      'if __name__ == "__main__":',
      '    try:',
      '        test_example()',
      '    finally:',
      '        driver.quit()',
    ];
  }

  // ---------- detect_state / is_visible / pick snaps (Python, BaseState style) ----------
  function buildSpecialSnaps(steps, opts) {
    const detectSteps = steps.filter((s) => s.verb === 'detect' || s.isDetect);
    const isVisibleSteps = steps.filter((s) => s.verb === 'is_visible');
    const pickSteps = steps.filter((s) => s.verb === 'pick');
    const strategy = opts.sel || 'role';

    let detectSnap = '# no detect_state yet';
    if (detectSteps.length) {
      const lines = [];
      detectSteps.forEach((step, i) => {
        const loc = renderLoc('py', 'self.app.page', locParts(step, strategy || step.selStrategy).parts);
        lines.push(`def ${i === 0 ? 'detect_state' : `detect_state_${i + 1}`}(self):`);
        lines.push(`    return ${loc}.is_visible()`);
        lines.push('');
      });
      detectSnap = lines.join('\n').trim();
    }

    let isVisibleSnap = '# no is_visible yet';
    if (isVisibleSteps.length) {
      const lines = [];
      isVisibleSteps.forEach((step, i) => {
        const loc = renderLoc('py', 'self.app.page', locParts(step, strategy || step.selStrategy).parts);
        lines.push(`def ${i === 0 ? 'is_visible' : `is_visible_${i + 1}`}(self):`);
        lines.push(`    ${loc}.wait_for(state="visible", timeout=10000)`);
        lines.push('');
      });
      isVisibleSnap = lines.join('\n').trim();
    }

    const pickSnap = pickSteps.length
      ? pickSteps.map((s, i) => `# pick ${i + 1}\n${s.html || '<!-- empty element -->'}`).join('\n\n')
      : '<!-- no picked element yet -->';
    return { detectSnap, isVisibleSnap, pickSnap };
  }

  function generatePlaywright(steps, opts) {
    opts = opts || {};
    let lang = LANG_ALIASES[opts.lang] || opts.lang;
    if (!LANGS[lang]) lang = 'python-pytest';
    const cfg = LANGS[lang];
    const isSelenium = cfg.family === 'sepy' || cfg.family === 'sejava';
    const snap = (isSelenium
      ? seleniumWrap(lang, seleniumBody(steps, opts, cfg))
      : wrap(lang, bodyLines(steps, opts, cfg))).join('\n');

    // Python locator list (kept for compatibility with older callers)
    const seen = new Set();
    const locators = steps
      .filter((s) => s.verb && s.verb !== 'goto')
      .map((s) => renderLoc('py', 'page', locParts(s, opts.sel || s.selStrategy).parts))
      .filter((e) => !seen.has(e) && seen.add(e));

    const extras = buildSpecialSnaps(steps, opts);
    return {
      lang,
      family: cfg.family === 'sepy' ? 'py' : cfg.family === 'sejava' ? 'java' : cfg.family,
      fileName: cfg.file,
      locators: locators.join('\n') || '# no locators yet',
      code: snap,
      snap,
      detectSnap: extras.detectSnap,
      isVisibleSnap: extras.isVisibleSnap,
      pickSnap: extras.pickSnap,
    };
  }

  // =====================================================================
  // Syntax highlighter (tokenizer — safe with "#id" inside strings)
  // =====================================================================
  const KW = new Set(('from import def return True None False with as pass async await class const let var new ' +
    'public static void try using test function if else for in not and or lambda').split(' '));
  const CLS = new Set('BaseState expect Expect Page Playwright Browser BrowserContext BrowserType AriaRole assertThat FrameLocator Locator Tests PageTest'.split(' '));

  function highlight(code, family) {
    const src = String(code || '');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lineComment = family && family !== 'py' ? '//' : '#';
    let out = '', i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (src.startsWith(lineComment, i)) {
        let j = src.indexOf('\n', i); if (j < 0) j = src.length;
        out += `<span class="cm">${esc(src.slice(i, j))}</span>`; i = j; continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        j = Math.min(j + 1, src.length);
        out += `<span class="str">${esc(src.slice(i, j))}</span>`; i = j; continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
        const w = src.slice(i, j);
        out += KW.has(w) ? `<span class="kw">${w}</span>` : CLS.has(w) ? `<span class="cls">${w}</span>` : w;
        i = j; continue;
      }
      out += esc(ch); i++;
    }
    return out;
  }

  global.PWCodegen = { generate, generatePlaywright, highlight, LANGS, locParts, renderLoc };
})(typeof window !== 'undefined' ? window : globalThis);
