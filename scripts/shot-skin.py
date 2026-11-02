import asyncio, json, urllib.request
from playwright.async_api import async_playwright
BASE = "http://127.0.0.1:5280"
def get(p):
    with urllib.request.urlopen(BASE + p) as r: return json.loads(r.read())
exp = get("/api/experiments")[0]["id"]
async def main():
    errors=[]
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page(viewport={"width":1440,"height":900})
        page.on("console", lambda m: errors.append(m.text) if m.type=="error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(f"{BASE}/#/", wait_until="networkidle"); await page.wait_for_timeout(700)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\s1-overview.png")
        await page.goto(f"{BASE}/#/agents", wait_until="networkidle"); await page.wait_for_timeout(600)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\s2-agents.png")
        await page.goto(f"{BASE}/#/report/{exp}", wait_until="networkidle"); await page.wait_for_timeout(800)
        await page.screenshot(path=r"D:\aicoding\agent-eval-platform\shots\s3-report.png")
        await b.close()
    print("errors:", errors if errors else "none")
asyncio.run(main())
