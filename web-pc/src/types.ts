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
  minimizeToTray: boolean;
  working: Record<string, { source: string }>;
}

export interface ContentsItemState {
  label: string;
  path?: string;
  active?: boolean;
  optional?: boolean;
}

export interface ContentsState {
  count: number;
  source?: string;
  generatedAt?: string;
  itemsLabel?: string;
  items?: ContentsItemState[];
  inactive?: string[];
}

export interface ModReviewState {
  gameId: string;
  modId: string;
  rating: number;
  body: string;
  updatedAt: string;
}

export interface PackState {
  valid: boolean;
  id: string;
  name: string;
  baseName?: string;
  description: string;
  game: { id: string; title: string; appId: number | null; build: string; version: string };
  mod: { id: string; version: string };
  files: number;
  totalBytes: number;
  contents: ContentsState | null;
  platforms: string[];
  root: string;
  modifiedAt: string;
  recipeId: string | null;
  artUrl: string;
  artCustom?: boolean;
  notes?: string;
  review?: ModReviewState | null;
  error: string | null;
}

export interface BuildOptionView {
  key: string;
  label: string;
  type: "directory" | "text" | string;
  optional?: boolean;
  placeholder?: string;
  help?: string;
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
  buildOptions: BuildOptionView[];
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

export interface PairRequestState {
  id: string;
  device: string;
  address: string;
  createdAt: string;
}

export interface DeviceState {
  id: string;
  name: string;
  address: string;
  createdAt: string;
  lastSeenAt: string | null;
  legacy: boolean;
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
  pairRequests: PairRequestState[];
  devices: DeviceState[];
  guide: {
    installCommand: string;
    manualInstallCommand: string;
    firewallCommand: string;
    installUrl: string;
  };
}

export interface SettingsDraft {
  packsDir: string;
  bind: BindMode;
  host: string;
  port: string;
  token: string;
  autoStart: boolean;
  launchAtLogin: boolean;
  minimizeToTray: boolean;
}

export interface BuildFormState {
  recipeId: string;
  source: string;
  version: string;
  copy: boolean;
  driverOptions: Record<string, string>;
  /** Pack folder to rebuild; defaults to the recipe's own pack. */
  packId?: string;
}

export interface BuildStartOptions {
  packId?: string;
  createNew?: boolean;
  packName?: string;
}

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  canInstall: boolean;
  error?: string;
}

export type UpdatePhase = "download" | "verify" | "install";

export interface UpdateProgress {
  phase: UpdatePhase;
  received: number;
  total: number | null;
}

export interface DesktopBridge {
  pickFolder?(title?: string): Promise<string | null>;
  pickImage?(title?: string): Promise<string | null>;
  checkUpdate?(): Promise<UpdateInfo | null>;
  installUpdate?(): Promise<void>;
  onUpdateProgress?(callback: (progress: UpdateProgress) => void): () => void;
  openReleases?(): Promise<void>;
}

export type ModalState =
  | { kind: "build" }
  | { kind: "remove"; pack: PackState }
  | { kind: "edit"; pack: PackState }
  | null;
