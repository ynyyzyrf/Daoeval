import asyncio, json, urllib.request
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:5280"
def get(path):
    with urllib.request.urlopen(BASE + path) as r:
        return json.loads(r.read())

sets = get("/api/test-sets")
exps = get("/api/experiments")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page(viewport={"width":1440,"height":900})
        await page.goto(f"{BASE}/#/testsets/{sets[0]['id']}", wait_until="networkidle")
        await page.wait_for_timeout(700)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\p8-testset-detail.png", full_page=True)
        await page.goto(f"{BASE}/#/experiments/{exps[0]['id']}", wait_until="networkidle")
        await page.wait_for_timeout(700)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\p9-experiment-detail.png", full_page=True)
        await page.goto(f"{BASE}/#/settings", wait_until="networkidle")
        await page.wait_for_timeout(400)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\p7-settings.png", full_page=True)
        await b.close()

asyncio.run(main())
print("done")
