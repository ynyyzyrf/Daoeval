# Daoeval · V1.0

以測試集、執行批次與證據評估 Agent 的本地評測平台。

環境：Node.js 22、pnpm。

接手與系統全貌見 [docs/handover-2026-10-31.md](docs/handover-2026-10-31.md)；接入真實 Agent 見 [docs/接入檢查清單.md](docs/接入檢查清單.md)。

目前狀態：接入（三步）→ 測試集 → 實驗（四元組凍結）→ 批量執行 → 規則評分 → A/B 報告 → 導出（JSON／HTML／PDF）全鏈路可跑，六頁 UI 可點：概覽／Agent／測試集／實驗／報告／設定；深連結可直開。Oumi／Dify 映射模板已留，等真實實例實測。

## 跑起來

```bash
pnpm install
pnpm run build:web   # 前端改動後必跑
pnpm start           # 平台 http://127.0.0.1:5280，模擬 Agent http://127.0.0.1:5199
```

資料庫是 SQLite（`better-sqlite3`），首次啟動自動建庫，不需要 Postgres、不需要建庫腳本。
憑證金鑰可用 `AEVAL_ENC_KEY`（base64 32 bytes）注入；本地缺省自動生成 `.data/dev-enc.key`。

演示資料：設定頁「開發者工具 → 灌入示範資料」，或 `POST /api/demo/seed`。

## AI 回答差距評估

在「設定 → AI 回答評估 · DeepSeek」儲存模型名稱及 API Key，再按「測試已儲存設定」。金鑰加密儲存，只回傳掩碼；使用 DeepSeek 官方 `https://api.deepseek.com/chat/completions` 介面，預設模型名稱 `deepseek-flash`，可改為帳戶可用的模型名稱。

在報告頁選擇已結束的執行批次，按「AI 評估回答」。系統會把有參考回答且調用成功的問題、參考回答、實際回答及評分標準傳送給 DeepSeek，產生 API 用量；不重跑受測 Agent，不覆蓋規則評分。右側明細顯示結論、差距與原文證據，多次評估分別保留。

AI 評估全域並發 1、單次請求上限 90 秒、單條輸入上限 40,000 字元、單批上限 200 條。無回答／缺少參考回答／調用失敗不送評；鑰匙無效、餘額不足或限流時停止該批後續送評。重啟中斷會標示，需手動重評，不自動重送。AI 評估結果目前在報告頁查看，不併入原規則分數、分享快照或 PDF／HTML 匯出。

介面參考：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。隔離驗證：`node --import tsx scripts/check-ai-evaluation.ts`（需 Node 22；使用模擬回應，不調用外部模型）。

## 自檢

```bash
pnpm run smoke    # 55 條；只依賴 5199 的模擬 Agent，不需要 5280 主服務在跑
pnpm exec tsc -p tsconfig.json --noEmit
```

覆蓋：錯誤分類（逾時／認證／404／429／非 JSON／映射失敗）、三態證據、版本不可變 trigger、憑證只寫不讀、四元組閘門、會話隔離、只讀攔截、N/A 六類原因、批量（N／暫停／繼續／取消）、佇列落庫與手動續跑、trial 歸屬 run、legacy 批次回填、Wilson 95% 信賴區間、報告導出（含中文分類與 N/A）、Oumi 映射模板、SPA 深連結、中斷清理。

## 目錄

```
src/server/    Fastify + SQLite：db、store、adapter、scoring、runner、routes、report、mock-agent
src/server/runner.ts  批量佇列：落庫任務表、並發／暫停／繼續／取消、重啟後手動續跑
src/shared/    共用型別、ERROR_CLASS_LABELS、皮膚 token（skin.ts 是唯一來源）
web/src/       React 前端：pages、components、lib（pushState 路由）、tokens.css（生成物）
scripts/       smoke（自檢 55 條）、batch-run、demo-run、gen-tokens、shot（截圖）
docs/          規範、參考稿、Oumi swagger、接入清單、交接文檔
```

## 已知限制

- SQLite 單進程；換 Postgres 只動 `db.ts` 與 `store.ts`，trigger 需重建。
- 批量佇列為單進程 worker，不支援多進程或多機。
- 佇列任務已落庫；重啟後殘留 running 會標為 interrupted，需使用者手動按「繼續」續跑。不會自動續跑，避免在使用者不知情時打真實 Agent。
- 每條 trial 有 `run_id`，指標與報告按單次 run 聚合；舊資料回填成 legacy 批次，頁面會標示「歷史批次，指標可能不完整」。
- 極端崩潰若發生在 trial 落庫後、任務狀態回寫前，該條可能缺評分（機率極小）。
- legacy 批次依 `created_at` 分批推導，無法還原真實執行邊界。
- 評分只做規則；AI／人工評分未做，Rubric 案例在報告裡是 N/A 而不是 0 分。
- PDF 導出依賴本機 Edge headless，CI／Linux 需替換。
- 審計（FR-44）、多用戶與權限未做。
- 適配器不硬編回應路徑：Oumi／Dify 全走配置；模板為佔位，需以實測回應校正。
