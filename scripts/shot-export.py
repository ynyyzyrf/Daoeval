import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page(viewport={"width":1200,"height":900})
        await page.goto(r"file:///D:/aicoding/agent-eval-platform/export-test/report.html")
        await page.wait_for_timeout(300)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\s4-export.png", full_page=True)
        await b.close()
asyncio.run(main())
print("done")
