<p align="center">
  <img src="https://playwright.dev/img/playwright-logo.svg" alt="Playwright Logo" width="100" height="100"/>
</p>

<h1 align="center">Playwright CRX Pro</h1>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-ff3b30?style=flat" alt="Version 1.0.0"/>
  <a href="https://playwright.dev"><img src="https://img.shields.io/badge/Powered%20by-Playwright-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright"/></a>
  <img src="https://img.shields.io/badge/Selenium-supported-43B02A?style=flat&logo=selenium&logoColor=white" alt="Selenium"/>
  <img src="https://img.shields.io/badge/Manifest-v3-blue?style=flat" alt="Manifest v3"/>
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat" alt="MIT License"/>
</p>

<p align="center"><strong>A Chrome extension that records what you do in the browser and turns it into ready-to-run
Playwright or Selenium test code — Python, JavaScript, TypeScript, Java (JUnit) and C#.</strong></p>

---

## Table of contents

1. [What it does](#what-it-does)
2. [Supported output languages](#supported-output-languages)
3. [Requirements](#requirements)
4. [Install — clone and load in Chrome](#install--clone-and-load-in-chrome)
5. [Use it in Incognito mode](#use-it-in-incognito-mode)
6. [How to use](#how-to-use)
7. [New tabs, popup windows and "Sign in with Google"](#new-tabs-popup-windows-and-sign-in-with-google)
8. [Iframes, Shadow DOM and tricky pages](#iframes-shadow-dom-and-tricky-pages)
9. [Run the generated code](#run-the-generated-code)
10. [Library vs. test runner — which one do I pick?](#library-vs-test-runner--which-one-do-i-pick)
11. [Troubleshooting](#troubleshooting)
12. [Project structure](#project-structure)
13. [Permissions](#permissions)
14. [Limitations](#limitations)
15. [Changelog](#changelog)

---

## What it does

- **Records** clicks, typing, checkboxes, radio buttons, dropdowns, key presses (Enter, Tab, Escape, Space)
  and page navigation — on any website, in normal and Incognito windows.
- **Generates code** live in the side panel in **11 formats** (Playwright and Selenium), ready to copy or save.
- **▶ Play** replays the recording in the browser with real mouse and keyboard input, with a ✓ / ✗ log per step.
- **Smart locators** — every candidate locator is tested on the page while you record; the extension picks one that
  matches exactly one element (adds `exact=True` or `.nth()` only when needed), so the code does not fail with
  Playwright *strict mode* errors.
- **Selector strategy** — choose `text`, `role`, `label`, `placeholder`, `alt_text`, `title`, `test_id`, `css`
  or `xpath`; the code updates immediately. If a strategy is not possible for an element, the code says why and
  uses the next best one.
- **New tabs and popup windows** (links with `target=_blank`, `window.open`, Ctrl+click, middle-click,
  "Sign in with Google" popups) are detected automatically, and the steps you do inside them are recorded.
- **Iframes** (nested, cross-origin, `srcdoc`) and **Shadow DOM** (web components) are supported.
- **POM snaps** — `detect_state()` and `is_visible()` helpers for your BaseState / Page-Object classes, and
  **Pick element** copies an element's HTML to the clipboard.

## Supported output languages

| Framework | Language / flavour | File name | Runs with |
|---|---|---|---|
| Playwright | Python · Pytest | `test_example.py` | `pytest` |
| Playwright | Python · Library | `example.py` | `python example.py` |
| Playwright | Python · Async | `example_async.py` | `python example_async.py` |
| Playwright | Playwright Test · TypeScript | `example.spec.ts` | `npx playwright test` |
| Playwright | Playwright Test · JavaScript | `example.spec.js` | `npx playwright test` |
| Playwright | JavaScript · Library | `example.js` | `node example.js` |
| Playwright | Java · JUnit 5 | `TestExample.java` | `mvn test` |
| Playwright | Java · Library | `Example.java` | `mvn compile exec:java` |
| Playwright | C# · NUnit | `Tests.cs` | `dotnet test` |
| Selenium | Python | `test_selenium.py` | `python` or `pytest` |
| Selenium | Java · JUnit 5 | `SeleniumTest.java` | `mvn test` |

## Requirements

- **Google Chrome 116 or newer** (or any Chromium browser: Edge, Brave, …).
- **Git** to clone the repository (or download the ZIP from GitHub).
- To *run* the generated code you need the matching toolchain — see [Run the generated code](#run-the-generated-code).
  The extension itself needs **no npm install, no build step and no Python**.

## Install — clone and load in Chrome

**1. Get the code**

```bash
git clone https://github.com/Sandeepkumar13M/Playwrite-CRX-pro.git
cd Playwrite-CRX-pro
```

No Git? On GitHub click **Code → Download ZIP** and unzip it.

**2. Load it in Chrome**

1. Open `chrome://extensions`
2. Turn on **Developer mode** (switch in the top-right corner)
3. Click **Load unpacked**
4. Select the **`Playwrite-CRX-pro`** folder (the one that contains `manifest.json`)
5. Click the puzzle icon 🧩 in the toolbar and **pin** *Playwright CRX Pro*

Click the extension icon to open the side panel.

**3. Update to a newer version**

```bash
git pull
```

Then click the 🔄 reload icon on the extension card in `chrome://extensions` and reopen the side panel.

## Use it in Incognito mode

Chrome never runs extensions in Incognito unless you allow it:

1. Open `chrome://extensions`
2. Click **Details** on *Playwright CRX Pro*
3. Turn on **Allow in Incognito**

Then open an Incognito window (`Ctrl+Shift+N`) and use the extension exactly as in a normal window —
recording, new tabs, popups and ▶ Play all work there.

## How to use

### The side panel

| Control | What it does |
|---|---|
| **Record / Stop** | Start or stop recording. The toolbar icon shows a red **REC** badge while recording. |
| **Pause / Resume** | Temporarily stop recording without ending the session. |
| **▶ Play** | Replays all steps in the current tab (click again = **■ Stop**). A log shows ✓ / ✗ per step. |
| **Pick element** | Click any element → its HTML is copied to the clipboard and shown in the *pick* card. |
| **Detect state** | Click an element → generates a `detect_state()` method (`…is_visible()`) for your POM class. |
| **Is visible** | Click an element → generates an `is_visible()` method that waits for the element. |
| **Undo** | Removes the last recorded step. |
| **Clear all** | Removes all steps. |
| **Selector** | Which locator type you prefer (applies to all steps immediately). |
| **Language** | Which framework / language the code is generated in. |
| **Copy / Save** | Copy the code, or download it with the right file name for the language. |
| **Size +** | Makes a code box taller. |

While **Pick element / Detect state / Is visible** is active, a tooltip shows the locator of the element under the
mouse. Press **Esc** to cancel.

The lower half of the panel has five tabs:

| Tab | Shows |
|---|---|
| **Code** | The generated test in the selected language (Copy / Save / Size) |
| **Steps** | Every recorded step with its locator, tab (`page1`…), iframe depth; delete single steps; POM return value and *use as detect_state* |
| **Replay** | Result of ▶ Play: ✓ / ✗ for every step with the reason when something fails |
| **POM** | `detect_state()` and `is_visible()` snaps for your Page-Object classes |
| **Pick** | HTML of picked elements |

The panel follows your system's light / dark theme.

### Recording a test — step by step

1. Open the website you want to test.
2. Open the side panel and press **Record**. A `goto(...)` step for the current page is added automatically.
3. Use the website normally: click, type, tick checkboxes, choose from dropdowns, press Enter …
4. Press **▶ Play** to check the recording works (optional).
5. Pick the **Language**, then **Copy** or **Save** the code.
6. Run it — see [Run the generated code](#run-the-generated-code).

Recording continues when pages navigate (links, form submits) and when you close and reopen the side panel.

### Keyboard shortcuts and right-click menu

| Shortcut | Action |
|---|---|
| `Alt+Shift+R` | Start / stop recording (also opens the side panel) |
| `Alt+Shift+C` | Pick element |
| `Esc` | Cancel Pick / Detect / Is visible |

Right-click any element → **Playwright CRX Pro** → *Pick locator*, *Detect state* or *Is visible*.
Change shortcuts at `chrome://extensions/shortcuts`.

### Selector strategies

| Strategy | Playwright code | Best for |
|---|---|---|
| `role` | `get_by_role("button", name="Login")` | Buttons, links, inputs, headings — **recommended** |
| `label` | `get_by_label("Email")` | Form fields with a `<label>` |
| `placeholder` | `get_by_placeholder("you@example.com")` | Inputs with placeholder text |
| `text` | `get_by_text("Welcome")` | Text on the page |
| `alt_text` | `get_by_alt_text("Logo")` | Images |
| `title` | `get_by_title("Close")` | Elements with a `title` attribute |
| `test_id` | `get_by_test_id("submit-btn")` | Elements with `data-testid` (also `data-test`, `data-test-id`, `data-qa`) |
| `css` | `locator("#login-form button")` | When nothing semantic exists |
| `xpath` | `locator("xpath=/html/body/div[2]")` | Last resort |

For **Selenium**, the same choice maps to `By.ID`, `By.NAME`, `By.CSS_SELECTOR` or `By.XPATH`.

### How locators are chosen (rules)

Following the [Playwright locator guide](https://playwright.dev/docs/locators) and the
[Selenium locator strategies](https://www.selenium.dev/documentation/webdriver/elements/locators/):

1. **User-facing first** — role + accessible name, label, placeholder, text; then test ids.
2. **Unique** — every candidate is counted on the page while recording; `exact=True` or `.nth()` only when needed.
3. **Never generated ids** — React `useId` (`:r1a:`), Radix, Headless UI, MUI, Angular, GUIDs and hashes are ignored.
4. **Never utility classes** — Tailwind/Bootstrap helpers (`flex`, `p-2`, `items-center`, …) and hashed CSS-module classes are ignored.
5. **Relative, anchored paths** — when CSS/XPath must use position, it is anchored on the nearest stable ancestor
   (id, test id, attribute, stable class or a unique landmark such as `main`, `nav`, `form`), e.g.
   `section.composer-tools div:nth-of-type(2) > div > div > span` — never `/html[1]/body[1]/…`.
6. **No text locators for fields you type into** (the text is what you typed).

Selenium code also follows the Selenium docs: explicit waits only (no implicit waits), retries on
stale elements / reloading frames / shadow roots, `driver.quit()` in teardown (null-safe), and
**Cmd on macOS / Ctrl elsewhere** for "open in new tab" clicks.

## New tabs, popup windows and "Sign in with Google"

Nothing special to do — just keep recording:

- Click a link that opens a **new tab** (`target=_blank`), a **Ctrl/Cmd+click**, **Shift+click** or **middle-click**,
  or a button that opens a **popup window** (e.g. *Sign in with Google*).
- Wait for the new tab to load and keep clicking/typing in it — those steps are recorded for that tab.
- Go back to the first tab and continue; the code switches back automatically.
- Popups that **close themselves** (like Google sign-in after choosing an account) are handled.

Each tab gets its own variable: `page` (first tab), `page1`, `page2`, … Example (Python):

```python
with page.expect_popup() as page1_info:
    page.get_by_role("button", name="Login with Google").click()
page1 = page1_info.value
page1.wait_for_load_state()
page1.get_by_label("Email").fill("me@example.com")
page1.get_by_role("button", name="Continue").click()
page.get_by_role("button", name="Done").click()        # back on the first tab
```

Selenium code uses `driver.switch_to.window(...)` with a `windows` dictionary/map in the same way.

> Real Google sign-in pages block automated browsers. For tests, use a test account and saved login state
> (Playwright `storage_state`) instead of automating Google's own login form.

## Iframes, Shadow DOM and tricky pages

- **Iframes** — nested iframes (any depth), cross-origin iframes and `srcdoc` iframes:
  `page.frame_locator("#outer").frame_locator("iframe[name=inner]").get_by_role(...)`.
  Iframe selectors ignore changing `?token=…` query strings.
- **Shadow DOM** — elements inside web components (open shadow roots) are recorded; Playwright reaches them
  automatically, the Selenium code walks the `shadow_root` chain for you.
- **Dialogs that close on mouse-down** (cookie banners, "Are you sure?" popups, security warnings) are recorded,
  because clicks are captured when the mouse button goes down.
- **Pages or other extensions that block events** do not stop the recorder.
- Clicks made by the page's own scripts are **not** recorded — only what you do.

## Run the generated code

Save the code with **Save** (or copy it) into the project folders below.

<details open>
<summary><b>Playwright · Python (Pytest / Library / Async)</b></summary>

```bash
pip install pytest-playwright     # includes playwright
playwright install                 # downloads the browsers once

pytest test_example.py --headed    # Pytest version
python example.py                  # Library version
python example_async.py            # Async version
```
</details>

<details>
<summary><b>Playwright Test · TypeScript / JavaScript</b></summary>

```bash
npm init playwright@latest         # creates playwright.config + tests/ folder
# put example.spec.ts (or example.spec.js) into tests/
npx playwright test --headed
npx playwright show-report         # HTML report
```
</details>

<details>
<summary><b>Playwright · JavaScript Library</b></summary>

```bash
npm init -y
npm install -D playwright @playwright/test
npx playwright install chromium
node example.js
```
</details>

<details>
<summary><b>Playwright · Java (JUnit 5 / Library)</b></summary>

Maven `pom.xml` dependencies (use the latest versions from Maven Central; `@UsePlaywright` needs Playwright 1.45+):

```xml
<dependency>
  <groupId>com.microsoft.playwright</groupId>
  <artifactId>playwright</artifactId>
  <version>1.49.0</version>
</dependency>
<dependency>
  <groupId>org.junit.jupiter</groupId>
  <artifactId>junit-jupiter</artifactId>
  <version>5.11.3</version>
  <scope>test</scope>
</dependency>
```

Put `TestExample.java` in `src/test/java/` and run `mvn test`.
For the library version put `Example.java` in `src/main/java/` and run
`mvn compile exec:java -Dexec.mainClass=Example`.
</details>

<details>
<summary><b>Playwright · C# NUnit</b></summary>

```bash
dotnet new nunit -n PlaywrightTests
cd PlaywrightTests
dotnet add package Microsoft.Playwright.NUnit
dotnet build
pwsh bin/Debug/net8.0/playwright.ps1 install
# replace UnitTest1.cs with Tests.cs
dotnet test
```
</details>

<details>
<summary><b>Selenium · Python</b></summary>

```bash
pip install selenium pytest        # Selenium 4.6+ downloads ChromeDriver automatically
python test_selenium.py            # or: pytest test_selenium.py
```

The file contains small helpers: `el()` waits for an element and enters iframes / shadow roots,
`type_into()`, `set_checked()` and `new_window()` for new tabs and popups.
</details>

<details>
<summary><b>Selenium · Java JUnit 5</b></summary>

```xml
<dependency>
  <groupId>org.seleniumhq.selenium</groupId>
  <artifactId>selenium-java</artifactId>
  <version>4.27.0</version>
</dependency>
<dependency>
  <groupId>org.junit.jupiter</groupId>
  <artifactId>junit-jupiter</artifactId>
  <version>5.11.3</version>
  <scope>test</scope>
</dependency>
```

Put `SeleniumTest.java` in `src/test/java/` and run `mvn test`.
</details>

## Library vs. test runner — which one do I pick?

| | **Test runner** (Pytest, Playwright Test, JUnit, NUnit) | **Library** (Python / JavaScript / Java Library) |
|---|---|---|
| What you get | A **test**: opens the browser for you, reports pass/fail, screenshots, retries, HTML reports | A plain **script**: opens the browser itself and runs top to bottom |
| Use it for | Automated tests, CI pipelines, test suites | Automation tasks, scraping, quick experiments, calling from your own program |
| Recommended | ✅ for testing | when you are not writing tests |

If you are writing tests, pick **Pytest**, **Playwright Test**, **JUnit** or **NUnit**.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Manifest file is missing" when loading | Select the folder that contains `manifest.json`. |
| Nothing is recorded on a tab | Reload the page once, or press Record again (the recorder is injected on Record). Chrome pages (`chrome://…`) and the Web Store cannot be recorded. |
| Not working in Incognito | Turn on **Allow in Incognito** — see [Incognito](#use-it-in-incognito-mode). |
| Changes to the code don't show | Click 🔄 on the extension card in `chrome://extensions`, then reopen the side panel. |
| "… started debugging this browser" bar | Shown while ▶ Play runs (it uses Chrome's debugger API for real clicks). Normal. |
| ▶ Play: "covered by another element" | A dialog/overlay is over the element — record closing it first. |
| Shortcuts don't work | Another extension uses them — change them at `chrome://extensions/shortcuts`. |
| Strict mode error when running Playwright code | Re-record that step; locators are checked for uniqueness at record time, but the page may have changed. |

## Project structure

```
Playwrite-CRX-pro/
├── manifest.json        # Chrome extension manifest (MV3), version 1.0.0
├── background.js        # Service worker: recording state, steps, tabs/popups, shortcuts, context menu
├── content.js           # Runs in every page/iframe: records actions, builds locators, iframe/shadow support
├── codegen.js           # Code generator: Playwright (Python/JS/TS/Java/C#) + Selenium (Python/Java)
├── replay.js            # ▶ Play engine (Chrome DevTools Protocol input, tabs, popups, iframes)
├── panel_clean.html     # Side panel UI
├── panel.js             # Side panel logic
├── icons/               # Extension icons
├── test_extension.py    # Smoke test: launches Chromium with the extension loaded
└── README.md
```

To run the smoke test: `pip install playwright && playwright install chromium && python test_extension.py`.

## Permissions

| Permission | Why |
|---|---|
| `<all_urls>`, `scripting`, `activeTab`, `tabs` | Record on any website and in every iframe |
| `storage` | Keep your settings and the recorded steps |
| `sidePanel` | The recorder UI |
| `webNavigation` | Detect new tabs and popup windows opened by the page |
| `contextMenus` | Right-click menu |
| `debugger` | ▶ Play: real clicks and typing (only attached while replaying) |

Nothing is sent anywhere — all data stays in your browser.

## Limitations

- **Closed** shadow roots cannot be recorded (Playwright and Selenium cannot reach them either).
- Chrome's own pages (`chrome://…`, the Web Store, PDF viewer) cannot be recorded.
- Popups shown by **other extensions** only exist where that extension is installed — don't record clicks on them.
- Java and C# output follow the official Playwright / Selenium APIs but are not compiled by the extension.

## Changelog

### 1.0.0
- ▶ Play / replay with per-step results, across tabs, popups and iframes.
- Output in 11 formats: Playwright Python (Pytest, Library, Async), Playwright Test (TypeScript, JavaScript),
  JavaScript Library, Java (JUnit 5, Library), C# NUnit, Selenium Python, Selenium Java (JUnit 5).
- New tabs, popup windows, Ctrl/Shift/middle-click and self-closing "Sign in with Google" popups.
- Works in Incognito (after "Allow in Incognito").
- Smart unique locators; selector strategy applies to all steps; explains fallbacks.
- Iframes (nested, cross-origin, `srcdoc`, inside Shadow DOM), Shadow DOM elements, dialogs that close on mouse-down.
- Recording survives navigation and closing the side panel; steps are kept in the order you did them.
- Shortcuts `Alt+Shift+R` / `Alt+Shift+C`, right-click menu, Undo, REC badge.

## License

MIT
