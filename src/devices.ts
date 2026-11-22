import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJson } from "./util";

/**
 * Paired-device credentials for the LAN pack server.
 *
 * A device token is issued once, when the Server console approves the TV. The
 * store keeps only its SHA-256 hash. The legacy shared token stays accepted so
 * an already-installed Client keeps working; those clients are identified by a
 * stable device id when they send one, or by their address when they do not.
 */

export interface DeviceRecord {
  id: string;
  name: string;
  address: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** SHA-256 of the device token; empty for a legacy client. */
  tokenHash: string;
  deviceId: string | null;
  /** Hash of the legacy token and this client's identity. */
  legacyKey: string | null;
  legacy: boolean;
}

export interface DeviceView {
  id: string;
  name: string;
  address: string;
  createdAt: string;
  lastSeenAt: string | null;
  legacy: boolean;
}

export interface DeviceAuthInput {
  address?: string;
  deviceId?: string | null;
  name?: string | null;
}

export interface DeviceStore {
  issue(input: { name?: unknown; address?: string; deviceId?: string | null }): { device: DeviceView; token: string };
  authorize(token: string, input: DeviceAuthInput): DeviceView | null;
  list(): DeviceView[];
  revoke(id: string): boolean;
  revokeAll(): number;
  setLegacyToken(token: string): void;
}

const MAX_NAME = 64;
const MAX_DEVICE_ID = 128;
const LAST_SEEN_WRITE_MS = 30_000;
const TOKEN_PREFIX = "ms_";

function cleanAddress(value: unknown): string {
  return String(value || "").replace(/^::ffff:/i, "");
}

function cleanName(value: unknown, fallback: string): string {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (text || fallback).slice(0, MAX_NAME);
}

