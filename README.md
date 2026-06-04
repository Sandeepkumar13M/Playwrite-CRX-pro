<p align="center">
  <img src="https://playwright.dev/img/playwright-logo.svg" alt="Playwright Logo" width="100" height="100"/>
</p>

<h1 align="center">Playwright CRX Pro</h1>

<p align="center">
  <a href="https://playwright.dev"><img src="https://img.shields.io/badge/Powered%20by-Playwright-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright"/></a>
  <img src="https://img.shields.io/badge/Manifest-v3-blue?style=flat" alt="Manifest v3"/>
  <img src="https://img.shields.io/badge/Language-Python-3776AB?style=flat&logo=python&logoColor=white" alt="Python"/>
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat" alt="MIT License"/>
</p>

<p align="center"><strong>A Chrome Extension that records browser interactions and automatically generates Playwright Python POM test scripts — no manual scripting required.</strong></p>

---

## Overview

**Playwright CRX Pro** is a developer-focused Chrome extension that watches everything you do in the browser and converts it into production-ready [Playwright](https://playwright.dev) Python code using the **Page Object Model (POM)** pattern. Capture clicks, form inputs, dropdowns, checkboxes, and navigation in real time, then export them as ready-to-run automation scripts.

---

## Features

- **One-click recording** — Start/stop recording browser interactions instantly from the side panel
- **Page Object Model (POM) code generation** — Outputs clean, structured Python classes ready for use in test suites
- **Per-action waits** — Automatically inserts `wait_for` calls for stable, flake-free tests
- **Deep iframe handling** — Detects and generates correct selectors even inside nested iframes
- **Multiple selector strategies** — Choose from `text`, `role`, `label`, `placeholder`, `alt_text`, `title`, `test_id`, `css`, or `xpath`
- **Element picker** — Click any element on the page to inspect and capture its selector
- **State detection** — Mark steps as state detectors to generate `is_visible` / state-check helpers
- **One-click export** — Copy to clipboard or download the generated `.py` file instantly

---

## Tech Stack

| Technology | Role |
|---|---|
| <img src="https://playwright.dev/img/playwright-logo.svg" width="16" height="16"/> [Playwright](https://playwright.dev) | Test automation framework (code target) |
| ![Python](https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white) | Generated script language |
| ![Chrome](https://img.shields.io/badge/Chrome%20Extension-Manifest%20v3-4285F4?style=flat&logo=google-chrome&logoColor=white) | Extension platform |
| JavaScript | Extension runtime (background, content, panel scripts) |

---

## Installation

> **Note:** This extension is not yet published to the Chrome Web Store. Follow the steps below to install it in developer mode.

1. Clone or download this repository:
   ```bash
   git clone https://github.com/Sandeepkumar13M/Playwrite-CRX-pro.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the cloned repository folder
5. The **Playwright CRX Pro** extension will appear in your toolbar

---

## How to Use

1. Click the extension icon or open the **Side Panel** in Chrome
2. Press **Record** to start capturing browser interactions
3. Interact with any website — clicks, form fills, navigation, etc.
4. Use **Pick element** to inspect and select a specific element
5. Use **Detect state** to mark a step as a state/visibility checker
6. Choose your preferred **Selector strategy** (text, role, css, xpath, etc.)
7. Set the **Class name** for the generated POM class
8. Press **Copy** to copy the generated Python code or **Save** to download it as a `.py` file

---

## Generated Code Example

```python
from playwright.sync_api import Page

class GeneratedState:
    def __init__(self, page: Page):
        self.page = page

    def click_login_button(self):
        self.page.get_by_role("button", name="Login").wait_for(state="visible")
        self.page.get_by_role("button", name="Login").click()

    def fill_username(self, value: str):
        self.page.get_by_label("Username").wait_for(state="visible")
        self.page.get_by_label("Username").fill(value)

    def is_dashboard_visible(self) -> bool:
        return self.page.get_by_text("Dashboard").is_visible()
```

---

## Project Structure

```
Playwrite-CRX-pro/
├── icons/
│   ├── icon16.png        # Extension icon (16x16)
│   ├── icon48.png        # Extension icon (48x48)
│   └── icon128.png       # Extension icon (128x128)
├── manifest.json         # Chrome Extension Manifest v3 config
├── background.js         # Service worker — manages recording state
├── content.js            # Content script — captures DOM interactions
├── codegen.js            # Code generation engine (POM builder)
├── panel.js              # Side panel logic
├── panel_clean.html      # Side panel UI
└── README.md
```

---

## Permissions

| Permission | Reason |
|---|---|
| `activeTab` | Access the current tab for element inspection |
| `scripting` | Inject content scripts for event capture |
| `storage` | Persist settings and recorded steps |
| `tabs` | Detect tab navigation events |
| `sidePanel` | Display the recorder UI as a Chrome side panel |
| `<all_urls>` | Enable recording on any website |

---

## Requirements

- **Google Chrome** 114+ (Manifest v3 + Side Panel support required)
- **Python 3.8+** with Playwright installed for running generated scripts:
  ```bash
  pip install playwright
  playwright install
  ```

---

## Contributing

Contributions, bug reports, and feature requests are welcome! Please open an [issue](https://github.com/Sandeepkumar13M/Playwrite-CRX-pro/issues) or submit a pull request.

---

## License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">Made with ❤️ using <a href="https://playwright.dev"><img src="https://playwright.dev/img/playwright-logo.svg" width="16" height="16"/> Playwright</a></p>
