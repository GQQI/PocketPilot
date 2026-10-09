# 远程配对（Remote Pairing）进度

分支：`feature/remote-pairing`（未改动 main）

## 阶段 1：安全加固（已完成）

### 改动清单
- `packages/agent-core/src/hub.ts`
  - 新增 `remote` 选项（默认读 `MOBILEAGENT_REMOTE=1`）：远程模式下 `hostInfo` 永不返回配对码、loopback 视为未授权；每次配对成功/锁定后配对码自动轮换。
  - 令牌改为**按设备签发**：`mat_` + 32 字节随机，磁盘仅存 SHA-256；每设备有 id/名称/创建/最近活动/到期时间；默认 90 天过期（`MOBILEAGENT_TOKEN_TTL_DAYS` 可调）。
  - `pair()` 限速锁定：同一来源连续 5 次失败、全局 20 次失败 → 锁定 15 分钟（HTTP 429 `locked`），锁定期间正确码也拒绝。
  - 新增 `authenticate / listDevices / revokeDevice / rotatePairingCode`。
  - 旧版 host.json 的单一共享 `token` 被丢弃，手机需重新配对（迁移说明）。
- `apps/bridge/src/main.ts`
  - `isLoopback` 在以下情况返回 false：远程模式；存在任一代理头（`x-forwarded-*`、`x-real-ip`、`forwarded`、`via`、`cf-connecting-ip` 等）；`Host` 不是回环名（防 DNS rebinding）。
  - CORS 不再回显任意来源：仅 `MOBILEAGENT_ORIGINS`（逗号分隔）+ 非远程模式下的回环/局域网/.local 页面；不在白名单且非同源的 `/api` 请求直接 403。
  - `/api/pair` 使用来源 IP 限速；新增 `GET /api/devices`、`DELETE /api/devices/:id`。
  - SSE 每 15 秒发送 `: ping` 心跳（`MOBILEAGENT_SSE_HEARTBEAT_MS` 可调）。
- `packages/protocol`：`DeviceView`、`HostView.remote`、`PairResult.device`。
- `apps/web`：设置页新增“已配对设备”列表与撤销（`components/devices-panel.tsx`），配对时上报设备名，i18n 中英文。
- `packages/agent-core/src/hub.test.ts`：新增 4 个测试（设备令牌/撤销/持久化、过期、限速锁定、远程模式）。

### 验证方法
```
npm install
npm test                 # 注意：若环境变量 DEEPSEEK_API_KEY 已设置，原有首个测试会失败（keySource 为 env，与本改动无关），测试前请临时 unset
npm run typecheck
# 手动：
MOBILEAGENT_REMOTE=1 MOBILEAGENT_PORT=47299 npx tsx apps/bridge/src/main.ts
curl -i http://127.0.0.1:47299/api/bootstrap     # 401
curl http://127.0.0.1:47299/api/host              # 无 pairingCode, remote:true
```
已实测：远程模式不带 token → 401；非远程模式回环 → 200，加 `X-Forwarded-For` → 401 且 /api/host 不返回配对码；连续错误配对第 6 次 → 429；恶意 Origin → 403；配对→列表→撤销→撤销后 401。

### 未完成/注意
- 远程模式下桌面本地 UI 也需要配对（不再免认证）；Electron 默认未启用远程模式。