"""390 宽回归检查：概览页 + 列表页截图，并测量单列网格 / 表格 / 按钮是否崩坏。"""
import asyncio
import json

from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:5280"
OUT = r"D:\aicoding\agent-eval-platform\shots"

MEASURE = """
() => {
  const vw = window.innerWidth;
  const out = { vw, scrollWidth: document.documentElement.scrollWidth, grids: [], tables: [], buttons: [] };

  for (const el of document.querySelectorAll('.grid-2, .grid-3, .grid-4, .grid-branches')) {
    const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean);
    out.grids.push({ cls: el.className, cols: cols.length, widths: cols, w: Math.round(el.getBoundingClientRect().width) });
  }

  for (const table of document.querySelectorAll('table.data')) {
    // 往上找最近的裁剪/滚动容器
    let scroller = table.parentElement;
    let scrollable = false;
    while (scroller && scroller !== document.body) {
      const ox = getComputedStyle(scroller).overflowX;
      if (ox === 'auto' || ox === 'scroll') {
        if (scroller.scrollWidth > scroller.clientWidth + 1) scrollable = true;
        break;
      }
      scroller = scroller.parentElement;
    }
    const r = table.getBoundingClientRect();
    const sr = scroller ? scroller.getBoundingClientRect() : null;
    out.tables.push({
      cols: table.querySelectorAll('thead th').length,
      tableW: Math.round(r.width),
      scrollerW: scroller ? Math.round(scroller.clientWidth) : null,
      scrollable,
      scrollerRight: sr ? Math.round(sr.right) : null,
    });
  }

  for (const btn of document.querySelectorAll('.btn')) {
    const r = btn.getBoundingClientRect();
    const parent = btn.parentElement.getBoundingClientRect();
    if (r.width === 0) continue;
    out.buttons.push({ text: (btn.textContent || '').trim().slice(0, 12), right: Math.round(r.right), parentRight: Math.round(parent.right) });
  }

  return out;
}
"""


def judge(name, m):
    bad = []
    if m["scrollWidth"] > m["vw"] + 1:
        bad.append(f"页面横向溢出 scrollWidth={m['scrollWidth']} > {m['vw']}")
    for g in m["grids"]:
        if g["cols"] != 1:
            bad.append(f"网格非单列 {g['cls']} cols={g['cols']} {g['widths']}")
    for t in m["tables"]:
        if t["scrollerW"] is not None and t["tableW"] > t["scrollerW"] + 1 and not t["scrollable"]:
            bad.append(f"表格被切且不可滚动 tableW={t['tableW']} scrollerW={t['scrollerW']}")
        if t["scrollerRight"] is not None and t["scrollerRight"] > m["vw"] + 1:
            bad.append(f"表格容器超出视口 scrollerRight={t['scrollerRight']}")
    for b in m["buttons"]:
        if b["right"] > b["parentRight"] + 1:
            bad.append(f"按钮出界 {b['text']} right={b['right']} parentRight={b['parentRight']}")
    return bad


async def main():
    errors = []
    results = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 390, "height": 844})
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(f"{BASE}/", wait_until="networkidle")
        await page.wait_for_timeout(700)
        await page.screenshot(path=f"{OUT}\\n1-overview-390.png", full_page=True)
        results["overview"] = judge("overview", await page.evaluate(MEASURE))

        await page.goto(f"{BASE}/testsets", wait_until="networkidle")
        await page.wait_for_timeout(700)
        await page.screenshot(path=f"{OUT}\\n2-testsets-390.png", full_page=True)
        raw = await page.evaluate(MEASURE)
        results["testsets"] = judge("testsets", raw)
        results["testsets_tables"] = raw["tables"]

        await browser.close()

    print(json.dumps(results, ensure_ascii=False, indent=2))
    print("console errors:", errors if errors else "none")


asyncio.run(main())
