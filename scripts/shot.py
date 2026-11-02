import asyncio
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:5280"
OUT = r"D:\aicoding\agent-eval-platform\shots"

async def main():
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        await page.wait_for_timeout(800)
        await page.screenshot(path=f"{OUT}\\p1-overview.png", full_page=True)

        nav = page.get_by_role("button", name="Agent", exact=True)
        await nav.click()
        await page.wait_for_timeout(700)
        await page.screenshot(path=f"{OUT}\\p2-agents.png", full_page=True)

        await page.get_by_role("button", name="接入 Agent").click()
        await page.wait_for_timeout(500)
        await page.get_by_role("button", name="工具型").click()
        await page.get_by_role("button", name="下一步").click()
        await page.wait_for_timeout(400)
        await page.get_by_role("button", name="下一步").click()
        await page.wait_for_timeout(400)
        await page.get_by_role("button", name="發送測試請求").click()
        await page.wait_for_timeout(2500)
        await page.screenshot(path=f"{OUT}\\p3-wizard.png", full_page=True)

        await page.goto(f"{BASE}/#/report", wait_until="networkidle")
        await page.wait_for_timeout(700)
        await page.get_by_role("button", name="生成報告").first.click()
        await page.wait_for_timeout(900)
        await page.screenshot(path=f"{OUT}\\p4-report.png", full_page=True)

        await page.goto(f"{BASE}/#/experiments", wait_until="networkidle")
        await page.wait_for_timeout(600)
        await page.screenshot(path=f"{OUT}\\p5-experiments.png", full_page=True)

        await browser.close()
    print("console errors:", errors if errors else "none")

asyncio.run(main())
