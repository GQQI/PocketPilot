# 远程配对（Remote Pairing）进度

分支：`feature/remote-pairing`（未改动 main）

## 阶段 1：安全加固（已完成）

### 改动清单
- `packages/agent-core/src/hub.ts`
  - 新增 `remote` 选项（默认读 `POCKETPILOT_REMOTE=1`）：远程模式下 `hostInfo` 永不返回配对码、loopback 视为未授权；每次配对成功/锁定后配对码自动轮换。
  - 令牌改为**按设备签发**：`mat_` + 32 字节随机，磁盘仅存 SHA-256；每设备有 id/名称/创建/最近活动/到期时间；默认 90 天过期（`POCKETPILOT_TOKEN_TTL_DAYS` 可调）。
  - `pair()` 限速锁定：同一来源连续 5 次失败、全局 20 次失败 → 锁定 15 分钟（HTTP 429 `locked`），锁定期间正确码也拒绝。
  - 新增 `authenticate / listDevices / revokeDevice / rotatePairingCode`。
  - 旧版 host.json 的单一共享 `token` 被丢弃，手机需重新配对（迁移说明）。
- `apps/bridge/src/main.ts`
  - `isLoopback` 在以下情况返回 false：远程模式；存在任一代理头（`x-forwarded-*`、`x-real-ip`、`forwarded`、`via`、`cf-connecting-ip` 等）；`Host` 不是回环名（防 DNS rebinding）。
  - CORS 不再回显任意来源：仅 `POCKETPILOT_ORIGINS`（逗号分隔）+ 非远程模式下的回环/局域网/.local 页面；不在白名单且非同源的 `/api` 请求直接 403。
  - `/api/pair` 使用来源 IP 限速；新增 `GET /api/devices`、`DELETE /api/devices/:id`。
  - SSE 每 15 秒发送 `: ping` 心跳（`POCKETPILOT_SSE_HEARTBEAT_MS` 可调）。
- `packages/protocol`：`DeviceView`、`HostView.remote`、`PairResult.device`。
- `apps/web`：设置页新增“已配对设备”列表与撤销（`components/devices-panel.tsx`），配对时上报设备名，i18n 中英文。
- `packages/agent-core/src/hub.test.ts`：新增 4 个测试（设备令牌/撤销/持久化、过期、限速锁定、远程模式）。

### 验证方法
```
npm install
npm test                 # 注意：若环境变量 DEEPSEEK_API_KEY 已设置，原有首个测试会失败（keySource 为 env，与本改动无关），测试前请临时 unset
npm run typecheck
# 手动：
POCKETPILOT_REMOTE=1 POCKETPILOT_PORT=47299 npx tsx apps/bridge/src/main.ts
curl -i http://127.0.0.1:47299/api/bootstrap     # 401
curl http://127.0.0.1:47299/api/host              # 无 pairingCode, remote:true
```
已实测：远程模式不带 token → 401；非远程模式回环 → 200，加 `X-Forwarded-For` → 401 且 /api/host 不返回配对码；连续错误配对第 6 次 → 429；恶意 Origin → 403；配对→列表→撤销→撤销后 401。

### 未完成/注意
- 远程模式下桌面本地 UI 也需要配对（不再免认证）；Electron 默认未启用远程模式。

## 阶段 2+3：二维码配对 + WebRTC 数据通道（已完成，见“未完成/风险”）

### 架构
```
手机 PWA ──(加密信令, 公共 MQTT wss, 多 broker 并发)── 电脑 bridge
   └────────── WebRTC DataChannel（P2P，STUN 打洞）──────────┘
        帧：req / res / chunk / end / err / abort / ping（AES-GCM 端到端加密）
        电脑把帧交给 app.fetch（无 socket ⇒ 永远非回环 ⇒ 必须带设备 token）
```
- 二维码内容：`<PWA地址>/#pair=<会话ID>.<32字节随机密钥>`。密钥在 URL **fragment**，不会发给任何网页服务器；5 分钟有效、一次性（首次 hello 后作废）。
- 密钥派生（WebCrypto）：HKDF(密钥, "pocketpilot/v1/<sid>") → MQTT 主题（随机且只有持密钥者能算出）+ 信令 AES-GCM 密钥；每次连接双方生成临时 ECDH P-256，公钥放在加密信令里（持密钥才能伪造）；会话密钥 = HKDF(ECDH 共享秘密, salt=SHA256(密钥‖sid), info=方向‖双方公钥)，两个方向独立密钥，帧 IV=递增计数器（防重放）。
- 配对成功后电脑下发：设备 token + 持久 `linkSecret`；之后手机凭 linkSecret 重连（主题/信令密钥由 linkSecret 派生），无需再扫码；撤销设备即退订并断开该连接。
- 信令 broker：EMQX、HiveMQ、Mosquitto、Eclipse 的 wss 地址同时连接、同时发布，任一可用即可（`POCKETPILOT_BROKERS` 可覆盖）。STUN：Google ×2、Cloudflare、Twilio（`POCKETPILOT_STUN` 可覆盖）。
- 打洞失败/无响应/信令不可达都会抛出带中文提示的 `RemoteError`（code: signal / no-host / ice / closed / expired）。
- SSE 响应经数据通道以 chunk 帧流式返回，web 端 `api.ts` 仅把 `fetch` 换成 `transport()`，其余代码不变。

