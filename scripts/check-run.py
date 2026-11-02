import asyncio, json, urllib.request
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:5280"
exp = json.loads(urllib.request.urlopen(BASE+"/api/experiments").read())[0]["id"]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); page = await b.new_page(viewport={"width":1440,"height":900})
        await page.goto(f"{BASE}/#/experiments/{exp}", wait_until="networkidle"); await page.wait_for_timeout(500)
        await page.keyboard.press("Control+Enter"); await page.wait_for_timeout(1200)
        text = await page.locator(".card").nth(1).inner_text()
        print("run started:", "執行中" in text or "已完成" in text)
        await b.close()
asyncio.run(main())
