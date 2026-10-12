export type RemoteErrorCode = "signal" | "no-host" | "ice" | "closed" | "denied" | "expired";

export class RemoteError extends Error {
  readonly code: RemoteErrorCode;

  constructor(code: RemoteErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const ERROR_HINTS: Record<RemoteErrorCode, string> = {
  signal: "信令服务器不可达：手机连不上任何公共 MQTT 服务器（EMQX/HiveMQ/Mosquitto/Eclipse）。请检查手机网络后重试。",
  "no-host": "电脑没有响应：请确认电脑上的 PocketPilot 桌面程序正在运行、已开启“远程（RTC）”，并且电脑能上网。",
  ice: "已联系上电脑，但 P2P 打洞失败（双方可能处于对称 NAT / 严格防火墙 / 校园或公司网络，且没有 TURN 中继）。请连同一个 Wi-Fi，或换一个网络（手机热点、IPv6）再试。",
  closed: "连接已断开，请重试。",
  denied: "电脑拒绝了此次连接：该设备可能已被移除，请重新配对。",
  expired: "二维码已过期或已被使用，请在电脑上重新生成。",
};
