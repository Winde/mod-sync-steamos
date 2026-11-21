/** TV renderer view types. The agent API is JSON; extra fields are allowed. */

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  canInstall: boolean;
  error?: string;
}

export interface ModsyncDesktop {
  version(): Promise<string>;
  checkUpdate(): Promise<UpdateInfo | null>;
  installUpdate(): Promise<void>;
  openReleases(): Promise<void>;
  pickFolder?(title?: string): Promise<string | null>;
}

export interface GameView {
  id: string;
  title?: string;
  version?: string;
  build?: string;
  appId?: number;
  [key: string]: unknown;
}

export interface ModView {
  id: string;
  version: string;
}

export interface NoteView {
  title?: string;
  body: string;
  tone?: string;
}

export interface CheckView {
  id: string;
  type: string;
  title: string;
  hint?: string;
  required: boolean;
  confirmable: boolean;
  status: "pass" | "fail" | "unknown" | string;
  detail?: string;
  blocked: boolean;
}

export interface PreconditionsView {
  checks: CheckView[];
  blocked: boolean;
  failedRequired: CheckView[];
}

export interface ContentsItemView {
  label?: string;
  path?: string;
  active?: boolean;
  optional?: boolean;
}

export interface ContentsView {
  count: number;
  source?: string;
  generatedAt?: string;
  itemsLabel?: string;
  items?: ContentsItemView[];
  inactive?: string[];
}

export interface LaunchView {
  type?: string;
  mode?: string;
  exe?: string;
  gameProcess?: string;
  [key: string]: unknown;
}

export interface LoaderView {
  type?: string;
  profile?: string;
}

export interface InstallView {
  label?: string;
  type?: string;
}

export interface PackView {
  id: string;
  name: string;
  description?: string;
  game: GameView;
  mod: ModView;
  launch?: LaunchView;
  loader?: LoaderView | null;
  install?: InstallView | null;
  contents?: ContentsView | null;
  art?: { grid?: string; icon?: string; [key: string]: unknown } | null;
  notes?: Array<string | NoteView>;
  preconditions?: PreconditionsView | null;
  files?: number;
  totalBytes?: number;
  status?: string;
  installed?: boolean;
  installedVersion?: string | null;
  versions?: string[];
  canRollback?: boolean;
  staging?: boolean;
  local?: boolean;
  blocked?: boolean;
  platform?: { variant: string; supported: boolean; error: string | null };
  launcher?: string | null;
  desktopFile?: string | null;
  packRoot?: string;
  [key: string]: unknown;
}

export interface JobView {
  id?: string;
  packId?: string;
  status?: string;
  phase?: string;
  done?: number;
  total?: number;
  bytesDone?: number;
  bytesTotal?: number;
  error?: string | null;
  startedAt?: string | null;
  log?: string[];
  [key: string]: unknown;
}

export interface PairingView {
  status?: "idle" | "pending" | "approved" | "denied" | "error" | string;
  message?: string | null;
}

export interface AgentStateView {
  agent?: { version?: string; root?: string; port?: number };
  pc?: { url?: string; online?: boolean; error?: string | null; auth?: "ok" | "rejected" | "unknown" | "unconfigured" | string };
  pairing?: PairingView | null;
  packs?: PackView[];
  diskFreeBytes?: number | null;
  job?: JobView | null;
}

export interface StorageVersionView {
  version: string;
  bytes: number;
  current: boolean;
}

export interface StoragePackView {
  id: string;
  name: string;
  installed: boolean;
  currentVersion: string | null;
  totalBytes: number;
  oldBytes: number;
  otherBytes: number;
  stagingBytes: number;
  versions: StorageVersionView[];
}

export interface StorageView {
  loading?: boolean;
  error?: string;
  freeBytes?: number | null;
  rootBytes?: number;
  packsBytes?: number;
  logsBytes?: number;
  otherBytes?: number;
  packs?: StoragePackView[];
}

export interface ConfirmView {
  title: string;
  message: string;
  busy?: boolean;
  simple?: boolean;
  appUpdate?: boolean;
  packId?: string;
  storage?: { packId?: string; scope: string };
  details?: string[];
  detailsTitle?: string;
  warnings?: string[];
}

export interface GameGroup {
  id: string;
  title: string;
  version: string;
  build: string;
  packs: PackView[];
}

export interface WakeLockLike {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

export interface AppViewState {
  data: AgentStateView | null;
  selected: string | null;
  selectedGame: string | null;
  libraryView: "games" | "packs";
  view: "home" | "details" | "storage";
  job: JobView | null;
  error: string | null;
  offline: boolean;
  confirm: ConfirmView | null;
  details: { logs?: string } | null;
  download: { packId: string } | null;
  storage: StorageView | null;
  update: UpdateInfo | null;
}

declare global {
  interface Window {
    modsyncDesktop?: ModsyncDesktop;
  }
}
