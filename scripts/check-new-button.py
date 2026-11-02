"""驗收：六個位置點頂欄『新建』與側欄『新建實驗』都要開得了抽屜。"""
import asyncio
import json
import urllib.request
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:5280"


def get(path):
    with urllib.request.urlopen(BASE + path) as response:
        return json.loads(response.read())


async def main():
    exp_id = get("/api/experiments")[0]["id"]
    routes = [
        ("/experiments", "列表頁"),
        (f"/experiments/{exp_id}", "實驗詳情"),
        ("/", "概覽"),
        ("/testsets", "測試集"),
        ("/agents", "Agent"),
        ("/settings", "設定"),
    ]
    rows = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1440, "height": 900})
        for route, label in routes:
            for trigger in ("topbar", "sidebar"):
                await page.goto(f"{BASE}{route}", wait_until="networkidle")
                await page.wait_for_timeout(450)
                if trigger == "topbar":
                    await page.get_by_role("button", name="新建", exact=True).click()
                else:
                    await page.locator(".new-item").click()
                await page.wait_for_timeout(400)
                opened = await page.evaluate("() => Boolean(document.querySelector('.drawer, .drawer-panel, [class*=drawer]'))")
                rows.append((label, trigger, opened))
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(300)
        await browser.close()
    for label, trigger, opened in rows:
        print(f"{label:6s} {trigger:8s} {'OK' if opened else 'FAIL'}")


asyncio.run(main())