function cleanDeviceId(value: unknown): string | null {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return text ? text.slice(0, MAX_DEVICE_ID) : null;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

function view(record: DeviceRecord): DeviceView {
  return {
    id: record.id,
    name: record.name,
    address: record.address,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    legacy: record.legacy,
  };
}

function normalizeRecord(raw: unknown): DeviceRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : "";
  const tokenHash = typeof value.tokenHash === "string" ? value.tokenHash : "";
  const legacyKey = typeof value.legacyKey === "string" ? value.legacyKey : null;
  const legacy = value.legacy === true;
  if (!id) return null;
  if (legacy ? !legacyKey : !/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  return {
    id,
    name: cleanName(value.name, "ModSync Client"),
    address: cleanAddress(value.address),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : null,
    tokenHash,
    deviceId: cleanDeviceId(value.deviceId),
    legacyKey,
    legacy,
  };
}

export function createDeviceStore({ file, legacyToken }: { file: string; legacyToken: string }): DeviceStore {
  const records = new Map<string, DeviceRecord>();
  const byToken = new Map<string, string>();
  const revokedLegacy = new Set<string>();
  let currentLegacy = String(legacyToken || "").trim();
  let lastSeenWrite = 0;

  if (fs.existsSync(file)) {
    try {
      const data = readJson<Record<string, unknown>>(file);
      if (Array.isArray(data.devices)) {
        for (const entry of data.devices) {
          const record = normalizeRecord(entry);
          if (!record) continue;
          records.set(record.id, record);
          if (record.tokenHash) byToken.set(record.tokenHash, record.id);
        }
      }
      if (Array.isArray(data.revokedLegacy)) {
        for (const key of data.revokedLegacy) {
          if (typeof key === "string" && /^[0-9a-f]{64}$/.test(key)) revokedLegacy.add(key);
        }
      }
    } catch { /* a broken device file must not block the Server */ }
  }

  function persist(): void {
    ensureDir(path.dirname(file));
    const payload = {
      schema: 1,
      devices: [...records.values()],
      revokedLegacy: [...revokedLegacy],
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows uses the user profile ACL */ }
    lastSeenWrite = Date.now();
  }

  function touch(record: DeviceRecord, input: DeviceAuthInput): void {
    record.lastSeenAt = new Date().toISOString();
    if (input.address) record.address = cleanAddress(input.address);
    // The pairing request names a paired device. Legacy clients only have the
    // name their requests carry.
    if (record.legacy && input.name) record.name = cleanName(input.name, record.name);
    if (Date.now() - lastSeenWrite > LAST_SEEN_WRITE_MS) persist();
  }

  function registerLegacy(input: DeviceAuthInput): DeviceView | null {
    const address = cleanAddress(input.address);
    const deviceId = cleanDeviceId(input.deviceId);
    if (!address && !deviceId) return null;
    const identity = deviceId ? `id:${deviceId}` : `ip:${address}`;
    const key = hash(`${currentLegacy}\0${identity}`);
    if (revokedLegacy.has(key)) return null;

    let record = [...records.values()].find((entry) => entry.legacy && entry.legacyKey === key) || null;
    let changed = false;
    if (!record && deviceId) {
      // An old Client connected by address before it learned to send a device
      // id. Adopt that record instead of listing the same TV twice.
      record = [...records.values()].find((entry) => entry.legacy && !entry.deviceId && entry.address === address) || null;
      if (record) {
        record.deviceId = deviceId;
        record.legacyKey = key;
        changed = true;
      }
    }
    if (!record) {
      record = {
        id: crypto.randomUUID(),
        name: cleanName(input.name, `Legacy client ${address || "unknown"}`),
        address,
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
        tokenHash: "",
        deviceId,
        legacyKey: key,
        legacy: true,
      };
      records.set(record.id, record);
      persist();
    } else {
      touch(record, input);
      if (changed) persist();
    }
    return view(record);
  }

  function issue(input: { name?: unknown; address?: string; deviceId?: string | null }): { device: DeviceView; token: string } {
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    const tokenHash = hash(token);
    const deviceId = cleanDeviceId(input.deviceId);
    const existing = deviceId
      ? [...records.values()].find((entry) => !entry.legacy && entry.deviceId === deviceId)
      : null;
    if (existing) {
      // Re-pairing the same installation replaces its old token instead of
      // leaving a duplicate device behind.
      if (existing.tokenHash) byToken.delete(existing.tokenHash);
      existing.name = cleanName(input.name, existing.name);
      existing.address = cleanAddress(input.address);
      existing.tokenHash = tokenHash;
      byToken.set(tokenHash, existing.id);
      persist();
      return { device: view(existing), token };
    }
    const record: DeviceRecord = {
      id: crypto.randomUUID(),
      name: cleanName(input.name, "ModSync Client"),
      address: cleanAddress(input.address),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      tokenHash,
      deviceId,
      legacyKey: null,
      legacy: false,
    };
    records.set(record.id, record);
    byToken.set(tokenHash, record.id);
    persist();
    return { device: view(record), token };
  }

  function authorize(token: string, input: DeviceAuthInput): DeviceView | null {
    const value = String(token || "");
    if (!value) return null;
    const tokenHash = hash(value);
    const id = byToken.get(tokenHash);
    if (id) {
      const record = records.get(id);
      if (!record) return null;
      touch(record, input);
      return view(record);
    }
    if (currentLegacy && safeEqual(value, currentLegacy)) return registerLegacy(input);
    return null;
  }

  function list(): DeviceView[] {
    return [...records.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(view);
  }

  function revoke(id: string): boolean {
    const record = records.get(id);
    if (!record) return false;
    if (record.legacyKey) revokedLegacy.add(record.legacyKey);
    if (record.tokenHash) byToken.delete(record.tokenHash);
    records.delete(id);
    persist();
    return true;
  }

  function revokeAll(): number {
    for (const record of records.values()) {
      if (record.legacyKey) revokedLegacy.add(record.legacyKey);
    }
    const count = records.size;
    records.clear();
    byToken.clear();
    persist();
    return count;
  }

  function setLegacyToken(token: string): void {
    const next = String(token || "").trim();
    if (next === currentLegacy) return;
    currentLegacy = next;
    // Rotating the manual token revokes legacy clients. Paired device tokens
    // stay valid. Old legacy keys include the old token, so they are useless.
    for (const record of [...records.values()]) {
      if (!record.legacy) continue;
      records.delete(record.id);
    }
    revokedLegacy.clear();
    persist();
  }

  return { issue, authorize, list, revoke, revokeAll, setLegacyToken };
}
