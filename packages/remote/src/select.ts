/** Priority for automatic selection: same LAN, then the encrypted remote channel, then nearby Bluetooth. */
export const TRANSPORT_KINDS = ["lan", "rtc", "ble"] as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export interface TransportPolicy {
  mode: "auto" | TransportKind;
  enabled: Record<TransportKind, boolean>;
}

export function normalizePolicy(input: unknown): TransportPolicy {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<TransportPolicy>;
  const mode = raw.mode === "lan" || raw.mode === "rtc" || raw.mode === "ble" ? raw.mode : "auto";
  const enabled: Partial<Record<TransportKind, boolean>> = raw.enabled ?? {};
  return {
    mode,
    enabled: {
      lan: enabled.lan !== false,
      rtc: enabled.rtc !== false,
      ble: enabled.ble !== false,
    },
  };
}

/**
 * Next kind to attempt. A manual mode never falls through to a different kind,
 * and a kind the user switched off is skipped.
 */
export function nextCandidate(policy: TransportPolicy, tried: readonly TransportKind[]): TransportKind | null {
  const order: readonly TransportKind[] = policy.mode === "auto" ? TRANSPORT_KINDS : [policy.mode];
  for (const kind of order) {
    if (!policy.enabled[kind] || tried.includes(kind)) continue;
    return kind;
  }
  return null;
}

/** Walks `nextCandidate` until one connect succeeds. Manual failure does not try the others. */
export async function connectByPolicy(
  policy: TransportPolicy,
  tryConnect: (kind: TransportKind) => Promise<boolean>,
): Promise<TransportKind | null> {
  const tried: TransportKind[] = [];
  for (;;) {
    const kind = nextCandidate(policy, tried);
    if (!kind) return null;
    tried.push(kind);
    let ok = false;
    try {
      ok = await tryConnect(kind);
    } catch {
      ok = false;
    }
    if (ok) return kind;
    if (policy.mode !== "auto") return null;
  }
}
