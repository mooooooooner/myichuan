# Magai Proxy Reverse-Engineering & Integration Guide

本仓库用于在 CTF/研究场景下，将 `https://beta.magai.co` 的聊天链路封装为 OpenAI/Anthropic 兼容接口，并提供多账号轮询与 Web 管理门户。

## 1. 项目能力

- OpenAI 兼容：`POST /v1/chat/completions`
- Anthropic 兼容：`POST /anthropic/v1/messages`、`POST /v1/messages`
- 自动链路：`refresh_token -> Supabase access_token -> next-action short JWT -> /api/chat`
- 自动发现：`userId`、`chatId`、模型列表（`/v1/models`）
- 多账号轮询：账号池启停、删除、导入、按请求轮询（round-robin）
- Web 门户：管理账号凭证、查看状态、导入 JSON

---

## 2. 目录结构

- `apps/server/src/index.ts`：代理主逻辑（鉴权、账号池、发现、上游调用、协议适配）
- `apps/server/.env.example`：服务环境变量模板
- `apps/server/.env`：服务实际配置（敏感）
- `apps/server/accounts.json`：账号池持久化文件（敏感，运行后可能自动生成）
- `apps/web-portal`：React + Vite + Tailwind 管理门户

---

## 3. 代理架构

```text
Client
  -> Proxy (/v1/*)
    -> account pool (round-robin)
    -> Supabase auth refresh (access_token)
    -> Next action 40cd... (short JWT)
    -> Next action / Supabase REST (discover user/chat/models)
    -> Magai /api/chat (NDJSON)
    -> Repackage to OpenAI / Anthropic format
```

说明：
- 默认从“启用账号”中轮询选择。
- 可在请求中显式指定 `accountId`，跳过轮询。

---

## 4. 环境配置（服务端）

先复制：

```bash
cp apps/server/.env.example apps/server/.env
```

最小必填：

- `PROXY_API_KEY`
- `MAGAI_COOKIE`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_REFRESH_TOKEN`

推荐字段：

```env
PORT=8787
PROXY_API_KEY=test-key

MAGAI_BASE_URL=https://beta.magai.co
MAGAI_COOKIE=<cookie>
MAGAI_NEXT_ACTION=40cd8b2ec4704e0f3c267bd98f93b0f9806e121b77

SUPABASE_URL=https://bkatrpghmzbpjhegvkev.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
SUPABASE_REFRESH_TOKEN=<latest>

# multi-account persistence
MAGAI_ACCOUNTS_FILE=apps/server/accounts.json

# optional fallback
MAGAI_DEFAULT_CHAT_ID=
MAGAI_DEFAULT_MODEL_ID=
MAGAI_DEFAULT_MODEL_NAME=Claude Sonnet 4.6
MAGAI_DEFAULT_MODEL_API_NAME=anthropic/claude-4.6-sonnet-20260217
MAGAI_ALWAYS_NEW_CHAT=1
MAGAI_USER_ID=
MAGAI_CHAT_SNAPSHOT_ACTION=40a34afcf0167f40f2afa1b3ff5a65dc8451eac3a6
MAGAI_MODEL_CATALOG_JSON=
```

---

## 5. 运行方式

### 5.1 启动服务端

```bash
pnpm --filter @apps/server dev
```

### 5.2 启动 Web 门户

```bash
pnpm --filter @apps/web-portal dev
```

默认地址：
- Proxy: `http://127.0.0.1:8787`
- Portal: `http://127.0.0.1:5174`

### 5.3 构建

```bash
pnpm -r build
```

---

## 6. API 使用

### 6.1 健康检查

```bash
curl http://127.0.0.1:8787/health
```

### 6.2 模型列表（轮询）

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer test-key"
```

### 6.3 模型列表（指定账号）

```bash
curl "http://127.0.0.1:8787/v1/models?accountId=default" \
  -H "Authorization: Bearer test-key"
```

### 6.4 OpenAI chat

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer test-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"claude-sonnet-4-6",
    "messages":[{"role":"user","content":"reply exactly: OK"}],
    "accountId":"default"
  }'
```

### 6.5 Anthropic chat

```bash
curl http://127.0.0.1:8787/anthropic/v1/messages \
  -H "x-api-key: test-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"claude-sonnet-4-6",
    "messages":[{"role":"user","content":"ping"}],
    "metadata":{"accountId":"default"}
  }'
```

