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

## 容器部署

在倉庫根目錄直接構建，不需要構建參數或構建期密鑰：

```bash
docker build -t daoeval .
docker run --rm --read-only --tmpfs /tmp:rw,nosuid,size=512m,mode=1777 --shm-size=256m -p 3000:3000 daoeval
```

平台訪問 `http://localhost:3000`。平台健康檢查配置為 `GET /healthz`，無需登入，成功返回 HTTP 200 和 `{"status":"ok"}`。此接口不依賴前端資源或外部模型。

鏡像使用數字 UID/GID `10001:10001`，監聽 `0.0.0.0:3000`；運行期資料庫與臨時加密密鑰寫入 `/tmp/daoeval`，Chromium 設定、快取和 PDF 臨時檔也只寫 `/tmp`，不依賴 `$HOME`。前端在構建階段生成。鏡像內含 Chromium 和中文字型，可導出中文 PDF；容器內透過 `AEVAL_BROWSER_NO_SANDBOX=1` 關閉 Chromium 自身沙箱，由容器提供隔離，本地執行不會預設關閉。

目前按臨時資料部署：容器重建後資料及自動產生的密鑰可能消失。暫不處理持久化。可在運行期注入 `AEVAL_ENC_KEY`（base64 32 bytes）固定密鑰，無需在構建時提供。

可調整的運行期變數：`AEVAL_HOST`、`AEVAL_PORT`、`AEVAL_DATA_DIR`、`AEVAL_ENC_KEY`、`AEVAL_BROWSER_PATH`。本地 `pnpm start` 保留 `127.0.0.1:5280` 與 `.data` 預設設定。

重複驗證部署約束（需要啟動 Docker Linux 引擎）：

```bash
pnpm run check:health
pnpm run check:container
```

容器檢查會構建鏡像，以只讀根檔案系統和 `/tmp` tmpfs 啟動，驗證數字 UID、3000 端口、5 分鐘內健康就緒、前端、SQLite API 及真實 PDF 生成，結束後刪除測試容器。

演示資料：設定頁「開發者工具 → 灌入示範資料」，或 `POST /api/demo/seed`。

## 對外 API

新增 `/api/v1/agents`、`/api/v1/test-sets`、`/api/v1/experiments` 建立接口，另提供測試集發佈與版本查詢。使用根目錄 `.env` 中的 `AEVAL_API_KEY`，請求頭為 `X-API-Key` 或 `Authorization: Bearer`。本地啟動自動載入 `.env`；Docker 使用 `--env-file .env` 注入，不將密鑰打包進鏡像。未配置時對外接口關閉。原網頁 `/api/*` 業務接口改為需要登入會話，與對外 API Key 各自獨立。

完整請求格式、狀態碼與部署方式見 [對外 API 文件](docs/external-api.md)，配置範例見 [.env.example](.env.example)。驗證：`pnpm run check:external-api`。

## 管理員登入

網頁預設帳號／密碼為 `admin`／`admin`。可在 `.env` 設定 `AEVAL_ADMIN_USERNAME`、`AEVAL_ADMIN_PASSWORD`，重啟後生效。登入後使用 HttpOnly、SameSite=Strict Cookie 保持 12 小時，右上角「登出」立即撤銷會話；重啟服務會使所有會話失效。不將登入密碼或會話寫入 localStorage，支援重新整理和下載 Excel／報告。

健康檢查 `/healthz` 和有效的公開分享連結不需登入。透過 HTTPS 反向代理部署時可設定 `AEVAL_COOKIE_SECURE=true`。同一來源 IP 在 15 分鐘內密碼錯誤 5 次後暫停登入，返回 HTTP 429。登入相關接口為 `POST /api/auth/login`、`GET /api/auth/session`、`POST /api/auth/logout`。驗證：`pnpm run check:login`。

## AI 回答差距評估

在側欄「評估模型」（`/models`）管理模型連線。首頁以列表展示模型和目前預設模型；按「添加模型」或「編輯」打開側邊表單，分別填寫模型資訊與連線設定。新增時可選 DeepSeek 模板或自定義服務，每個配置包含名稱、模型 ID、API 地址和獨立的 API Key。支援 OpenAI 相容的 Chat Completions 及 JSON 輸出；可填完整 `/chat/completions` 地址或基礎地址（例如以 `/v1` 結尾），後者自動補上 `/chat/completions`。舊 DeepSeek 配置會自動保留。

儲存後在列表單獨「測試連線」或「設為預設」；第一個模型自動啟用，後續新增不會自動替換目前模型。測試結果僅顯示於本次頁面，刷新後不宣稱仍然可用。編輯同一地址可留空 Key 保留原值；更改 API 地址時必須重新填寫 Key。金鑰加密儲存，只回傳掩碼；不跟隨 HTTP 重新導向。切換僅影響新批次，已開始的批次繼續使用原配置，歷史紀錄保留當時的模型名稱與地址。設定頁只保留操作審計。

模型配置驗證：`pnpm run check:judge-models`（隔離資料庫和本地模擬服務，不調用外部模型）。

在報告頁選擇已結束的執行批次，按「AI 評估回答」。系統會把有參考回答且調用成功的問題、參考回答、實際回答及評分標準傳送至目前設定的評估服務，產生 API 用量；不重跑受測 Agent，不覆蓋規則評分。右側明細顯示結論、差距與原文證據，多次評估分別保留。

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
- PDF 導出需要 Chromium／Edge／Chrome；Docker 鏡像已內建 Chromium，本地可用 `AEVAL_BROWSER_PATH` 指定瀏覽器。
- 審計（FR-44）、多用戶與權限未做。
- 適配器不硬編回應路徑：Oumi／Dify 全走配置；模板為佔位，需以實測回應校正。
