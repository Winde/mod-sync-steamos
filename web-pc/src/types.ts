export type BindMode = "lan" | "loopback" | "host";
export type ToastTone = "neutral" | "success" | "error";

export interface ServerState {
  running: boolean;
  host: string;
  port: number;
  url: string;
  startedAt: string | null;
  error: string | null;
}

export interface SettingsState {
  version: number;
  packsDir: string;
  bind: BindMode | string;
  host: string;
  port: number;
  token: string;
  autoStart: boolean;
  launchAtLogin: boolean;
  working: Record<string, { source: string }>;
}

export interface PackState {
  valid: boolean;
  id: string;
  name: string;
  description: string;
  game: { id: string; title: string; appId: number | null; build: string; version: string };
  mod: { id: string; version: string };
  files: number;
  totalBytes: number;
  platforms: string[];
  root: string;
  modifiedAt: string;
  recipeId: string | null;
  artUrl: string;
  error: string | null;
}

export interface RecipeState {
  id: string;
  name: string;
  game: string;
  gameTitle: string;
  modId: string;
  description: string;
  version: string;
  source: string;
  out: string;
  packExists: boolean;
}

export interface BuildJobState {
  id: string;
  recipeId: string;
  packId: string;
  status: "running" | "done" | "error" | string;
  phase: string;
  percent: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  log: string[];
  result: { version: string; files: number; totalBytes: number } | null;
}

export interface LanAddress {
  name: string;
  address: string;
}

export interface ConsoleState {
  app: {
    version: string;
    packsDir: string;
    recipesDir: string;
    configFile: string;
    platform: string;
    tokenStorage: "protected" | "config";
    loginItem: { supported: boolean; error: string | null };
  };
  server: ServerState;
  settings: SettingsState;
  packs: PackState[];
  recipes: RecipeState[];
  lan: { detected: string; addresses: LanAddress[] };
  build: BuildJobState | null;
  guide: { installCommand: string; firewallCommand: string; installUrl: string };
}

export interface SettingsDraft {
  packsDir: string;
  bind: BindMode;
  host: string;
  port: string;
  token: string;
  autoStart: boolean;
  launchAtLogin: boolean;
}

export interface BuildFormState {
  recipeId: string;
  source: string;
  version: string;
  copy: boolean;
}

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

export interface DesktopBridge {
  pickFolder?(title?: string): Promise<string | null>;
}

export type ModalState = { kind: "build" } | { kind: "remove"; pack: PackState } | null;