---

## 7. 账号池管理 API

- `GET /v1/accounts`：查看账号池（脱敏视图）
- `POST /v1/accounts/import`：导入账号数组
- `PATCH /v1/accounts/:id`：更新 `enabled`/`name`
- `DELETE /v1/accounts/:id`：删除账号

导入示例：

```json
{
  "accounts": [
    {
      "id": "acc-1",
      "name": "magai-1",
      "enabled": true,
      "magaiCookie": "...",
      "supabaseRefreshToken": "..."
    }
  ]
}
```

---

## 8. Web 门户使用

1. 打开 `http://127.0.0.1:5174`
2. 输入 `PROXY_API_KEY`（默认示例是 `test-key`）
3. 粘贴导出的账号 JSON
4. 点击导入，查看账号池状态与轮询信息

---

## 9. 浏览器控制台一键导出凭证

在 `https://beta.magai.co` 控制台执行：

```js
(() => {
  const out = [];
  const seen = new Set();
  const cookie = document.cookie || "";
  const walk = (v, hit = []) => {
    if (!v || typeof v !== "object") return [];
    const res = [];
    for (const [k, val] of Object.entries(v)) {
      if (k.toLowerCase().includes("refresh_token") && typeof val === "string" && val) {
        res.push({ token: val, hint: hit.join(".") });
      }
      if (val && typeof val === "object") res.push(...walk(val, [...hit, k]));
    }
    return res;
  };

  for (const [k, v] of Object.entries(localStorage)) {
    try {
      const parsed = JSON.parse(v);
      const hits = walk(parsed, [k]);
      for (const h of hits) {
        if (seen.has(h.token)) continue;
        seen.add(h.token);
        out.push({
          id: `acc-${out.length + 1}`,
          name: `magai-${out.length + 1}`,
          enabled: true,
          magaiCookie: cookie,
          supabaseRefreshToken: h.token
        });
      }
    } catch {}
  }

  const json = JSON.stringify(out, null, 2);
  console.log(json);
  copy(json);
  return { count: out.length, copied: true };
})();
```

---

## 10. 排障

1. 账号列表为空
- 检查 Web 门户 API Key 是否与 `PROXY_API_KEY` 一致。
- 检查服务端是否启动在 `8787`。

2. `/v1/models` 只有 1 个或为空
- 检查 refresh token 是否已轮换失效。
- 检查 cookie 是否过期。
- 可用 `MAGAI_MODEL_CATALOG_JSON` 兜底。

3. 报 `failed to discover userId`
- 优先检查 cookie。
- 配置 `MAGAI_USER_ID` 兜底。

4. 报 `chatId not discovered automatically`
- 先请求一次 `/v1/models` 触发发现。
- 或在请求中传 `chatId`。
- 或配置 `MAGAI_DEFAULT_CHAT_ID`。

5. `refresh_token_already_used`
- refresh token 已轮换，需更新为最新 token。

---

## 11. 安全建议

- 不要将 `.env`、`accounts.json`、抓包文件提交到公开仓库。
- 比赛协作中，建立 refresh token 更新流程与责任人。
- 上游结构会变化，建议保留抓包并定期回归。

---

## 12. 批量注册与流式验证（2026-05-20）

### 12.1 批量注册脚本

```bash
pnpm --filter @apps/server register --count 1
```

脚本位置：`apps/server/src/register.ts`  
用途：
- 自动完成 5 步注册流程并拿到 `supabaseRefreshToken`
- 自动合并到 `apps/server/accounts.json`
- 记录到 `apps/server/registered.json`

已修复路径解析问题：默认输出路径现在基于脚本目录计算，不再受运行时 `cwd` 影响。  
即使使用 `pnpm --filter @apps/server exec tsx src/register.ts`，也会稳定写入：
- `apps/server/accounts.json`
- `apps/server/registered.json`

### 12.2 流式接口验证（凭证可用性）

启动服务：

```bash
pnpm --filter @apps/server dev
```

流式测试（OpenAI 兼容）：

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer test-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"claude-sonnet-4-6",
    "stream": true,
    "messages":[{"role":"user","content":"请只回复OK"}]
  }'
```

通过标准：
- HTTP 200
- 持续收到 `data: {...chat.completion.chunk...}`
- 末尾收到 `data: [DONE]`
