/**
 * Shared domain types for packs, recipes, and the TV layout.
 *
 * JSON is untrusted until a validator in manifest.ts or recipes.ts says
 * otherwise. These interfaces describe the validated shapes.
 */

export type Variant = "windows" | "linux-proton" | "linux-native";

export interface PlatformProfile {
  dataDir?: string;
  saveDir?: string;
  exe?: string;
  gameProcess?: string;
  gameProcessAlt?: string;
  loader?: string;
  loaderSupport?: string;
  shortcut?: string;
  template?: string;
}

export type Platforms = Partial<Record<Variant, PlatformProfile>>;

export interface GameInfo {
  id: string;
  title?: string;
  store?: string;
  appId: number;
  installDir: string;
  exe?: string;
  linuxExe?: string;
  build?: string;
  version?: string;
  prefix?: boolean;
  native?: boolean;
  mode?: string;
}

export interface SteamGame {
  root: string;
  appId: number;
  library?: string | null;
  installDir?: string;
  exe?: string | null;
  build?: string | null;
  mode?: string;
  native?: boolean;
  prefix?: string | null;
  prefixReady?: boolean;
  platform?: NodeJS.Platform;
}

export type NoteTone = "info" | "warning" | "error" | "success";

export interface NoteObject {
  title?: string;
  body: string;
  tone?: NoteTone;
}

export type Note = string | NoteObject;

export interface NormalizedNote {
  title: string;
  body: string;
  tone: NoteTone;
}

export type CheckStatus = "pass" | "fail" | "unknown";

export interface PreconditionConfig {
  id: string;
  type: string;
  required?: boolean;
  title?: string;
  hint?: string;
  platforms?: Variant[];
  confirmable?: boolean;
  allowUnknown?: boolean;
  scope?: "home" | "game" | "tv" | "target";
  build?: string;
  bytes?: number;
  reserveBytes?: number;
  path?: string;
  paths?: string[];
  dlcAppId?: number;
  depotIds?: number[];
}

export interface CheckResult {
  id: string;
  type: string;
  title: string;
  hint: string;
  required: boolean;
  confirmable: boolean;
  status: CheckStatus;
  detail: string;
  blocked: boolean;
}

export interface PreconditionsResult {
  checks: CheckResult[];
  blocked: boolean;
  failedRequired: CheckResult[];
}

export interface LaunchInfo {
  type: string;
  exe?: string;
  gameProcess?: string;
  gameProcessAlt?: string;
  steamAppId?: number;
  mode?: "default" | "alternate-exe" | "loader";
  allowOverlay?: boolean;
}

export interface LoaderInfo {
  type?: string;
  profile?: string;
  saveFile?: string;
  options?: Record<string, unknown>;
}

export interface InstallInfo {
  type: string;
  label?: string;
}

export interface ArtInfo {
  grid?: string;
  hero?: string;
  logo?: string;
  icon?: string;
  header?: string;
  portrait?: string;
}

export interface ModInfo {
  id: string;
  version: string;
}

export interface ContentsItem {
  label: string;
  path?: string;
  active?: boolean;
  optional?: boolean;
}

export interface ContentsSummary {
  count: number;
  source?: string;
  generatedAt?: string;
  itemsLabel?: string;
  items?: ContentsItem[];
  inactive?: string[];
}

export interface Pack {
  schema: 1;
  id: string;
  /** Recipe that built this pack; set when the pack id differs from the recipe. */
  recipe?: string;
  name: string;
  description?: string;
  game: GameInfo;
  mod: ModInfo;
  launch: LaunchInfo;
  loader?: LoaderInfo;
  install?: InstallInfo;
  contents?: ContentsSummary;
  platforms?: Platforms;
  profilePattern?: string;
  art: ArtInfo;
  files: string;
  notes?: Note[];
  preconditions?: PreconditionConfig[];
}

export interface PackFile {
  source: string;
  target: string;
  size: number;
  sha256: string;
  mode?: string;
  platforms?: Variant[];
}

export interface FilesDoc {
  schema: 1;
  pack: string;
  version?: string;
  files: PackFile[];
}

export interface PackSummary {
  id: string;
  /** Recipe that built this pack, when it differs from the pack id. */
  recipe?: string;
  name: string;
  /** The name written by the pack builder; `name` may be a library rename. */
  baseName: string;
  description: string;
  game: GameInfo;
  platforms: Platforms | null;
  mod: ModInfo;
  launch: LaunchInfo;
  loader: LoaderInfo | null;
  install: InstallInfo | null;
  contents: ContentsSummary | null;
  art: ArtInfo;
  notes: Note[];
  preconditions: PreconditionConfig[];
  files: number;
  totalBytes: number;
  platformFiles: Record<Variant, number>;
  platformBytes: Record<Variant, number>;
}

