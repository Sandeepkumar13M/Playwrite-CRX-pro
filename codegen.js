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
      L.push(`        return ${locatorChain(detectStep, detectStep.selStrategy || opts.sel)}.is_visible()`);
    } else {
      L.push('        # TODO: mark a step as detect_state in the recorder');
      L.push('        return False');
    }
    L.push('');

    actionSteps.forEach((step, i) => {
      const loc = locatorChain(step, step.selStrategy || opts.sel);
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
  // A locator is { parts: [{k, ...}], tier, comment } rendered per language later.
  function locParts(step, strategy) {
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
    const byCss = () => (css && css.value) ? { parts: [...frames, { k: 'locator', v: css.value }], tier: /^[#[]/.test(css.value) ? 2 : 3 } : null;
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
    const stableCss = css && css.value && /^[#[]/.test(css.value);
    const structural = (fn) => (fn === byCss && strategy !== 'css' && !stableCss) || (fn === byXpath && strategy !== 'xpath');
    // An "Assert text" locator must not be built from the text it asserts.
    const usable = (fn) => !(step.verb === 'assert_text' && fn === byText);

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
    'python-pytest': { family: 'py', file: 'test_example.py', label: 'Python · Pytest', indent: 4, root: 'page', aw: '' },
    'python':        { family: 'py', file: 'example.py', label: 'Python · Library', indent: 4, root: 'page', aw: '' },
    'python-async':  { family: 'py', file: 'example_async.py', label: 'Python · Async', indent: 4, root: 'page', aw: 'await ' },
    'playwright-test': { family: 'js', file: 'example.spec.ts', label: 'Playwright Test (TS/JS)', indent: 2, root: 'page' },
    'java':          { family: 'java', file: 'Example.java', label: 'Java', indent: 6, root: 'page' },
    'csharp':        { family: 'cs', file: 'Tests.cs', label: 'C# · NUnit', indent: 8, root: 'Page' },
  };

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
      case 'click': default:
        return call(`${L}.click()`, `${L}.click()`, `${L}.click()`, `${L}.ClickAsync()`);
    }
  }

  function popupLines(cfg, P, NEW, stmt, pad) {
    const one = ' '.repeat(cfg.family === 'py' ? 4 : cfg.indent > 4 ? 4 : 2);
    switch (cfg.family) {
      case 'py':
        if (cfg.aw) return [`${pad}async with ${P}.expect_popup() as popup_info:`, `${pad}${one}${stmt}`, `${pad}${NEW} = await popup_info.value`];
        return [`${pad}with ${P}.expect_popup() as popup_info:`, `${pad}${one}${stmt}`, `${pad}${NEW} = popup_info.value`];
      case 'js':
        return [`${pad}const ${NEW}Promise = ${P}.waitForEvent('popup');`, `${pad}${stmt}`, `${pad}const ${NEW} = await ${NEW}Promise;`];
      case 'java':
        return [`${pad}Page ${NEW} = ${P}.waitForPopup(() -> {`, `${pad}  ${stmt}`, `${pad}});`];
      default:
        return [`${pad}var ${NEW} = await ${P}.RunAndWaitForPopupAsync(async () =>`, `${pad}{`, `${pad}    ${stmt}`, `${pad}});`];
    }
  }

  const SNAP_SKIP = new Set(['detect', 'is_visible', 'pick']);

  function bodyLines(steps, opts, cfg) {
    const pad = ' '.repeat(cfg.indent);
    const out = [];
    let P = cfg.root, popups = 0;
    for (const step of steps) {
      if (!step.verb || step.isDetect || SNAP_SKIP.has(step.verb)) continue;
      const loc = step.verb === 'goto' ? null : locParts(step, step.selStrategy || opts.sel);
      const L = loc ? renderLoc(cfg.family, P, loc.parts) : null;
      if (loc && loc.tier === 3 && opts.comments !== false) {
        out.push(`${pad}${cfg.family === 'py' ? '#' : '//'} fallback locator: no unique semantic locator found`);
      }
      const stmt = statement(cfg, step, L, P);
      if (step.opensPopup) {
        popups++;
        const NEW = `page${popups}`;
        out.push(...popupLines(cfg, P, NEW, stmt, pad));
        P = NEW;
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
      case 'playwright-test':
        return [
          "import { test, expect } from '@playwright/test';",
          '',
          "test('test', async ({ page }) => {",
          ...body,
          '});',
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
        const loc = renderLoc('py', 'self.app.page', locParts(step, step.selStrategy || strategy).parts);
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
        const loc = renderLoc('py', 'self.app.page', locParts(step, step.selStrategy || strategy).parts);
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
    const lang = LANGS[opts.lang] ? opts.lang : 'python-pytest';
    const cfg = LANGS[lang];
    const snap = wrap(lang, bodyLines(steps, opts, cfg)).join('\n');

    // Python locator list (kept for compatibility with older callers)
    const seen = new Set();
    const locators = steps
      .filter((s) => s.verb && s.verb !== 'goto')
      .map((s) => renderLoc('py', 'page', locParts(s, s.selStrategy || opts.sel).parts))
      .filter((e) => !seen.has(e) && seen.add(e));

    const extras = buildSpecialSnaps(steps, opts);
    return {
      lang,
      family: cfg.family,
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
