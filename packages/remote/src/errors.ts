export type RemoteErrorCode = "signal" | "no-host" | "ice" | "closed" | "denied" | "expired";

export class RemoteError extends Error {
  readonly code: RemoteErrorCode;

  constructor(code: RemoteErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const ERROR_HINTS: Record<RemoteErrorCode, string> = {
  signal: "无法连接任何公共 MQTT 信令服务器（EMQX/HiveMQ/Mosquitto/Eclipse 均不可达），请检查手机网络或稍后重试。",
  "no-host": "电脑没有响应：请确认电脑上的 PocketPilot 正在运行且已启用远程模式（POCKETPILOT_RTC=1），并且电脑能访问互联网。",
  ice: "P2P 打洞失败：双方可能处于对称型 NAT / 严格防火墙 / 校园或公司网络（免费方案没有 TURN 中继）。请改用同一 Wi-Fi，或让其中一方换用手机热点、IPv6，再重试。",
  closed: "连接已断开，请重试。",
  denied: "电脑拒绝了此次配对（二维码已被使用或已撤销）。",
  expired: "二维码已过期或已被使用，请在电脑上重新生成。",
};