import labels from "./labels";
import type { CheckView, ContentsView, GameGroup, JobView, PackView } from "./types";

export async function api<T extends object = Record<string, unknown>>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const text = await res.text();
  let data: { error?: string; raw?: string } = {};
  try {
    data = text ? JSON.parse(text) as typeof data : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data as T;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const messageOf = (err: unknown): string => err instanceof Error ? err.message : String(err);
export const pct = (a: number, b: number): number => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
export const gb = (n: number | null | undefined): string => ((n || 0) / 1024 / 1024 / 1024).toFixed(2);

export const fmtBytes = (n: unknown): string => {
  let v = Number(n) || 0;
  const units = labels.bytesUnits as string[];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};

export const fmtDuration = (sec: number | null | undefined): string => {
  if (sec == null || !Number.isFinite(sec)) return labels.durationDash;
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? labels.durationHours(h, m) : m ? labels.durationMinutes(m) : labels.durationSeconds(s);
};

export function art(p: PackView, key: string): string {
  return `/api/art/${encodeURIComponent(p.id)}/${key}`;
}

export function groupGames(packs: PackView[]): GameGroup[] {
  const map = new Map<string, GameGroup>();
  for (const p of packs) {
    const id = p.game?.id || p.id;
    if (!map.has(id)) {
      map.set(id, {
        id,
        title: p.game?.title || id,
        version: p.game?.version || "",
        build: p.game?.build || "",
        packs: [],
      });
    }
    map.get(id)!.packs.push(p);
  }
  return [...map.values()];
}

export function noteList(p: PackView): Array<{ title: string; body: string; tone: string }> {
  return (p.notes || []).map((n) => typeof n === "string"
    ? { body: n, tone: "info", title: "" }
    : { body: n.body, tone: n.tone || "info", title: n.title || "" })
    .filter((n) => n && n.body);
}

export function preconditionChecks(p: PackView): CheckView[] {
  return (p.preconditions && p.preconditions.checks) || [];
}

export function firstBlocker(p: PackView): CheckView | null {
  return preconditionChecks(p).find((c) => c.blocked) || null;
}

export function contentsCount(contents: ContentsView | null | undefined): string {
  if (!contents) return "";
  return contents.kind === "mods" ? labels.modsCount(contents.count) : labels.packagesCount(contents.count);
}

export function contentsNames(contents: ContentsView | null | undefined): string[] {
  if (!contents) return [];
  if (Array.isArray(contents.mods)) return contents.mods.map((m) => m.name).filter((name): name is string => !!name);
  if (Array.isArray(contents.packages)) return contents.packages.map((p) => p.label || p.path).filter((name): name is string => !!name);
  return [];
}

export function packContents(p: PackView): string {
  const base = labels.stats(gb(p.totalBytes), p.files);
  const contents = p.contents ? ` · ${contentsCount(p.contents)}` : "";
  const installed = p.install && p.install.label
    ? p.install.label
    : (p.loader && p.loader.type ? labels.loaderIncluded(p.loader.type) : "");
  return installed ? `${base}${contents} · ${installed}` : `${base}${contents}`;
}

export function packState(p: PackView | null): { title: string; detail: string; primary: { action: string; label: string } | null } {
  if (!p) return { title: labels.noPack, detail: "", primary: null };
  const state = p.status !== "up-to-date" && p.staging ? "staging" : p.status;
  switch (state) {
    case "up-to-date":
      return { title: labels.installed(p.installedVersion ?? null), detail: labels.upToDate, primary: { action: "launch", label: labels.play } };
    case "staging":
      return {
        title: p.installed ? labels.installed(p.installedVersion ?? null) : labels.downloadPaused,
        detail: p.installed ? labels.updatePaused(p.mod.version) : "",
        primary: { action: "download", label: labels.resumeInstall },
      };
    case "update-available":
      return {
        title: labels.installed(p.installedVersion ?? null),
        detail: labels.updateAvailable(p.mod.version),
        primary: { action: "download", label: labels.update },
      };
    case "not-installed":
    default:
      return { title: labels.readyToInstall, detail: "", primary: { action: "download", label: labels.install } };
  }
}

export function launchLabel(p: PackView): string {
  const launch = p.launch || {};
  if (launch.mode === "default") return labels.launchDefault;
  if (launch.mode === "alternate-exe") return labels.launchAlternate(launch.exe || labels.unknown);
  if (launch.mode === "loader") return labels.launchLoader((p.loader && p.loader.type) || launch.type || "loader");
  return launch.exe || labels.unknown;
}

export function rateInfo(job: JobView, rate: Array<{ t: number; b: number }>): { speed: number; eta: number | null } {
  const now = Date.now();
  const bytes = job.bytesDone || 0;
  rate.push({ t: now, b: bytes });
  while (rate.length > 2 && now - rate[0].t > 6000) rate.shift();
  const first = rate[0];
  const dt = (now - first.t) / 1000;
  const speed = dt > 0.5 ? (bytes - first.b) / dt : 0;
  const remain = (job.bytesTotal || 0) - bytes;
  return { speed, eta: speed > 0 && remain > 0 ? remain / speed : null };
}
