import asyncio
from playwright.async_api import async_playwright

async def main():
    errors = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page(viewport={"width":1360,"height":900})
        page.on("console", lambda m: errors.append(f"console:{m.text}") if m.type=="error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror:{e}"))
        await page.goto("http://127.0.0.1:5280", wait_until="networkidle")
        for name in ["測試集","實驗與試驗","Agent 接入"]:
            await page.get_by_role("button", name=name).click()
            await page.wait_for_timeout(400)
        await b.close()
    print("errors:", errors if errors else "none")

asyncio.run(main())
