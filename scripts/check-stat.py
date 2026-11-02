import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); page = await b.new_page(viewport={"width":1440,"height":900})
        await page.goto("http://127.0.0.1:5280/#/", wait_until="networkidle"); await page.wait_for_timeout(600)
        info = await page.evaluate("""() => { const el = document.querySelector('.stat-value'); if(!el) return null; const cs = getComputedStyle(el); return {cls: el.className, size: cs.fontSize, family: cs.fontFamily, html: el.outerHTML.slice(0,80)} }""")
        print(info)
        await b.close()
asyncio.run(main())
