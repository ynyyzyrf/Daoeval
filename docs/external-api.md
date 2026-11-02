# Daoeval 对外创建接口

对外接口前缀为 `/api/v1`，请求和响应均使用 JSON。容器默认地址为 `http://localhost:3000`，本地 `pnpm start` 默认使用 `http://localhost:5280`。

## 配置与鉴权

项目根目录 `.env`：

```dotenv
AEVAL_API_KEY=替换为随机生成的密钥
```

本地已生成一把随机 Key，保存在未纳入 Git 的 `.env` 中。其他机器可复制 `.env.example` 为 `.env`，再生成并填写自己的 Key：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`pnpm start` 和 `pnpm dev` 自动加载根目录 `.env`，部署环境注入的同名变量优先。修改 Key 后需重启服务。Key 不进入前端构建产物、不写入审计记录，也不接受 URL 查询参数传递。

每次请求添加以下任意一个请求头：

```http
X-API-Key: 你的密钥
```

```http
Authorization: Bearer 你的密钥
```

同时提供两个请求头时，值必须一致。缺少或错误的 Key 返回 `401`；服务端未配置或配置为空时，对外接口关闭并返回 `503`。健康检查 `/healthz` 无需 Key。

网页使用的原 `/api/agents`、`/api/test-sets`、`/api/experiments` 等接口需要管理员登录会话。API Key 仅用于 `/api/v1`，与网页登录独立：浏览器会话不能替代对外 API Key，API Key 也不能替代网页登录。

Docker 运行时注入 `.env`，无需把密钥加入镜像：

```bash
docker build -t daoeval .
docker run --rm --env-file .env --read-only --tmpfs /tmp:rw,nosuid,size=512m,mode=1777 --shm-size=256m -p 3000:3000 daoeval
```

## 接口清单

以下接口均要求 API Key：

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/api/v1/agents` | 验证真实连通性并接入 Agent，生成初始版本 |
| POST | `/api/v1/test-sets` | 创建测试集草稿，可同时传入测试用例 |
| POST | `/api/v1/test-sets/:id/publish` | 发布测试集，生成实验所需的不可变版本 |
| POST | `/api/v1/experiments` | 创建实验并冻结配置，不自动执行实验 |
| GET | `/api/v1/agents` | 查询未归档 Agent 及其版本 |
| GET | `/api/v1/test-sets` | 查询未归档测试集 |
| GET | `/api/v1/dataset-versions` | 查询测试集版本 |
| GET | `/api/v1/scoring-profile-versions` | 查询评分规则版本 |

### 1. 接入 Agent

`POST /api/v1/agents`：

```json
{
  "config": {
    "name": "客服 Agent",
    "platformType": "custom_http",
    "endpoint": "https://agent.example.com/chat",
    "authType": "bearer",
    "requestTemplate": {
      "method": "POST",
      "headers": { "Content-Type": "application/json" },
      "body": { "input": "{{input}}", "session_id": "{{sessionId}}" }
    },
    "responseMap": { "outputPath": "answer" },
    "allowWrite": false,
    "versionInfo": { "model": "your-model", "promptVersion": "v1" }
  },
  "secret": "被测 Agent 自己的凭证"
}
```

`platformType` 支持 `custom_http`、`oumi`、`dify_agent`、`dify_workflow`。`authType` 支持 `none`、`api_key`、`bearer`、`header`；自定义鉴权头可用 `config.authHeader` 指定。无鉴权 Agent 使用 `authType: "none"`，省略 `secret`。请求模板和响应路径必须按真实 Agent 的接口配置。

`secret` 是 Daoeval 调用被测 Agent 的凭证，与调用 Daoeval 的 `AEVAL_API_KEY` 分开。Agent 凭证沿用现有加密存储逻辑。

创建前会真实调用 Agent 进行连通性验证（超时 15 秒）。验证不通过或名称重复时返回 `400`。成功返回 `201`：

```json
{ "id": "ag_...", "versionId": "av_...", "validation": { "ok": true } }
```

此处 `validation` 仅展示关键字段，实际响应还包括时间、耗时等验证信息。记录 `versionId`，新建实验时使用。

### 2. 新增测试集

`POST /api/v1/test-sets`：

```json
{
  "name": "客服问答测试集",
  "description": "接口导入",
  "cases": [
    {
      "name": "问候",
      "type": "basic_qa",
      "input": "你好",
      "expected": "你好",
      "scoringRubric": "",
      "rule": [{ "kind": "contains", "path": "output", "value": "你好" }],
      "timeoutMs": 30000,
      "multiTurn": null,
      "priority": "medium",
      "readWrite": "read"
    }
  ]
}
```

`name` 必填；`description` 默认空字符串，`cases` 默认空数组。每条用例应包含示例中的字段，不传用例 `id`。`type` 可取 `basic_qa`、`instruction`、`knowledge`、`tool_use`、`multi_turn`、`complex_task`、`exception`、`security`；`priority` 为 `high`、`medium`、`low`；`readWrite` 为 `read`、`write`。`rule` 可为 `null`，但发布时每条用例必须有规则或非空 `scoringRubric`。

成功返回 `201`：

```json
{ "id": "ts_..." }
```

这是草稿 ID，不能直接作为实验的 `datasetVersionId`。接着发布：

`POST /api/v1/test-sets/ts_.../publish`，请求体为 `{}`，使用默认评分规则集；也可明确传入：

```json
{ "scoringProfileVersionId": "spv_..." }
```

成功返回 `201`：

```json
{ "versionId": "tsv_...", "versionNo": 1 }
```

空测试集、缺少评分标准或评分版本无效返回 `400`。默认评分规则在首次发布时自动创建，可通过 `GET /api/v1/scoring-profile-versions` 获取 ID。

### 3. 新建实验

`POST /api/v1/experiments`：

```json
{
  "name": "客服首轮评测",
  "kind": "A",
  "datasetVersionId": "tsv_...",
  "scoringProfileVersionId": "spv_...",
  "repeats": 1,
  "branches": [{ "role": "baseline", "agentVersionId": "av_..." }],
  "externalConditions": { "environment": "staging" }
}
```

`kind` 使用 `A`（单方案）或 `B`（对照），默认 `A`；`repeats` 默认 1，须为正整数。`name`、两个版本 ID 以及至少一个 `branches` 分支必填。对照实验可增加 `role: "experiment"` 的分支；每个分支也可附带 `variables` 字符串键值对。

成功返回 `201`：

```json
{ "ok": true, "experimentId": "exp_..." }
```

必填字段缺失返回 `400`；引用版本不存在、已停用或实验配置不完整返回 `409`，响应包含 `missing` 数组。创建成功后可在网页中查看和执行实验，本次未新增对外启动执行接口。

## 最小调用示例

在根目录 `.env` 已配置后，本地 Node.js 22 可使用下面的方式发起请求：

```js
import { loadEnvFile } from 'node:process'
loadEnvFile('.env')
const response = await fetch('http://localhost:3000/api/v1/agents', {
  headers: { 'X-API-Key': process.env.AEVAL_API_KEY },
})
if (!response.ok) throw new Error(await response.text())
console.log(await response.json())
```

POST 请求另外设置 `Content-Type: application/json`，并通过 `body: JSON.stringify(payload)` 传入对应示例。

## 验证

```bash
pnpm run check:external-api
```

测试使用隔离 SQLite 和本地模拟 Agent，不访问真实模型、不读取实际 `.env` 密钥；覆盖环境文件加载、环境变量优先级、缺失/错误 Key、两种鉴权头、未配置关闭、拒绝请求无写入、失败创建回滚、网页登录鉴权独立和完整创建链路。
