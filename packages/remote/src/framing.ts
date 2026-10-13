/** PocketPilot GATT service. The phone writes RX; the PC notifies TX. */
export const BLE_IDS = {
  service: "f07c7a10-0001-4b8a-9c2d-706f636b6574",
  rx: "f07c7a10-0002-4b8a-9c2d-706f636b6574",
  tx: "f07c7a10-0003-4b8a-9c2d-706f636b6574",
} as const;

/** Default ATT payload before MTU negotiation (23 - 3). */
export const BLE_DEFAULT_PACKET = 20;
export const BLE_HEADER = 6;

/**
 * Split `data` into packets of at most `maxPacket` bytes.
 * Header: msgId uint16, index uint16, count uint16, then payload. BLE preserves order, but reassembly is by index anyway.
 */
export function splitMessage(msgId: number, data: Uint8Array, maxPacket: number): Uint8Array[] {
  const room = maxPacket - BLE_HEADER;
  if (room < 1) throw new Error("mtu too small");
  const count = Math.max(1, Math.ceil(data.length / room));
  if (count > 0xffff) throw new Error("message too large");
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    const slice = data.subarray(i * room, Math.min(data.length, (i + 1) * room));
    const packet = new Uint8Array(BLE_HEADER + slice.length);
    const view = new DataView(packet.buffer);
    view.setUint16(0, msgId & 0xffff);
    view.setUint16(2, i);
    view.setUint16(4, count);
    packet.set(slice, BLE_HEADER);
    out.push(packet);
  }
  return out;
}

interface PartialMessage {
  count: number;
  got: number;
  parts: Array<Uint8Array | undefined>;
}

export class PacketReassembler {
  private pending = new Map<number, PartialMessage>();

  push(packet: Uint8Array): Uint8Array | null {
    if (packet.byteLength < BLE_HEADER) return null;
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const id = view.getUint16(0);
    const index = view.getUint16(2);
    const count = view.getUint16(4);
    if (count === 0 || index >= count) return null;
    let entry = this.pending.get(id);
    if (!entry) {
      if (this.pending.size > 8) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      entry = { count, got: 0, parts: new Array(count) };
      this.pending.set(id, entry);
    }
    if (entry.count !== count || entry.parts[index]) return null;
    entry.parts[index] = packet.slice(BLE_HEADER);
    entry.got += 1;
    if (entry.got !== count) return null;
    return this.finish(id, entry);
  }

  reset(): void {
    this.pending.clear();
  }

  private finish(id: number, entry: PartialMessage): Uint8Array | null {
    this.pending.delete(id);
    const total = entry.parts.reduce((n, part) => n + (part?.byteLength ?? 0), 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of entry.parts) {
      if (!part) return null;
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }
}
