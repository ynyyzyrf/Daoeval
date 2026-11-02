import asyncio
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:5280"
routes = ["#/", "#/agents", "#/agents/new", "#/testsets", "#/experiments", "#/report", "#/settings"]

async def main():
    errors = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page(viewport={"width":1440,"height":900})
        page.on("console", lambda m: errors.append(f"{m.text}") if m.type=="error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        for route in routes:
            await page.goto(f"{BASE}/{route}", wait_until="networkidle")
            await page.wait_for_timeout(600)
        await page.goto(f"{BASE}/#/testsets", wait_until="networkidle")
        await page.wait_for_timeout(500)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\p6-testsets.png", full_page=True)
        await page.goto(f"{BASE}/#/settings", wait_until="networkidle")
        await page.wait_for_timeout(500)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\p7-settings.png", full_page=True)
        await b.close()
    print("errors:", errors if errors else "none")

asyncio.run(main())