export interface Recipe {
  schema: 1;
  id: string;
  game: string;
  name: string;
  modId: string;
  description?: string;
  artId?: string;
  saveFile?: string;
  version?: string;
  platforms?: Platforms;
  notes?: Note[];
  preconditions?: PreconditionConfig[];
}

export interface ResolvedTarget {
  variant: Variant;
  supported: boolean;
  profile: PlatformProfile;
  dataDir: string | null;
  saveDir: string | null;
  exe: string;
  gameProcess: string;
  gameProcessAlt: string;
  loader: string;
  loaderSupport: string;
  shortcut: string;
  template: string;
  error: string | null;
  processes: string[];
}

export interface Confirmations {
  [packId: string]: {
    [checkId: string]: { confirmedAt: string };
  };
}

export interface StorageVersion {
  version: string;
  bytes: number;
  current: boolean;
}

export interface PackStorage {
  id: string;
  name: string;
  modId: string;
  installed: boolean;
  currentVersion: string | null;
  totalBytes: number;
  versionsBytes: number;
  stagingBytes: number;
  backupBytes: number;
  oldBytes: number;
  otherBytes: number;
  versions: StorageVersion[];
}

export interface StorageReport {
  freeBytes: number | null;
  rootBytes: number;
  packsBytes: number;
  logsBytes: number;
  otherBytes: number;
  packs: PackStorage[];
}

export interface ClearPlan {
  ok: boolean;
  scope: string;
  packId?: string;
  actions: string[];
  errors: string[];
  warnings: string[];
  [key: string]: unknown;
}

export interface ClearResult {
  freedBytes: number;
  scope: string;
  packId?: string;
}

export interface AdapterPlan {
  ok: boolean;
  actions: string[];
  errors: string[];
  warnings: string[];
}

export interface PackAdapter {
  plan?: (options: { pack: Pack; root: string }) => AdapterPlan;
  revert?: (options: {
    pack: Pack;
    root: string;
    log: (message: string) => void;
    dryRun?: boolean;
  }) => unknown;
  apply?: (options: {
    pack: Pack;
    root: string;
    game: SteamGame | null | undefined;
    version: string;
    platform?: NodeJS.Platform;
    log: (message: string) => void;
  }) => unknown;
  rollback?: (options: {
    pack: Pack;
    root: string;
    version: string;
    log: (message: string) => void;
  }) => unknown;
}

export interface ContentsInput {
  recipe: Recipe;
  source: string;
  version: string;
}

export interface BuildProgress {
  phase: "copying" | "hashing" | "swapping" | "done" | string;
  done?: number;
  total?: number;
  bytesDone?: number;
  bytesTotal?: number;
}

export interface BuildOption {
  key: string;
  label: string;
  type: "directory" | "text";
  optional?: boolean;
  placeholder?: string;
  help?: string;
}

export interface BuildPackOptions {
  recipe: Recipe;
  source: string;
  out: string;
  link?: boolean;
  version?: string;
  driverOptions?: Record<string, unknown>;
  progress?: (update: BuildProgress) => void;
  log?: (message: string) => void;
}

export interface BuildPackResult {
  packRoot: string;
  pack: Pack;
  files: number;
  totalBytes: number;
}

/** Loader description written into an Infinity Engine snapshot archive. */
export interface InfinityLoaderManifest {
  type: string;
  exe: string;
  ini: string;
  gameExe: string;
  realExe: string;
  support: string;
  supportFiles: string[];
}

/** Contents of `modsync.json` inside an Infinity Engine snapshot archive. */
export interface InfinityManifest {
  schema: 1;
  game: string;
  build: string;
  version: string;
  language: string;
  source: "snapshot";
  override: string;
  root: string;
  meta: string;
  dialogs: string[];
  loader: InfinityLoaderManifest | null;
  basePrep: string[];
  weidu: { mods: number; components: number };
  selection: {
    included: number;
    bytes: number;
    modifiedBase: string[];
    warnings: string[];
  };
}

/** Applied state for the generic Infinity Engine install adapter. */
export interface InfinityApplied {
  packId: string;
  version: string;
  platform: string;
  gameRoot: string;
  overrideExisted: boolean;
  overrideBackup: string | null;
  files: string[];
  backups: string[];
  loader: {
    gameExe: string;
    realExe: string;
    wasLoader: boolean;
    createdReal: boolean;
    gameExeBackup: string | null;
  } | null;
  installedAt: string;
}
