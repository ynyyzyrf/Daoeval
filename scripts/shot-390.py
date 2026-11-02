"""390 宽三页截图：概览 / 列表 / 详情。"""
import asyncio
import json
import urllib.request
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:5280"
OUT = r"D:\aicoding\agent-eval-platform\shots"


def get(path):
    with urllib.request.urlopen(BASE + path) as response:
        return json.loads(response.read())


async def main():
    sets = get("/api/test-sets")
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 390, "height": 844})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(f"{BASE}/", wait_until="networkidle")
        await page.wait_for_timeout(800)
        await page.screenshot(path=f"{OUT}\\n1-overview-390.png", full_page=True)

        await page.goto(f"{BASE}/testsets", wait_until="networkidle")
        await page.wait_for_timeout(700)
        await page.screenshot(path=f"{OUT}\\n2-testsets-390.png", full_page=True)

        await page.goto(f"{BASE}/testsets/{sets[0]['id']}", wait_until="networkidle")
        await page.wait_for_timeout(800)
        await page.screenshot(path=f"{OUT}\\n3-testset-detail-390.png", full_page=True)

        await browser.close()
    print("errors:", errors if errors else "none")


asyncio.run(main())