### 改动清单
- 新包 `packages/remote`：`crypto.ts`、`frames.ts`（加密+分片+背压）、`signaling.ts`（MqttBus/MemoryBus）、`host.ts`（RemoteHost）、`client.ts`（RemoteClient）、`errors.ts`、`remote.test.ts`。
- `packages/agent-core/src/hub.ts`：`grantDevice`（无配对码发令牌，仅供已证明持有一次性密钥的 QR 流程）、`deviceLinks`、`setDevicesListener`、设备 `linkSecret`。
- `apps/bridge/src/remote.ts`（新）+ `main.ts`：`POCKETPILOT_RTC=1` 启用；启动时终端打印二维码；`POST /api/remote/session`（需认证）返回二维码 SVG；rtc 请求按连接 id 限速。`package.json` 构建把 `node-datachannel` 设为 external。
- `apps/web`：`lib/rtc.ts`、`components/remote-pair.tsx`（设置页“生成二维码 / 扫码配对 / 粘贴链接”，`#pair=` 落地页，jsQR 摄像头扫码）、`api.ts`（transport 切换、`adoptToken`）、`App.tsx`、i18n。

### 运行与验证
```
npm install
# 电脑端（建议同时开远程模式）：
POCKETPILOT_RTC=1 POCKETPILOT_REMOTE=1 npm run host      # 终端显示二维码；设置页也可“生成二维码”
# 手机：系统相机扫码打开链接，或在 PWA 设置页点“扫码配对”
npm test            # agent-core 5 项 + remote 3 项
npm run typecheck && npm run build
```
- `packages/remote` 测试覆盖：信令加密（错密钥/篡改/换主题均失败）、ECDH 方向密钥与重放拒绝、完整 QR 配对 → link 重连 → 请求/401/大请求体/300KB 响应/SSE 流/非 /api 路径拒绝/二维码一次性/撤销后无法重连（WebRTC 用 node-datachannel 真实数据通道）。
- 已在 Linux 沙箱跑通上述全部测试、typecheck、web+bridge build；在用户 Windows 上验证了：真实公共 MQTT broker（EMQX、HiveMQ）收发成功、bridge 启动打印二维码、`/api/remote/session` 无 token → 401。

### 未完成 / 风险
1. **PWA 托管**：手机在外网时打不开电脑上的 PWA。需把 `apps/web/dist` 部署到免费静态托管（GitHub Pages/Cloudflare Pages/Netlify），并用 `POCKETPILOT_PWA_URL=https://xxx` 让二维码指向它（密钥在 fragment，托管方看不到）。PWA 本身是静态页面，API 仍走 P2P。未做该部署与 Pages 的 base path 适配。
2. **无 TURN**：免费公共 TURN 不可靠，对称型 NAT/部分运营商 CGNAT 打洞会失败（会给出明确提示，无自动中继回退）。
3. **未在真实手机 + 跨网络上端到端实测**。在用户 Windows 机器上，同进程两个 node-datachannel 端点互连失败（疑似本机虚拟网卡/环境问题，同样代码在 Linux 通过），所以 WebRTC 部分的自动化测试只在 Linux 通过；请用真机验证。
4. 浏览器端 `mqtt` + WebRTC 的打包已 build 通过，但未在真机浏览器/iOS Safari 运行验证；iOS 摄像头扫码需 HTTPS（托管在 Pages 满足；LAN http 页面无法调用摄像头，可用系统相机扫码或粘贴链接）。
5. Electron 桌面打包需把 `node-datachannel` 原生模块随 `resources` 一起发布（`electron-builder.yml` 未改）；缺失时 bridge 会打印 “remote disabled” 并正常运行。
6. `linkSecret` 以明文存于 host.json（0600，同 API key 的处理方式）；公共 broker 可看到加密后的信令元数据（主题、时间、大小），无法解密。
7. 远程模式下桌面本地 UI 也需配对；Electron 默认未设置 `POCKETPILOT_RTC/REMOTE`。