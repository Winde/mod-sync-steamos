import type { DesktopBridge } from "./types";

export async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) throw new Error(String(data.error || `${response.status} ${response.statusText}`));
  return data as T;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatBytes(value: unknown): string {
  let n = Number(value) || 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function platformName(value: string): string {
  if (value === "windows") return "Windows";
  if (value === "linux-proton") return "Proton";
  if (value === "linux-native") return "Linux";
  return value;
}

export function randomToken(length = 20): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => chars[byte % chars.length]).join("");
}

export function desktopBridge(): DesktopBridge | null {
  return (window as Window & { modsyncDesktop?: DesktopBridge }).modsyncDesktop || null;
}

export function maskToken(text: string, token: string): string {
  return token ? text.split(token).join("••••••••") : text;
}

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}
