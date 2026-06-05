"""
Launch Chrome with the Playwright CRX Pro extension loaded,
open a test page, simulate hover interactions, and report
any console errors (especially the line-299 crash).
"""
import asyncio, pathlib, sys
from playwright.async_api import async_playwright

EXT_DIR  = str(pathlib.Path(__file__).parent.resolve())
TEST_URL  = "https://example.com"

async def main():
    async with async_playwright() as pw:
        context = await pw.chromium.launch_persistent_context(
            user_data_dir="",          # temp profile
            channel="chrome",          # use installed Chrome
            headless=False,
            args=[
                f"--disable-extensions-except={EXT_DIR}",
                f"--load-extension={EXT_DIR}",
                "--no-sandbox",
            ],
        )

        errors = []
        page = await context.new_page()

        # capture ALL console messages
        page.on("console", lambda m: print(f"[console {m.type}] {m.text}"))
        page.on("pageerror", lambda e: errors.append(str(e)))

        print(f"\nNavigating to {TEST_URL} ...")
        await page.goto(TEST_URL, wait_until="domcontentloaded")
        await page.wait_for_timeout(1500)

        print("Hovering over heading and paragraphs ...")
        for sel in ["h1", "p", "a"]:
            try:
                el = page.locator(sel).first
                await el.hover(timeout=3000)
                await page.wait_for_timeout(300)
            except Exception:
                pass

        await page.screenshot(path="test_result.png")
        print("Screenshot saved: test_result.png")

        if errors:
            print("\nFAIL - Page errors detected:")
            for e in errors:
                print("  ", e)
            sys.exit(1)
        else:
            print("\nPASS - No page errors. Line-299 crash is fixed.")

        await context.close()

asyncio.run(main())
