import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import labels from "./labels";
import {
  art,
  contentsCount,
  contentsHeading,
  contentsInactive,
  contentsNames,
  firstBlocker,
  fmtBytes,
  fmtDuration,
  gb,
  launchLabel,
  noteList,
  packContents,
  packState,
  preconditionChecks,
} from "./api";
import type {
  AgentStateView,
  CheckView,
  ConfirmView,
  GameGroup,
  JobView,
  PairingView,
  PackView,
  StorageView,
} from "./types";

function ArtImage({ src, fallback }: { src: string; fallback: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return failed ? <div className="ph">{fallback}</div> : <img src={src} alt="" onError={() => setFailed(true)} />;
}

export function Notes({ pack }: { pack: PackView }) {
  const notes = noteList(pack);
  if (!notes.length) return null;
  return (
    <div className="notes">
      {notes.map((note, index) => (
        <div key={`${note.title}-${index}`} className={`noteitem ${note.tone || "info"}`}>
          {note.title ? <b>{note.title}</b> : null}
          <div>{note.body}</div>
        </div>
      ))}
    </div>
  );
}

export function Checks({ pack, allowConfirm, onConfirm }: {
  pack: PackView;
  allowConfirm: boolean;
  onConfirm: (packId: string, checkId: string) => void;
}) {
  const checks = preconditionChecks(pack);
  if (!checks.length) return null;
  return (
    <div className="checks">
      {checks.map((check: CheckView) => (
        <div key={check.id} className={`check ${check.status}`}>
          <span className="dot" />
          <div className="ctext">
            <b>{check.title}</b>
            <div className="cdetail">{check.detail || ""}</div>
            {check.hint ? <div className="chint">{check.hint}</div> : null}
          </div>
          {allowConfirm && check.confirmable && check.status !== "pass" ? (
            <button
              className="btn ghost small"
              data-action="confirm-check"
              data-pack={pack.id}
              data-check={check.id}
              data-focusable
              onClick={() => onConfirm(pack.id, check.id)}
            >
              {labels.confirm}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function Library({ data, groups, selectedGame, selected, libraryView, onOpenGame, onSelectPack, onAllGames, onStorage, onPair }: {
  data: AgentStateView | null;
  groups: GameGroup[];
  selectedGame: string | null;
  selected: string | null;
  libraryView: "games" | "packs";
  onOpenGame: (id: string) => void;
  onSelectPack: (id: string) => void;
  onAllGames: () => void;
  onStorage: () => void;
  onPair: () => void;
}) {
  if (!groups.length) return null;
  if (libraryView === "games") {
    const installedCount = groups.reduce((n, game) => n + game.packs.filter((p) => p.installed).length, 0);
    const offline = data?.pc?.online === false;
    const free = data?.diskFreeBytes;
    return (
      <>
        <div className="libtitle">{labels.games}</div>
        {groups.map((group) => {
          const pack = group.packs[0];
          const installed = group.packs.filter((p) => p.installed).length;
          return (
            <button
              key={group.id}
              className={`tile${group.id === selectedGame ? " sel" : ""}`}
              data-game={group.id}
              data-focusable
              data-key={`game-${group.id}`}
              onClick={() => onOpenGame(group.id)}
            >
              <div className="art">
                {pack && pack.art && pack.art.grid
                  ? <ArtImage src={art(pack, "grid")} fallback={group.title.slice(0, 3).toUpperCase()} />
                  : <div className="ph">{group.title.slice(0, 3).toUpperCase()}</div>}
              </div>
              <div className="txt">
                <div className="name">{group.title}</div>
                <div className="sub">{labels.packLine(group.packs.length, installed)}</div>
              </div>
            </button>
          );
        })}
        <div className="sidecard">
          <div className="libtitle">{labels.thisTv}</div>
          <div className="meta">
            {labels.packsInstalled(installedCount)}{free != null ? ` · ${labels.freeWithGb(gb(free))}` : ""}
          </div>
          <div className="actions">
            <button className="btn ghost small" data-action="storage" data-focusable data-key="side-storage" onClick={onStorage}>
              {labels.manageStorage}
            </button>
          </div>
        </div>
        {offline ? (
          <div className="sidecard">
            <div className="libtitle">{data?.pc?.auth === "rejected" ? labels.pairTitle : labels.pcOfflineTitle}</div>
            <div className="meta">{data?.pc?.auth === "rejected" ? labels.pairSideBody : labels.pcOfflineBody}</div>
            {data?.pc?.auth === "rejected" ? (
              data?.pairing?.status === "pending" || data?.pairing?.status === "approved"
                ? <div className="meta">{data.pairing?.status === "approved" ? labels.pairApproved : labels.pairPending}</div>
                : (
                  <div className="actions">
                    <button className="btn ghost small" data-action="pair" data-focusable data-key="side-pair" onClick={onPair}>
                      {data?.pairing?.status === "idle" ? labels.pairAction : labels.pairAgain}
                    </button>
                  </div>
                )
            ) : null}
          </div>
        ) : null}
      </>
    );
  }

  const game = groups.find((entry) => entry.id === selectedGame) || groups[0];
  if (!game) return null;
  return (
    <>
      <div className="libhead">
        <div className="libtitle">{game.title}</div>
        <button className="linkbtn" data-action="all-games" data-focusable data-key="all-games" onClick={onAllGames}>
          {labels.allGames}
        </button>
      </div>
      {game.packs.map((pack) => (
        <button
          key={pack.id}
          className={`tile${pack.id === selected ? " sel" : ""}`}
          data-select={pack.id}
          data-focusable
          data-key={`tile-${pack.id}`}
          onClick={() => onSelectPack(pack.id)}
        >
          <div className="art">
            {pack.art && pack.art.grid
              ? <ArtImage src={art(pack, "grid")} fallback={pack.name.slice(0, 3).toUpperCase()} />
              : <div className="ph">{pack.name.slice(0, 3).toUpperCase()}</div>}
          </div>
          <div className="txt">
            <div className="name">{pack.name}</div>
            <div className="sub">{pack.installed ? labels.installed(pack.installedVersion ?? null) : labels.notInstalled}</div>
          </div>
        </button>
      ))}
    </>
  );
}

export function Hero({ pack, offline, onAction, onDetails, onLaunch, onRollback, onUninstall, onRefresh }: {
  pack: PackView;
  offline: boolean;
  onAction: (action: string, packId: string) => void;
  onDetails: () => void;
  onLaunch: () => void;
  onRollback: () => void;
  onUninstall: () => void;
  onRefresh: () => void;
}) {
  const status = packState(pack);
  const blocker = firstBlocker(pack);
  const canAct = !blocker;
  const installed = pack.installed;
  const stateText = !installed ? null : offline ? labels.pcOfflineCheck : status.detail;
  const updateAvailable = pack.status === "update-available" && installed;
  return (
    <section className="hero">
      <div className="poster">
        {pack.art && pack.art.grid
          ? <ArtImage src={art(pack, "grid")} fallback={pack.name.slice(0, 3).toUpperCase()} />
          : <div className="ph">{pack.name.slice(0, 3).toUpperCase()}</div>}
      </div>
      <div className="info">
        <div className="kicker">{labels.kicker(pack.game.title || "", pack.name)}</div>
        <h1>{pack.name}</h1>
        <div className="bigstatus">{status.title}</div>
        <div className="meta">
          {stateText ? `${stateText} · ` : ""}{pack.game.title} {pack.game.version || ""} · {labels.buildLabel} {pack.game.build || ""}
        </div>
        {blocker ? (
          <div className="callout error">
            <b>{blocker.title}</b> — {blocker.detail}{blocker.hint ? ` ${blocker.hint}` : ""}
            {(pack.preconditions?.failedRequired?.length || 0) > 1 ? labels.moreChecks((pack.preconditions?.failedRequired?.length || 0) - 1) : ""}
          </div>
        ) : null}
        <div className="actions">
          {status.primary ? (
            <button
              className="btn primary"
              data-action={status.primary.action}
              data-pack={pack.id}
              disabled={!canAct}
              data-autofocus
              data-focusable
              data-key="primary"
              onClick={() => onAction(status.primary!.action, pack.id)}
            >
              {status.primary.label}
            </button>
          ) : null}
          {updateAvailable ? (
            <button className="btn" data-action="launch" data-pack={pack.id} disabled={!canAct} data-focusable data-key="play" onClick={onLaunch}>
              {labels.playVersion(pack.installedVersion ?? null)}
            </button>
          ) : null}
          <button className="btn ghost" data-action="details" data-pack={pack.id} data-focusable data-key="details" onClick={onDetails}>
            {labels.details}
          </button>
          {pack.canRollback ? (
            <button className="btn ghost" data-action="rollback" data-pack={pack.id} data-focusable data-key="rollback" onClick={onRollback}>
              {labels.rollBack}
            </button>
          ) : null}
          {pack.local ? (
            <button className="btn ghost" data-action="uninstall" data-pack={pack.id} data-focusable data-key="uninstall" onClick={onUninstall}>
              {labels.uninstall}
            </button>
          ) : null}
          <button className="btn ghost" data-action="retry" data-focusable data-key="refresh" onClick={onRefresh}>
            {labels.refresh}
          </button>
        </div>
        <div className="hint">{installed ? labels.savesHintVanilla : packContents(pack)}</div>
      </div>
    </section>
  );
}

export function ProgressView({ job, pack, rate, onRetry, onDismiss, onCancel }: {
  job: JobView;
  pack: PackView | null;
  rate: { speed: number; eta: number | null };
  onRetry: () => void;
  onDismiss: () => void;
  onCancel: () => void;
}) {
  const failed = job.status === "error";
  const verifying = job.phase === "verify";
  const percent = job.bytesTotal ? Math.min(100, Math.round(((job.bytesDone || 0) / job.bytesTotal) * 100)) : Math.min(100, Math.round(((job.done || 0) / (job.total || 0)) * 100));
  const line = verifying
    ? labels.checkingFiles
    : job.phase === "launcher"
      ? labels.launcherPhase
      : job.phase === "apply"
        ? labels.applyPhase
        : (job.log && job.log[job.log.length - 1]) || job.phase || labels.working;
  const status = failed
    ? job.error || labels.error
    : labels.progressFiles(job.done || 0, job.total || 0, fmtBytes(job.bytesDone), fmtBytes(job.bytesTotal));
  return (
    <section className="progresswrap">
      <div className="kicker">{failed ? labels.installFailed : verifying ? labels.checking : labels.installing}</div>
      <h1>{failed ? labels.somethingWrong : pack ? pack.name : labels.packTitle}</h1>
      <div className="progress">
        <div className="big">{failed ? labels.error : `${percent}%`}</div>
        <div className="bar"><div className="fill" style={{ width: `${failed ? 100 : percent}%` }} /></div>
        <div className="small">{status}</div>
        {!failed && !verifying && job.status === "running" ? (
          <div className="meta">{rate.speed > 0 ? labels.speedEta(fmtBytes(rate.speed), fmtDuration(rate.eta)) : labels.measuringSpeed}</div>
        ) : null}
        <div className="log">{line}</div>
      </div>
      <div className="actions">
        {failed ? (
          <>
            <button className="btn primary" data-action="start-download" data-pack={job.packId} data-autofocus data-focusable data-key="primary" onClick={onRetry}>{labels.retry}</button>
            <button className="btn ghost" data-action="dismiss-job" data-focusable data-key="back" onClick={onDismiss}>{labels.back}</button>
          </>
        ) : (
          <button className="btn" data-action="cancel-download" data-autofocus data-focusable data-key="cancel" onClick={onCancel}>{labels.cancelDownload}</button>
        )}
      </div>
      <div className="hint">{failed ? labels.previousKept : labels.keepTv}</div>
    </section>
  );
}

export function OfflineView({ onRetry, detail, auth, pairing, onPair }: {
  onRetry: () => void;
  detail?: string | null;
  auth?: string;
  pairing?: PairingView | null;
  onPair: () => void;
}) {
  const rejected = auth === "rejected";
  const phase = pairing?.status || "idle";
  const waiting = phase === "pending" || phase === "approved";
  return (
    <section className="empty">
      <div className="kicker">{labels.appName.toUpperCase()}</div>
      <h1>{rejected ? labels.pairTitle : labels.offlineTitle}</h1>
      <div className="meta">{rejected ? labels.pairRejected : labels.offlineBody}</div>
      {rejected ? (
        <>
          {waiting ? (
            <p className="busy" role="status"><span className="spinner" aria-hidden="true" /><span>{phase === "approved" ? labels.pairApproved : labels.pairPending}</span></p>
          ) : (
            <div className="actions">
              <button className="btn primary" data-action="pair" data-autofocus data-focusable data-key="pair" onClick={onPair}>
                {phase === "idle" ? labels.pairAction : labels.pairAgain}
              </button>
            </div>
          )}
          {pairing?.message && !waiting ? <div className="callout">{pairing.message}</div> : null}
          {detail ? <div className="hint">{detail}</div> : null}
          <div className="hint">{labels.pairHint}</div>
        </>
      ) : (
        <>
          {detail ? <div className="callout error">{detail}</div> : null}
          <div className="actions">
            <button className="btn primary" data-action="retry" data-autofocus data-focusable data-key="retry" onClick={onRetry}>{labels.retry}</button>
          </div>
          <div className="hint">{labels.offlineHint}</div>
        </>
      )}
    </section>
  );
}

export function NoPacksView({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="empty">
      <div className="kicker">{labels.appName.toUpperCase()}</div>
      <h1>{labels.noPacksTitle}</h1>
      <div className="meta">{labels.noPacksBody}</div>
      <div className="actions">
        <button className="btn primary" data-action="retry" data-autofocus data-focusable data-key="retry" onClick={onRetry}>{labels.refresh}</button>
      </div>
    </section>
  );
}

export function DownloadSheet({ pack, data, onStart, onLaunch, onClose, onConfirm }: {
  pack: PackView;
  data: AgentStateView | null;
  onStart: () => void;
  onLaunch: () => void;
  onClose: () => void;
  onConfirm: (packId: string, checkId: string) => void;
}) {
  const free = data?.diskFreeBytes;
  const resume = !!pack.staging;
  const update = !!(pack.installed && pack.installedVersion && pack.installedVersion !== pack.mod.version);
  const blocker = firstBlocker(pack);
  const kicker = resume ? labels.resumeDownloadKicker : update ? labels.updateKicker : labels.installKicker;
  return (
    <div className="panel" style={{ width: "min(66vw,820px)" }}>
      <div className="kicker">{kicker}</div>
      <h2>{pack.name}</h2>
      <p>{pack.description || ""}</p>
      <div className="row"><span>{labels.downloadSheet}</span><b>{labels.stats(gb(pack.totalBytes), pack.files)}</b></div>
      {pack.contents ? <div className="row"><span>{labels.contentsRow}</span><b>{contentsCount(pack.contents)}</b></div> : null}
      <div className="row"><span>{labels.version}</span><b>{pack.mod.version}</b></div>
      {update ? <div className="row"><span>{labels.current}</span><b>{pack.installedVersion}</b></div> : null}
      <div className="row"><span>{labels.freeOnTv}</span><b>{free == null ? labels.unknown : `${gb(free)} GB`}</b></div>
      <div className="row"><span>{labels.kept}</span><b>{labels.keptValue}</b></div>
      {blocker ? <div className="callout error"><b>{blocker.title}</b> — {blocker.detail}{blocker.hint ? ` ${blocker.hint}` : ""}</div> : null}
      {noteList(pack).length ? <><p style={{ marginTop: "2vh" }}><b>{labels.beforeInstall}</b></p><Notes pack={pack} /></> : null}
      {preconditionChecks(pack).length ? <><p style={{ marginTop: "2vh" }}><b>{labels.checks}</b></p><Checks pack={pack} allowConfirm onConfirm={onConfirm} /></> : null}
      <div className="actions">
        <button className="btn primary" data-action="start-download" data-pack={pack.id} disabled={!!blocker} data-autofocus data-focusable data-key="start" onClick={onStart}>
          {resume ? labels.resumeDownload : update ? labels.downloadUpdate : labels.startDownload}
        </button>
        {update ? <button className="btn" data-action="launch" data-pack={pack.id} data-focusable data-key="play" onClick={onLaunch}>{labels.playVersion(pack.installedVersion ?? null)}</button> : null}
        <button className="btn ghost" data-action="close-download" data-focusable data-key="cancel" onClick={onClose}>{labels.notNow}</button>
      </div>
      <div className="hint">{labels.startDownloadHint}</div>
    </div>
  );
}

export function StorageView({ storage, onClose, onClear }: {
  storage: StorageView | null;
  onClose: () => void;
  onClear: (packId: string, scope: string, bytes: number) => void;
}) {
  if (!storage || storage.loading) {
    return (
      <section className="storagewrap">
        <div className="kicker">{labels.steamMachine}</div>
        <h1>{labels.storageTitle}</h1>
        <div className="meta">{labels.calculating}</div>
        <div className="actions"><button className="btn primary" data-action="close-storage" data-autofocus data-focusable data-key="storage-back" onClick={onClose}>{labels.back}</button></div>
      </section>
    );
  }
  if (storage.error) {
    return (
      <section className="storagewrap">
        <div className="kicker">{labels.steamMachine}</div>
        <h1>{labels.storageTitle}</h1>
        <div className="callout error">{storage.error}</div>
        <div className="actions"><button className="btn primary" data-action="close-storage" data-autofocus data-focusable data-key="storage-back" onClick={onClose}>{labels.back}</button></div>
      </section>
    );
  }
  const packs = storage.packs || [];
  return (
    <section className="storagewrap">
      <div className="kicker">{labels.steamMachine}</div>
      <h1>{labels.storageTitle}</h1>
      <div className="meta">
        {storage.freeBytes == null ? labels.freeUnknown : labels.freeOnTvValue(fmtBytes(storage.freeBytes))} · {labels.modSyncUses(fmtBytes(storage.rootBytes))}
      </div>
      <div className="storagegrid">
        <div className="stat"><span>{labels.modPacks}</span><b>{fmtBytes(storage.packsBytes)}</b></div>
        <div className="stat"><span>{labels.logs}</span><b>{fmtBytes(storage.logsBytes)}</b></div>
        <div className="stat"><span>{labels.appData}</span><b>{fmtBytes(storage.otherBytes)}</b></div>
      </div>
      <div className="storagepacks">
        {packs.length ? packs.map((pack) => (
          <div key={pack.id} className="storagecard">
            <div className="shead">
              <div>
                <div className="sname">{pack.name}</div>
                <div className="ssub">{pack.installed ? labels.installed(pack.currentVersion) : labels.noInstalledVersion}</div>
              </div>
              <div className="ssize">{fmtBytes(pack.totalBytes)}</div>
            </div>
            <div className="srows">
              {pack.versions.map((version) => (
                <div key={version.version} className="srow">
                  <span>{version.version}{version.current ? ` · ${labels.currentVersion}` : ""}</span>
                  <b>{fmtBytes(version.bytes)}</b>
                </div>
              ))}
              {pack.stagingBytes ? <div className="srow amber"><span>{labels.partialDownload}</span><b>{fmtBytes(pack.stagingBytes)}</b></div> : null}
              {pack.otherBytes ? <div className="srow muted"><span>{labels.profilesToolsArt}</span><b>{fmtBytes(pack.otherBytes)}</b></div> : null}
            </div>
            <div className="actions">
              {pack.stagingBytes ? <button className="btn" data-action="storage-clear" data-scope="staging" data-pack={pack.id} data-bytes={pack.stagingBytes} data-focusable onClick={() => onClear(pack.id, "staging", pack.stagingBytes)}>{labels.clearPartial(fmtBytes(pack.stagingBytes))}</button> : null}
              {pack.oldBytes ? <button className="btn" data-action="storage-clear" data-scope="old-versions" data-pack={pack.id} data-bytes={pack.oldBytes} data-focusable onClick={() => onClear(pack.id, "old-versions", pack.oldBytes)}>{labels.removeOldVersions(fmtBytes(pack.oldBytes))}</button> : null}
              <button className="btn ghost" data-action="storage-clear" data-scope="pack" data-pack={pack.id} data-bytes={pack.totalBytes} data-focusable onClick={() => onClear(pack.id, "pack", pack.totalBytes)}>{labels.removePack(fmtBytes(pack.totalBytes))}</button>
            </div>
          </div>
        )) : <div className="callout">{labels.noPacksInstalled}</div>}
      </div>
      <div className="actions">
        <button className="btn primary" data-action="close-storage" data-autofocus data-focusable data-key="storage-back" onClick={onClose}>{labels.back}</button>
        {storage.logsBytes ? <button className="btn ghost" data-action="storage-clear" data-scope="logs" data-bytes={storage.logsBytes} data-focusable onClick={() => onClear("", "logs", storage.logsBytes || 0)}>{labels.clearLogs(fmtBytes(storage.logsBytes))}</button> : null}
      </div>
      <div className="hint">{labels.storageHint}</div>
    </section>
  );
}

export function DetailsPanel({ pack, logs, onClose, onRollback, onUninstall, onRefreshLogs, onConfirm }: {
  pack: PackView;
  logs: string;
  onClose: () => void;
  onRollback: () => void;
  onUninstall: () => void;
  onRefreshLogs: () => void;
  onConfirm: (packId: string, checkId: string) => void;
}) {
  const versions = (pack.versions || []).join(", ") || labels.noVersions;
  const logText = logs.split(/\r?\n/).filter(Boolean).slice(-40).join("\n");
  return (
    <div className="panel">
      <div className="kicker">{pack.game.title}</div>
      <h2>{pack.name}</h2>
      <p>{pack.description || ""}</p>
      <div className="row"><span>{labels.installedRow}</span><b>{pack.installed ? pack.installedVersion : labels.noVersion}</b></div>
      <div className="row"><span>{labels.availableRow}</span><b>{pack.mod.version}</b></div>
      <div className="row"><span>{labels.versionsKept}</span><b>{versions}</b></div>
      <div className="row"><span>{labels.gameRow}</span><b>{pack.game.title} {pack.game.version || ""} · {labels.buildLabel} {pack.game.build || ""}</b></div>
      {pack.platform ? <div className="row"><span>{labels.platformRow}</span><b>{labels.platformName(pack.platform.variant)}{pack.platform.supported ? "" : ` · ${labels.platformUnsupported}`}</b></div> : null}
      <div className="row"><span>{labels.launchRow}</span><b>{launchLabel(pack)}</b></div>
      <div className="row"><span>{labels.packRow}</span><b>{labels.stats(gb(pack.totalBytes), pack.files)}</b></div>
      {pack.contents ? <div className="row"><span>{labels.contentsRow}</span><b>{contentsCount(pack.contents)} {labels.contentsSource(pack.contents.source)}</b></div> : null}
      <div className="row"><span>{labels.launcherRow}</span><b>{pack.launcher || labels.notInstalled}</b></div>
      <div className="row"><span>{labels.shortcutRow}</span><b>{pack.launch && pack.launch.mode === "default" ? labels.steamGameLink : pack.desktopFile || labels.addDesktop}</b></div>
      <div className="row"><span>{labels.savesRow}</span><b>{labels.savesValue}</b></div>
      {noteList(pack).length ? <><p style={{ marginTop: "2vh" }}><b>{labels.beforeInstall}</b></p><Notes pack={pack} /></> : null}
      {pack.contents ? (
        <>
          <p style={{ marginTop: "2vh" }}>
            <b>{contentsHeading(pack.contents)}</b>{" "}
            <span className="meta">{labels.contentsSource(pack.contents.source)}{contentsInactive(pack.contents) ? ` · ${labels.inactiveItems(contentsInactive(pack.contents))}` : ""}</span>
          </p>
          <div className="modlist">{contentsNames(pack.contents).join(" · ")}</div>
        </>
      ) : null}
      {preconditionChecks(pack).length ? <><p style={{ marginTop: "2vh" }}><b>{labels.checks}</b></p><Checks pack={pack} allowConfirm onConfirm={onConfirm} /></> : null}
      <p style={{ marginTop: "2vh" }}><b>{labels.recentLog}</b></p>
      <pre className="log" style={{ whiteSpace: "pre-wrap", fontSize: ".9vw", color: "#8b96a8", maxHeight: "18vh", overflow: "auto" }}>{logText || labels.noLogYet}</pre>
      <div className="actions">
        <button className="btn primary" data-action="close-details" data-autofocus data-focusable data-key="back" onClick={onClose}>{labels.back}</button>
        {pack.canRollback ? <button className="btn" data-action="rollback" data-pack={pack.id} data-focusable data-key="rollback" onClick={onRollback}>{labels.rollBack}</button> : null}
        {pack.local ? <button className="btn ghost" data-action="uninstall" data-pack={pack.id} data-focusable data-key="uninstall" onClick={onUninstall}>{labels.uninstall}</button> : null}
        <button className="btn ghost" data-action="open-logs" data-focusable data-key="logs" onClick={onRefreshLogs}>{labels.refreshLog}</button>
      </div>
    </div>
  );
}

export function ConfirmPanel({ confirm, onYes, onNo }: {
  confirm: ConfirmView;
  onYes: () => void;
  onNo: () => void;
}) {
  if (confirm.busy) {
    return (
      <div className="panel" style={{ width: "min(60vw,680px)" }} aria-busy="true">
        <h2>{confirm.title}</h2>
        <p className="busy" role="status"><span className="spinner" aria-hidden="true" /><span>{confirm.message}</span></p>
      </div>
    );
  }
  return (
    <div className="panel" style={{ width: "min(60vw,680px)" }}>
      <h2>{confirm.title}</h2>
      <p>{confirm.message}</p>
      {Array.isArray(confirm.details) && confirm.details.length ? (
        <>
          <p className="plantitle">{confirm.detailsTitle || labels.uninstallPlan}</p>
          <ul className="plan">{confirm.details.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </>
      ) : null}
      {Array.isArray(confirm.warnings) && confirm.warnings.length ? (
        <>
          <p className="plantitle">{labels.uninstallWarnings}</p>
          <ul className="plan warning">{confirm.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </>
      ) : null}
      <div className="actions">
        {confirm.simple ? (
          <button className="btn primary" data-action="confirm-no" data-autofocus data-focusable data-key="ok" onClick={onNo}>{labels.ok}</button>
        ) : (
          <>
            <button className="btn primary" data-action="confirm-yes" data-autofocus data-focusable data-key="yes" onClick={onYes}>{labels.confirm}</button>
            <button className="btn ghost" data-action="confirm-no" data-focusable data-key="no" onClick={onNo}>{labels.cancel}</button>
          </>
        )}
      </div>
    </div>
  );
}

export function Overlay({ children }: { children: ReactNode }) {
  return <div id="overlay" className="overlay">{children}</div>;
}
