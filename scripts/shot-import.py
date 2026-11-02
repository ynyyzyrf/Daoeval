"""導入頁三處修正截圖：成功頁（列表刷新＋摘要）、同名導入、錯誤清單、390。"""
import asyncio
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:5280"
OUT = r"D:\aicoding\agent-eval-platform\shots"
FIX = r"C:\Users\ynyyzyrf\AppData\Local\Temp\daoeval-fixtures-H7xezd"


async def open_import(page):
    await page.goto(f"{BASE}/testsets", wait_until="networkidle")
    await page.wait_for_timeout(400)
    await page.get_by_role("button", name="導入 Excel").first.click()
    await page.wait_for_timeout(300)
    await page.get_by_role("button", name="下一步").click()
    await page.wait_for_timeout(200)


async def upload(page, path):
    await page.locator('input[type="file"]').set_input_files(path)
    await page.wait_for_timeout(300)
    await page.get_by_role("button", name="開始導入").click()


async def main():
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1440, "height": 960})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        # 1. 第一次導入：成功頁 + 列表已刷新（新行高亮）
        await open_import(page)
        await upload(page, f"{FIX}\\sample-good.xlsx")
        await page.get_by_text("已新建測試集").wait_for(timeout=30000)
        await page.wait_for_timeout(250)
        await page.screenshot(path=f"{OUT}\\excel-import-success.png", full_page=True)
        await page.wait_for_timeout(1800)

        # 2. 同名再導入一次：明示第 2 個
        await page.get_by_role("button", name="關閉").first.click()
        await open_import(page)
        await upload(page, f"{FIX}\\sample-good.xlsx")
        await page.get_by_text("已新建測試集").wait_for(timeout=30000)
        await page.wait_for_timeout(400)
        await page.screenshot(path=f"{OUT}\\excel-import-duplicate.png", full_page=True)
        await page.get_by_role("button", name="關閉").first.click()

        # 3. 錯誤清單
        await open_import(page)
        await upload(page, f"{FIX}\\sample-errors.xlsx")
        await page.get_by_text("未導入任何數據").wait_for(timeout=30000)
        await page.wait_for_timeout(300)
        await page.screenshot(path=f"{OUT}\\excel-import-errors.png", full_page=True)
        await browser.close()

        # 4. 390 寬
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 390, "height": 844})
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(f"{BASE}/testsets", wait_until="networkidle")
        await page.wait_for_timeout(400)
        await page.get_by_role("button", name="導入 Excel").first.click()
        await page.wait_for_timeout(400)
        await page.screenshot(path=f"{OUT}\\excel-import-390.png", full_page=True)
        await browser.close()

    print("errors:", errors if errors else "none")


asyncio.run(main())
