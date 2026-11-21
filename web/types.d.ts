/**
 * Browser-only view types. The agent API is JSON, so these describe the
 * payloads the renderer relies on; unknown extra fields are allowed.
 */

interface BrowserLabels {
  [key: string]: any;
}

interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  canInstall: boolean;
  error?: string;
}

interface ModsyncDesktop {
  version(): Promise<string>;
  checkUpdate(): Promise<UpdateInfo | null>;
  installUpdate(): Promise<void>;
  openReleases(): Promise<void>;
}

interface Window {
  MODSYNC_LABELS: BrowserLabels;
  modsyncDesktop?: ModsyncDesktop;
}

interface GameView {
  id: string;
  title?: string;
  version?: string;
  build?: string;
  appId?: number;
  [key: string]: unknown;
}

interface ModView {
  id: string;
  version: string;
}

interface NoteView {
  title?: string;
  body: string;
  tone?: string;
}

interface CheckView {
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

interface PreconditionsView {
  checks: CheckView[];
  blocked: boolean;
  failedRequired: CheckView[];
}

interface ContentsView {
  kind: string;
  count: number;
  source?: string;
  mods?: Array<{ name?: string; builtin?: boolean }>;
  packages?: Array<{ label?: string; path?: string }>;
  inactivePaks?: string[];
  [key: string]: unknown;
}

interface LaunchView {
  type?: string;
  mode?: string;
  exe?: string;
  gameProcess?: string;
  [key: string]: unknown;
}

interface LoaderView {
  type?: string;
  profile?: string;
}

interface InstallView {
  label?: string;
  type?: string;
}

interface PackView {
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

interface JobView {
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

interface AgentStateView {
  agent?: { version?: string; root?: string; port?: number };
  pc?: { url?: string; online?: boolean; error?: string | null };
  packs?: PackView[];
  diskFreeBytes?: number | null;
  job?: JobView | null;
}

interface StorageVersionView {
  version: string;
  bytes: number;
  current: boolean;
}

interface StoragePackView {
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

interface StorageView {
  loading?: boolean;
  error?: string;
  freeBytes?: number | null;
  rootBytes?: number;
  packsBytes?: number;
  logsBytes?: number;
  otherBytes?: number;
  packs?: StoragePackView[];
}

interface ConfirmView {
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

interface GameGroup {
  id: string;
  title: string;
  version: string;
  build: string;
  packs: PackView[];
}

interface WakeLockLike {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

interface AppState {
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
  wakeLock: WakeLockLike | null;
  rate: Array<{ t: number; b: number }>;
  polling: boolean;
  focusKey: string | null;
  lastRefresh: number;
}
