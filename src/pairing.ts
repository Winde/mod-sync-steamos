import crypto from "node:crypto";

/**
 * Pairing requests for the LAN pack server.
 *
 * The TV Client does not type the token. It asks the Server for access, the
 * Server console shows the request on the PC, and only an explicit approval
 * releases the current token. The request id is unguessable and the status
 * endpoint also checks the requester's address.
 */

export type PairingStatus = "pending" | "approved" | "denied" | "missing";

export interface PairRequestView {
  id: string;
  device: string;
  address: string;
  createdAt: string;
}

export interface PairingStore {
  request(input: { device?: unknown; address?: string }): { requestId: string; status: "pending" };
  status(id: string, address: string): { status: PairingStatus; token?: string };
  list(): PairRequestView[];
  approve(id: string): boolean;
  deny(id: string): boolean;
}

interface PairRecord {
  id: string;
  device: string;
  address: string;
  createdAt: number;
  status: "pending" | "approved" | "denied";
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;
const MAX_PENDING_PER_ADDRESS = 3;
const MAX_DEVICE_LENGTH = 64;

function cleanAddress(value: string | undefined): string {
  return String(value || "").replace(/^::ffff:/i, "");
}

function cleanDevice(value: unknown): string {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (text || "ModSync Client").slice(0, MAX_DEVICE_LENGTH);
}

export function createPairingStore({
  token,
  ttlMs = DEFAULT_TTL_MS,
}: {
  token: string;
  ttlMs?: number;
}): PairingStore {
  const requests = new Map<string, PairRecord>();
  const byAddress = new Map<string, string[]>();
  const attempts = new Map<string, number[]>();

  function prune(now = Date.now()): void {
    for (const [id, record] of requests) {
      if (now - record.createdAt <= ttlMs) continue;
      requests.delete(id);
      const ids = byAddress.get(record.address);
      if (!ids) continue;
      const next = ids.filter((entry) => entry !== id);
      if (next.length) byAddress.set(record.address, next);
      else byAddress.delete(record.address);
    }
    for (const [address, times] of attempts) {
      const next = times.filter((time) => now - time < RATE_WINDOW_MS);
      if (next.length) attempts.set(address, next);
      else attempts.delete(address);
    }
  }

  function pendingFor(address: string): PairRecord[] {
    return (byAddress.get(address) || [])
      .map((id) => requests.get(id))
      .filter((record): record is PairRecord => !!record && record.status === "pending");
  }

  function request({ device, address }: { device?: unknown; address?: string }): { requestId: string; status: "pending" } {
    const now = Date.now();
    prune(now);
    const from = cleanAddress(address);
    const recent = attempts.get(from) || [];
    if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
      throw new Error("Too many pairing requests. Try again in a minute.");
    }
    recent.push(now);
    attempts.set(from, recent);

    const deviceName = cleanDevice(device);
    const pending = pendingFor(from);
    const existing = pending.find((entry) => entry.device === deviceName);
    if (existing) return { requestId: existing.id, status: "pending" };
    if (pending.length >= MAX_PENDING_PER_ADDRESS) {
      throw new Error("Too many pending pairing requests.");
    }

    const record: PairRecord = {
      id: crypto.randomUUID(),
      device: deviceName,
      address: from,
      createdAt: now,
      status: "pending",
    };
    requests.set(record.id, record);
    const ids = byAddress.get(from) || [];
    ids.push(record.id);
    byAddress.set(from, ids);
    return { requestId: record.id, status: "pending" };
  }

  function status(id: string, address: string): { status: PairingStatus; token?: string } {
    prune();
    const record = requests.get(id);
    if (!record || cleanAddress(address) !== record.address) return { status: "missing" };
    if (record.status === "approved") return { status: "approved", token };
    if (record.status === "denied") return { status: "denied" };
    return { status: "pending" };
  }

  function list(): PairRequestView[] {
    prune();
    return [...requests.values()]
      .filter((record) => record.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => ({
        id: record.id,
        device: record.device,
        address: record.address,
        createdAt: new Date(record.createdAt).toISOString(),
      }));
  }

  function approve(id: string): boolean {
    prune();
    const record = requests.get(id);
    if (!record || record.status !== "pending") return false;
    record.status = "approved";
    return true;
  }

  function deny(id: string): boolean {
    prune();
    const record = requests.get(id);
    if (!record || record.status !== "pending") return false;
    record.status = "denied";
    return true;
  }

  return { request, status, list, approve, deny };
}
