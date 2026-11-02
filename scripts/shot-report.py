import asyncio, json, urllib.request
from playwright.async_api import async_playwright
BASE = "http://127.0.0.1:5280"
def get(p):
    with urllib.request.urlopen(BASE + p) as r: return json.loads(r.read())
exp = get("/api/experiments")[0]["id"]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page(viewport={"width":1440,"height":900})
        await page.goto(f"{BASE}/#/report/{exp}", wait_until="networkidle")
        await page.wait_for_timeout(800)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\p4-report.png", full_page=True)
        await page.goto(f"{BASE}/#/experiments/{exp}", wait_until="networkidle")
        await page.wait_for_timeout(700)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\p9-experiment-detail.png", full_page=True)
        await b.close()
asyncio.run(main())
print("done")
