"""390 寬：預設圖標軌、手動展開變覆蓋層。"""
import asyncio
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:5280"
OUT = r"D:\aicoding\agent-eval-platform\shots"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 390, "height": 844})
        page = await ctx.new_page()
        await page.goto(f"{BASE}/testsets", wait_until="networkidle")
        await page.evaluate("localStorage.removeItem('daoeval.sidebar')")
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(500)
        rail = await page.locator(".sidebar").evaluate("el => el.getBoundingClientRect().width")
        await page.screenshot(path=f"{OUT}\\sidebar-390-default.png")
        await page.locator(".sidebar-toggle").click()
        await page.wait_for_timeout(400)
        opened = await page.locator(".sidebar").evaluate("el => el.getBoundingClientRect().width")
        position = await page.locator(".sidebar").evaluate("el => getComputedStyle(el).position")
        await page.screenshot(path=f"{OUT}\\sidebar-390-expanded.png")
        print("rail", rail, "expanded", opened, "position", position)
        await browser.close()


asyncio.run(main())
