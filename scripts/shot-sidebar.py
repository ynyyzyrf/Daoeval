"""側欄驗證：選中/hover、展開/收起、六個位置的新建按鈕。"""
import asyncio
import json
import urllib.request
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:5280"
OUT = r"D:\aicoding\agent-eval-platform\shots"


def get(path):
    with urllib.request.urlopen(BASE + path) as response:
        return json.loads(response.read())


async def check_new_button(page, route, label):
    """在指定路由點頂欄『新建』與側欄『新建實驗』，都要看到抽屜。"""
    results = []
    for trigger in ("topbar", "sidebar"):
        await page.goto(f"{BASE}{route}", wait_until="networkidle")
        await page.wait_for_timeout(500)
        if trigger == "topbar":
            await page.locator(".topbar-actions button", has_text="新建").first.click()
        else:
            await page.locator(".new-item").first.click()
        opened = False
        try:
            await page.get_by_text("新建實驗", exact=False).nth(1).wait_for(timeout=4000)
            opened = True
        except Exception:
            opened = await page.locator("text=名稱").count() > 0
        results.append((label, trigger, opened))
        if opened:
            await page.keyboard.press("Escape")
    return results


async def main():
    errors = []
    outcomes = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        experiments = get("/api/experiments")
        exp_id = experiments[0]["id"]

        # 選中樣式（導航）
        await page.goto(f"{BASE}/testsets", wait_until="networkidle")
        await page.wait_for_timeout(600)
        await page.locator(".nav-item.active").first.hover()
        await page.wait_for_timeout(250)
        await page.screenshot(path=f"{OUT}\\sidebar-selected.png", full_page=False)

        # 最近實驗選中
        await page.goto(f"{BASE}/experiments/{exp_id}", wait_until="networkidle")
        await page.wait_for_timeout(700)
        await page.screenshot(path=f"{OUT}\\sidebar-recent-selected.png", full_page=False)

        # 收起
        await page.locator(".sidebar-toggle").click()
        await page.wait_for_timeout(400)
        await page.screenshot(path=f"{OUT}\\sidebar-collapsed.png", full_page=False)
        width_collapsed = await page.locator(".sidebar").evaluate("el => el.getBoundingClientRect().width")
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(600)
        width_after_reload = await page.locator(".sidebar").evaluate("el => el.getBoundingClientRect().width")
        await page.screenshot(path=f"{OUT}\\sidebar-collapsed-reload.png", full_page=False)

        # 展開
        await page.locator(".sidebar-toggle").click()
        await page.wait_for_timeout(400)
        await page.screenshot(path=f"{OUT}\\sidebar-expanded.png", full_page=False)
        width_expanded = await page.locator(".sidebar").evaluate("el => el.getBoundingClientRect().width")

        # 390 寬：手動展開變成覆蓋層
        narrow = await ctx.new_page()
        await narrow.set_viewport_size({"width": 390, "height": 844})
        await narrow.goto(f"{BASE}/testsets", wait_until="networkidle")
        await narrow.wait_for_timeout(600)
        await narrow.screenshot(path=f"{OUT}\\sidebar-390-default.png", full_page=False)
        await narrow.locator(".sidebar-toggle").click()
        await narrow.wait_for_timeout(400)
        await narrow.screenshot(path=f"{OUT}\\sidebar-390-expanded.png", full_page=False)
        await narrow.close()

        # 新建按鈕六個位置由 scripts/check-new-button.py 驗，不在這裡重跑
        await browser.close()

    print("sidebar widths:", {"collapsed": width_collapsed, "afterReload": width_after_reload, "expanded": width_expanded})
    for item in outcomes:
        print("新建", item[0], item[1], "OK" if item[2] else "FAIL")
    print("errors:", errors if errors else "none")


asyncio.run(main())
