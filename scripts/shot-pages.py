import asyncio, json, urllib.request
from playwright.async_api import async_playwright
BASE="http://127.0.0.1:5280"
def get(p):
    with urllib.request.urlopen(BASE+p) as r: return json.loads(r.read())
sets=get("/api/test-sets"); exps=get("/api/experiments")
async def main():
    errors=[]
    async with async_playwright() as p:
        b=await p.chromium.launch(); page=await b.new_page(viewport={"width":1440,"height":900})
        page.on("console", lambda m: errors.append(m.text) if m.type=="error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(f"{BASE}/#/", wait_until="networkidle"); await page.wait_for_timeout(1000)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\l4-overview.png")
        await page.goto(f"{BASE}/#/testsets", wait_until="networkidle"); await page.wait_for_timeout(600)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\l6-testsets.png")
        await page.goto(f"{BASE}/#/testsets/{sets[0]['id']}", wait_until="networkidle"); await page.wait_for_timeout(700)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\l7-testset-detail.png")
        await page.goto(f"{BASE}/#/experiments/{exps[0]['id']}", wait_until="networkidle"); await page.wait_for_timeout(700)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\l8-experiment.png")
        await page.goto(f"{BASE}/#/settings", wait_until="networkidle"); await page.wait_for_timeout(500)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\l9-settings.png")
        await b.close()
    print("errors:", errors if errors else "none")
asyncio.run(main())
