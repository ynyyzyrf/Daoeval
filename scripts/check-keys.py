import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); page = await b.new_page(viewport={"width":1440,"height":900})
        await page.goto("http://127.0.0.1:5280/#/agents", wait_until="networkidle"); await page.wait_for_timeout(400)
        await page.keyboard.press("Control+k"); await page.wait_for_timeout(300)
        visible = await page.locator(".palette").count()
        print("palette:", visible)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\l5-palette.png")
        await page.keyboard.press("Escape"); await page.wait_for_timeout(200)
        await page.goto("http://127.0.0.1:5280/#/experiments", wait_until="networkidle"); await page.wait_for_timeout(300)
        await page.keyboard.press("Control+n"); await page.wait_for_timeout(400)
        drawer = await page.locator(".drawer").count()
        print("new drawer:", drawer)
        await b.close()
asyncio.run(main())
