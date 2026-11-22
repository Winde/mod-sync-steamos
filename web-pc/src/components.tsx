import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { desktopBridge, formatBytes, formatDate, messageOf, platformName } from "./api";
import type {
  BuildFormState,
  BuildJobState,
  BuildStartOptions,
  ConsoleState,
  ContentsItemState,
  ContentsState,
  DeviceState,
  ModReviewState,
  PackState,
  PairRequestState,
  SettingsDraft,
  ToastItem,
  UpdateInfo,
  UpdateProgress,
} from "./types";

export function Header({ data, busy, onToggleServer }: {
  data: ConsoleState | null;
  busy: boolean;
  onToggleServer: () => void;
}) {
  const running = !!data?.server.running;
  const error = !!data?.server.error;
  const valid = data?.packs.filter((pack) => pack.valid).length || 0;
  const loopback = running ? data?.server.host === "127.0.0.1" : data?.settings.bind === "loopback";
  return (
    <header className="top">
      <div className="brand">
        <img className="appicon" src="/icon.png" alt="" />
        <div className="brandtext">
          <div className="word">MODSYNC</div>
          <div className="sub">Server console</div>
        </div>
      </div>
      <div className="topright">
        <div id="server-pill" className={`pill${running ? " online" : error ? " error" : ""}`}>
          <span className="dot" />
          <span id="server-pill-text">
            {running ? `Serving ${valid} pack${valid === 1 ? "" : "s"}${loopback ? " · loopback" : ""}` : error ? "Server error" : "Server stopped"}
          </span>
        </div>
        <button
          id="start-stop"
          className={`btn ${running ? "danger" : "primary"}`}
          data-action="toggle-server"
          data-focusable
          data-key="server-toggle"
          disabled={busy}
          onClick={onToggleServer}
        >
          {running ? "Stop server" : "Start server"}
        </button>
      </div>
    </header>
  );
}

function activeContents(contents: ContentsState | null | undefined): ContentsItemState[] {
  return (contents?.items || []).filter((item) => item.active !== false);
}

function contentsCountLabel(contents: ContentsState): string {
  const count = Array.isArray(contents.items) ? activeContents(contents).length : contents.count || 0;
  const raw = (contents.itemsLabel || "items").replace(/^included\s+/i, "").trim() || "items";
  const singular = /ies$/i.test(raw) ? raw.replace(/ies$/i, "y") : /s$/i.test(raw) ? raw.slice(0, -1) : raw;
  return `${count} ${count === 1 ? singular : raw}`;
}

export function PackArt({ pack, onPick, busy = false }: {
  pack: PackState;
  onPick?: () => void;
  busy?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [pack.artUrl]);
  const initial = (pack.name || "?").slice(0, 2).toUpperCase();
  const content = pack.valid && pack.artUrl && !failed
    ? <img src={pack.artUrl} alt="" onError={() => setFailed(true)} />
    : <div className="artph">{initial}</div>;
  if (!onPick) return <div className="art">{content}</div>;
  return (
    <button
      type="button"
      className="art artbtn"
      data-action="change-art"
      data-id={pack.id}
      title={busy ? "Working…" : "Change pack image"}
      disabled={busy}
      onClick={onPick}
    >
      {content}
      <span className="artoverlay">{busy ? "Working…" : "Change image"}</span>
    </button>
  );
}

export function BuildBanner({ job, name, onShow }: {
  job: BuildJobState | null;
  name: string;
  onShow: () => void;
}) {
  if (!job || job.status !== "running") return null;
  return (
    <div id="build-banner" className="buildbanner">
      <span className="spinner" />
      <span>Building <b>{name}</b> · {job.percent}%</span>
      <span className="spacer" />
      <button className="btn small" data-action="show-build" onClick={onShow}>Show progress</button>
    </div>
  );
}

export function PairRequests({ requests, busy, onApprove, onDeny }: {
  requests: PairRequestState[];
  busy: boolean;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  if (!requests.length) return null;
  return (
    <div className="pairlist">
      {requests.map((request) => (
        <div className="callout pairrequest" key={request.id}>
          <div>
            <b>{request.device}</b> wants to connect to this Server.
            <div className="hint">{request.address} · {formatDate(request.createdAt)}</div>
          </div>
          <div className="actions">
            <button className="btn small primary" data-action="pair-approve" data-id={request.id} disabled={busy} onClick={() => onApprove(request.id)}>Allow</button>
            <button className="btn small" data-action="pair-deny" data-id={request.id} disabled={busy} onClick={() => onDeny(request.id)}>Deny</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function PackLibrary({ data, error, job, pairBusy, busy, onRefresh, onBuildNew, onRebuild, onReveal, onRemove, onEdit, onPickImage, onSaveReview, onShowBuild, onChangeFolder, onApprovePair, onDenyPair }: {
  data: ConsoleState | null;
  error: string | null;
  job: BuildJobState | null;
  pairBusy: boolean;
  busy: boolean;
  onRefresh: () => void;
  onBuildNew: () => void;
  onRebuild: (pack: PackState) => void;
  onReveal: (id: string) => void;
  onRemove: (pack: PackState) => void;
  onEdit: (pack: PackState) => void;
  onPickImage: (pack: PackState) => void;
  onSaveReview: (pack: PackState, item: ContentsItemState, rating: number, body: string) => Promise<ModReviewState | null>;
  onShowBuild: () => void;
  onChangeFolder: () => void;
  onApprovePair: (id: string) => void;
  onDenyPair: (id: string) => void;
}) {
  const [contentsPack, setContentsPack] = useState<PackState | null>(null);
  const [gameFilter, setGameFilter] = useState("");
  const games: Array<{ id: string; title: string }> = [];
  const seenGames = new Set<string>();
  for (const pack of data?.packs || []) {
    const id = pack.game?.id;
    if (!pack.valid || !id || seenGames.has(id)) continue;
    seenGames.add(id);
    games.push({ id, title: pack.game.title || id });
  }
  games.sort((a, b) => a.title.localeCompare(b.title));
  const activeFilter = games.some((game) => game.id === gameFilter) ? gameFilter : "";
  const allPacks = data?.packs || [];
  const visiblePacks = activeFilter ? allPacks.filter((pack) => pack.game?.id === activeFilter) : allPacks;
  const valid = visiblePacks.filter((pack) => pack.valid);
  const bytes = valid.reduce((sum, pack) => sum + pack.totalBytes, 0);
  const summary = data
    ? `${valid.length} pack${valid.length === 1 ? "" : "s"} · ${formatBytes(bytes)}`
    : "Loading packs…";
  const buildName = data && job ? data.recipes.find((recipe) => recipe.id === job.recipeId)?.name || job.packId : "";

  return (
    <section className="panel library">
      <div className="panelhead">
        <div>
          <h1>Pack library</h1>
          <div id="packs-summary" className="librarypath">
            <span className="muted">{summary}</span>
            {data ? <code title={data.settings.packsDir}>{data.settings.packsDir}</code> : null}
            {data && games.length > 1 ? (
              <label className="gamefilter">
                <span>Game</span>
                <select
                  id="game-filter"
                  className="input"
                  data-action="game-filter"
                  value={activeFilter}
                  onChange={(event) => setGameFilter(event.target.value)}
                >
                  <option value="">All games</option>
                  {games.map((game) => <option key={game.id} value={game.id}>{game.title}</option>)}
                </select>
              </label>
            ) : null}
            {data ? (
              <button
                className="btn small"
                data-action="change-packs"
                disabled={job?.status === "running"}
                title={job?.status === "running" ? "Wait for the running build before changing the folder." : undefined}
                onClick={onChangeFolder}
              >Change folder</button>
            ) : null}
          </div>
        </div>
        <div className="headactions">
          <button className="btn small" data-action="refresh" onClick={onRefresh}>Refresh</button>
          <button className="btn primary" data-action="build-new" onClick={onBuildNew}>Build a pack</button>
        </div>
      </div>
      <div id="notice">
        {error ? <div className="callout error"><b>The server console could not refresh.</b><br />{error}</div> : null}
      </div>
      <PairRequests
        requests={data?.pairRequests || []}
        busy={pairBusy}
        onApprove={onApprovePair}
        onDeny={onDenyPair}
      />
      <BuildBanner job={job} name={buildName} onShow={onShowBuild} />
      <div id="packs" className="packlist">
        {!data ? <div className="empty"><strong>Connecting to the console…</strong></div> : null}
        {data && !allPacks.length ? (
          <div className="empty">
            <strong>No packs in this folder</strong>
            <span>Build one from a recipe, or choose a folder that already has packs.</span>
            <code>{data.settings.packsDir}</code>
            <div className="actions">
              <button className="btn primary" data-action="build-new" onClick={onBuildNew}>Build a pack</button>
              <button
                className="btn"
                data-action="change-packs"
                disabled={job?.status === "running"}
                onClick={onChangeFolder}
              >Choose existing folder</button>
            </div>
          </div>
        ) : null}
        {data && allPacks.length && !visiblePacks.length ? (
          <div className="empty">
            <strong>No packs for this game</strong>
            <span>Choose All games to see the whole library.</span>
            <button className="btn small" data-action="clear-game-filter" onClick={() => setGameFilter("")}>Show all games</button>
          </div>
        ) : null}
        {visiblePacks.map((pack) => {
          const recipe = data?.recipes.find((entry) => entry.id === pack.recipeId);
          const packItems = pack.contents?.items || [];
          const reviewed = packItems.filter((item) => {
            const review = item.review;
            return !!review && (!!review.rating || !!review.body.trim());
          }).length;
          return (
          <article key={pack.id} className={`packcard${pack.valid ? "" : " invalid"}`}>
            <PackArt
              pack={pack}
              busy={busy}
              onPick={pack.valid ? () => onPickImage(pack) : undefined}
            />
            <div className="packbody">
              <div className="packhead">
                <div>
                  <div
                    className="packtitle"
                    title={pack.baseName && pack.baseName !== pack.name ? `Built as ${pack.baseName}` : undefined}
                  >{pack.valid ? pack.name : `${pack.name} — invalid pack`}</div>
                  <div className="packgame">
                    {pack.valid
                      ? `${pack.game.title}${pack.game.version ? ` · ${pack.game.version}` : ""}${pack.game.build ? ` · build ${pack.game.build}` : ""}`
                      : "pack.json could not be read"}
                  </div>
                </div>
                <span className={`badge${pack.valid ? "" : " red"}`}>{pack.valid ? pack.mod.version : "invalid"}</span>
              </div>
              {pack.valid ? (
                <div className="meta">
                  {reviewed ? (
                    <span
                      className="badge stars"
                      title={`${reviewed} of ${packItems.length} ${(pack.contents?.itemsLabel || "items").toLowerCase()} reviewed`}
                    >
                      ★ {reviewed}/{packItems.length} reviewed
                    </span>
                  ) : null}
                  <span className="badge">{formatBytes(pack.totalBytes)}</span>
                  <span className="badge">{pack.files} files</span>
                  {pack.contents ? (
                    <button
                      className="badge badgebtn"
                      type="button"
                      data-action="contents"
                      data-id={pack.id}
                      aria-haspopup="dialog"
                      title={`View the mods recorded in this pack: ${contentsCountLabel(pack.contents)}`}
                      onClick={() => setContentsPack(pack)}
                    >
                      View {contentsCountLabel(pack.contents)}
                      <span className="badgechev" aria-hidden="true">›</span>
                    </button>
                  ) : null}
                  <span className="badge">{pack.platforms.map(platformName).join(" · ")}</span>
                  {pack.modifiedAt ? <span className="badge">built {formatDate(pack.modifiedAt)}</span> : null}
                </div>
              ) : null}
              {pack.valid && pack.notes ? <div className="packnotes" title={pack.notes}>{pack.notes}</div> : null}
              {!pack.valid ? <div className="callout error">{pack.error || "Invalid pack folder."}</div> : null}
              <div className="packpath" title={pack.root}>{pack.root}</div>
              {pack.recipeId ? (
                <div className="packsource" title={recipe?.source || undefined}>
                  Rebuilds from {recipe?.source || "the working install you choose"}
                </div>
              ) : null}
              <div className="packactions">
                {pack.recipeId ? (
                  <button className="btn primary small" data-action="build" data-id={pack.id} onClick={() => onRebuild(pack)}>
                    Rebuild from install
                  </button>
                ) : null}
                {pack.valid ? (
                  <button className="btn small" data-action="edit" data-id={pack.id} onClick={() => onEdit(pack)}>Edit details</button>
                ) : null}
                <button className="btn small" data-action="reveal" data-id={pack.id} onClick={() => onReveal(pack.id)}>Open folder</button>
                <button className="btn small danger" data-action="remove" data-id={pack.id} onClick={() => onRemove(pack)}>Remove</button>
              </div>
            </div>
          </article>
          );
        })}
      </div>
      {contentsPack ? (
        <ContentsModal
          pack={contentsPack}
          onSaveReview={(item, rating, body) => onSaveReview(contentsPack, item, rating, body)}
          onClose={() => setContentsPack(null)}
        />
      ) : null}
    </section>
  );
}

export function ContentsModal({ pack, onSaveReview, onClose }: {
  pack: PackState;
  onSaveReview: (item: ContentsItemState, rating: number, body: string) => Promise<ModReviewState | null>;
  onClose: () => void;
}) {
  const contents = pack.contents;
  const [reviewEdits, setReviewEdits] = useState<Record<string, ModReviewState | null>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draftRating, setDraftRating] = useState(0);
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!contents) return null;
  const items = contents.items || [];
  const inactive = contents.inactive || [];

  const reviewFor = (item: ContentsItemState): ModReviewState | null => {
    if (Object.prototype.hasOwnProperty.call(reviewEdits, item.modId)) return reviewEdits[item.modId];
    return item.review || null;
  };
  const reviewed = items.filter((item) => {
    const review = reviewFor(item);
    return !!review && (!!review.rating || !!review.body.trim());
  }).length;

  const startEdit = (item: ContentsItemState) => {
    const review = reviewFor(item);
    setEditing(item.modId);
    setDraftRating(review?.rating || 0);
    setDraftBody(review?.body || "");
    setError("");
  };

  const save = async (item: ContentsItemState, rating: number, body: string) => {
    setSaving(true);
    setError("");
    try {
      const review = await onSaveReview(item, rating, body);
      setReviewEdits((current) => ({ ...current, [item.modId]: review }));
      setEditing(null);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="modalhead">
        <div>
          <h2>{pack.name || pack.id}</h2>
          <p className="muted">
            {contentsCountLabel(contents)}
            {contents.source ? ` · from ${contents.source}` : ""}
            {reviewed ? ` · ${reviewed} reviewed` : ""}
          </p>
        </div>
        <button className="btn small" data-action="close-modal" onClick={onClose}>Close</button>
      </div>
      {items.length ? (
        <>
          <p className="hint contentshint">
            Reviews belong to each mod, not to this pack build. They stay when the pack is rebuilt, built again under another name, or removed.
          </p>
          <div className="contentslist">
            {items.map((item, index) => {
              const review = reviewFor(item);
              const hasReview = !!review && (!!review.rating || !!review.body.trim());
              const isEditing = editing === item.modId;
              return (
                <div className={`contentsrow${item.active === false ? " inactive" : ""}`} key={item.modId || `${item.label}-${index}`}>
                  <div className="contentsitem">
                    <span className="contentsname">{item.label || item.path || "Unnamed item"}{item.active === false ? " (inactive)" : ""}</span>
                    <span className="contentsside">
                      {item.path ? <code>{item.path}</code> : null}
                      <button
                        className="btn small"
                        type="button"
                        data-action="review-mod"
                        data-mod-id={item.modId}
                        onClick={() => startEdit(item)}
                      >{hasReview ? "Edit review" : "Review"}</button>
                    </span>
                  </div>
                  {hasReview ? (
                    <div className="contentsreview">
                      {review.rating ? (
                        <span className="reviewstars" title={`${review.rating} of 5 stars`}>
                          {"★".repeat(review.rating)}{"☆".repeat(Math.max(0, 5 - review.rating))}
                        </span>
                      ) : null}
                      {review.body ? <span className="reviewbody">{review.body}</span> : null}
                    </div>
                  ) : null}
                  {isEditing ? (
                    <form
                      className="reviewform"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void save(item, draftRating, draftBody);
                      }}
                    >
                      <div className="stars" role="group" aria-label={`Rating for ${item.label}`}>
                        {[1, 2, 3, 4, 5].map((value) => (
                          <button
                            key={value}
                            className={`star${value <= draftRating ? " on" : ""}`}
                            type="button"
                            data-action="rate-mod"
                            data-rating={value}
                            aria-label={`${value} of 5 stars`}
                            aria-pressed={value === draftRating}
                            title={value === draftRating ? "Clear rating" : `${value} of 5 stars`}
                            onClick={() => setDraftRating((current) => current === value ? 0 : value)}
                          >★</button>
                        ))}
                        <span className="hint">{draftRating ? `${draftRating} of 5` : "Not rated"}</span>
                      </div>
                      <textarea
                        className="input"
                        rows={3}
                        maxLength={4000}
                        aria-label={`Review for ${item.label}`}
                        placeholder="What you think of this mod…"
                        value={draftBody}
                        onChange={(event) => setDraftBody(event.target.value)}
                      />
                      {error ? <p className="hint error">{error}</p> : null}
                      <div className="actions">
                        <button className="btn primary small" type="submit" data-action="save-review" disabled={saving}>
                          {saving ? "Saving…" : "Save review"}
                        </button>
                        {hasReview ? (
                          <button
                            className="btn small"
                            type="button"
                            data-action="clear-review"
                            disabled={saving}
                            onClick={() => { void save(item, 0, ""); }}
                          >Clear review</button>
                        ) : null}
                        <button className="btn small" type="button" disabled={saving} onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="callout">This pack has no item list recorded. Rebuild it or run the contents refresh to add one.</div>
      )}
      {inactive.length ? (
        <>
          <p className="contentsnote"><b>{inactive.length} inactive file{inactive.length === 1 ? "" : "s"}</b> in the pack</p>
          <div className="contentsinactive">{inactive.join(", ")}</div>
        </>
      ) : null}
      <div className="actions">
        <button className="btn primary" data-action="close-contents" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

export function EditPackModal({ pack, busy, onSave, onPickImage, onClearImage, onClose }: {
  pack: PackState;
  busy: boolean;
  onSave: (input: { name: string; notes: string }) => void;
  onPickImage: (pack: PackState) => Promise<string | null>;
  onClearImage: (pack: PackState) => Promise<string | null>;
  onClose: () => void;
}) {
  const builtInName = pack.baseName || pack.name;
  const [name, setName] = useState(pack.name || "");
  const [notes, setNotes] = useState(pack.notes || "");
  const [imageUrl, setImageUrl] = useState(pack.artUrl);
  const [customImage, setCustomImage] = useState(!!pack.artCustom);
  const [imageBusy, setImageBusy] = useState(false);

  useEffect(() => {
    setImageUrl(pack.artUrl);
    setCustomImage(!!pack.artCustom);
  }, [pack.id, pack.artUrl, pack.artCustom]);

  const chooseImage = async () => {
    setImageBusy(true);
    try {
      const next = await onPickImage(pack);
      if (next) {
        setImageUrl(next);
        setCustomImage(true);
      }
    } finally {
      setImageBusy(false);
    }
  };

  const removeImage = async () => {
    setImageBusy(true);
    try {
      const next = await onClearImage(pack);
      if (next) {
        setImageUrl(next);
        setCustomImage(false);
      }
    } finally {
      setImageBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="modalhead">
        <div>
          <h2>Edit {pack.name || pack.id}</h2>
          <p className="muted">{pack.game.title || "Pack"} · {pack.mod.version || pack.id}</p>
        </div>
        <button className="btn small" type="button" data-action="close-modal" onClick={onClose}>Close</button>
      </div>
      <form
        className="modalform"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ name: name.trim(), notes });
        }}
      >
        <div className="field">
          <label htmlFor="pack-display-name">Display name</label>
          <input
            id="pack-display-name"
            className="input"
            type="text"
            maxLength={120}
            spellCheck={false}
            value={name}
            placeholder={builtInName}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="hint">Leave empty to use the built-in name “{builtInName}”. The name is shown in this library and on paired TVs.</p>
        </div>
        <div className="field">
          <label>Pack image</label>
          <div className="imagefield">
            <PackArt pack={{ ...pack, artUrl: imageUrl }} onPick={() => { void chooseImage(); }} busy={imageBusy} />
            <div className="imageactions">
              <button className="btn small" type="button" disabled={imageBusy} onClick={() => { void chooseImage(); }}>
                {customImage ? "Change image" : "Choose image"}
              </button>
              {customImage ? (
                <button className="btn small" type="button" disabled={imageBusy} onClick={() => { void removeImage(); }}>
                  Remove custom image
                </button>
              ) : null}
              <p className="hint">PNG. Saved in the pack immediately and shown in the library and on the TV.</p>
            </div>
          </div>
        </div>
        <div className="field">
          <label htmlFor="pack-notes">Pack notes</label>
          <textarea
            id="pack-notes"
            className="input"
            rows={4}
            maxLength={4000}
            placeholder="Install hints, tested settings, compatibility…"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
          <p className="hint">Saved in the pack folder as library.json and shown with the pack on the Client.</p>
          <p className="hint">Ratings and reviews belong to the individual mods inside the pack. Open the mod list on the card to review them.</p>
        </div>
        <div className="actions">
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save details"}</button>
          <button className="btn small" type="button" data-action="close-modal" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

export function ServerPanel({ data, onCopyUrl, onOpenUrl, onGoToSettings }: {
  data: ConsoleState | null;
  onCopyUrl: () => void;
  onOpenUrl: () => void;
  onGoToSettings: () => void;
}) {
  if (!data) {
    return (
      <section className="panel servercard">
        <div className="panelhead compact">
          <div><h2>Pack server</h2><p className="muted">The only LAN listener. Stop it when the TV is done downloading.</p></div>
        </div>
        <div id="server-body" className="serverbody"><p className="muted">Loading server status…</p></div>
      </section>
    );
  }
  const server = data.server;
  const error = server.error
    ? <div className="callout error"><b>{server.running ? "Server error" : "Could not start the server"}</b><br />{server.error}</div>
    : null;
  const bind = data.settings.bind === "loopback" ? "loopback only" : data.settings.bind === "host" ? data.settings.host || "specific address" : "LAN";
  const loopback = server.running ? server.host === "127.0.0.1" : data.settings.bind === "loopback";
  return (
    <section className="panel servercard">
      <div className="panelhead compact">
        <div><h2>Pack server</h2><p className="muted">The only LAN listener. Stop it when the TV is done downloading.</p></div>
      </div>
      <div id="server-body" className="serverbody">
        {server.running ? (
          <>
            <div className="statusline">
              <div>
                <div className="bigstatus"><span className="green">Serving</span></div>
                <div className="servermeta">{bind} · since {new Date(server.startedAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
              </div>
            </div>
            {loopback ? (
              <div className="callout">
                Loopback only — the SteamOS client cannot reach this server.
                <div className="actions" style={{ marginTop: 8 }}>
                  <button className="btn small" data-action="goto-settings" onClick={onGoToSettings}>Change Bind to LAN</button>
                </div>
              </div>
            ) : null}
            <div className="copyrow">
              <span className="label">URL</span>
              <span className="value">{server.url}</span>
              <button className="btn small" data-action="open-url" onClick={onOpenUrl}>Open</button>
              <button className="btn small" data-action="copy-url" onClick={onCopyUrl}>Copy</button>
            </div>
            {error}
          </>
        ) : (
          <>
            <div className="statusline">
              <div>
                <div className="bigstatus">Server stopped</div>
                <div className="servermeta">Will bind {data.settings.bind === "loopback" ? "127.0.0.1" : server.host || data.lan.detected}:{server.port} · {bind}</div>
              </div>
            </div>
            {loopback ? (
              <div className="callout">
                Loopback only — the SteamOS client cannot reach this server.
                <div className="actions" style={{ marginTop: 8 }}>
                  <button className="btn small" data-action="goto-settings" onClick={onGoToSettings}>Change Bind to LAN</button>
                </div>
              </div>
            ) : null}
            {data.lan.detected === "127.0.0.1" && data.settings.bind === "lan"
              ? <div className="callout">No private LAN IPv4 was found. Switch Bind to loopback, or connect to the LAN.</div>
              : null}
            {error}
            <p className="hint">Use the Start server button above when the SteamOS client needs to install or update a pack.</p>
          </>
        )}
        <p className="hint">TVs pair automatically. Approve them in the pack library; the manual token in Settings is only for CLI or unattended installs.</p>
      </div>
    </section>
  );
}

export function DevicesPanel({ data, busy, onRevoke, onRevokeAll }: {
  data: ConsoleState | null;
  busy: boolean;
  onRevoke: (device: DeviceState) => void;
  onRevokeAll: () => void;
}) {
  const devices = data?.devices || [];
  return (
    <section className="panel">
      <div className="panelhead compact">
        <div>
          <h2>Paired devices</h2>
          <p className="muted">TVs approved by this console. Revoking one does not affect the others.</p>
        </div>
        {devices.length ? (
          <button className="btn small danger" data-action="revoke-all-devices" disabled={busy} onClick={onRevokeAll}>Revoke all</button>
        ) : null}
      </div>
      {devices.length ? (
        <div className="devicelist">
          {devices.map((device) => (
            <div className="devicerow" key={device.id}>
              <div>
                <div className="devicename">
                  {device.name}
                  {device.legacy ? <span className="badge amber">manual token</span> : null}
                </div>
                <div className="devicemeta">
                  {device.address || "unknown address"} · last seen {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "never"}
                </div>
              </div>
              <button
                className="btn small danger"
                data-action="revoke-device"
                data-id={device.id}
                disabled={busy}
                onClick={() => onRevoke(device)}
              >Revoke</button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No devices yet. A new TV appears as a pairing request in the pack library.</p>
      )}
      {devices.some((device) => device.legacy) ? (
        <p className="hint">Manual-token clients can reconnect until you rotate the manual token in Settings.</p>
      ) : null}
    </section>
  );
}

export function SettingsPanel({ draft, data, saving, saved, onChange, onBrowsePacks, onRevealPacks, onGenerateToken, onSave }: {
  draft: SettingsDraft;
  data: ConsoleState;
  saving: boolean;
  saved: string;
  onChange: (patch: Partial<SettingsDraft>) => void;
  onBrowsePacks: () => void;
  onRevealPacks: () => void;
  onGenerateToken: () => void;
  onSave: () => void;
}) {
  const [showToken, setShowToken] = useState(false);
  useEffect(() => setShowToken(false), [draft.token]);
  const bindHint = draft.bind === "lan"
    ? data.lan.detected === "127.0.0.1"
      ? "No private LAN IPv4 found. Connect to the LAN or use a specific address."
      : `Detected ${data.lan.detected}. Use a specific address if this PC has more than one LAN interface.`
    : draft.bind === "loopback"
      ? "Only this server can reach itself. Useful for testing."
      : data.lan.addresses.length
        ? `Addresses: ${data.lan.addresses.map((entry) => `${entry.address} (${entry.name})`).join(", ")}`
        : "Enter a LAN IPv4 address owned by this server.";
  const supported = data.app.loginItem.supported;
  return (
    <section className="panel">
      <div className="panelhead compact">
        <div><h2>Settings</h2><p className="muted">Saved on this server. Edited fields apply when you save.</p></div>
        <div className="headactions">
          <button
            id="settings-save-top"
            className="btn primary small"
            type="submit"
            form="settings-form"
            disabled={saving}
          >{saving ? "Saving…" : "Save settings"}</button>
        </div>
      </div>
      <form id="settings-form" className="settingsform" autoComplete="off" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
        <div className="field">
          <label htmlFor="packs-dir">Packs folder</label>
          <div className="inputrow">
            <input id="packs-dir" className="input" type="text" spellCheck={false} value={draft.packsDir} onChange={(event) => onChange({ packsDir: event.target.value })} />
            <button id="packs-browse" className="btn small" type="button" disabled={!desktopBridge()?.pickFolder} onClick={onBrowsePacks}>Browse</button>
            <button className="btn small" type="button" data-action="reveal-packs" onClick={onRevealPacks}>Open</button>
          </div>
          <p className="hint">Choosing a folder applies it immediately. A typed path is saved with the other settings.</p>
        </div>
        <div className="field">
          <label htmlFor="bind-mode">Bind</label>
          <select id="bind-mode" className="input" value={draft.bind} onChange={(event) => onChange({ bind: event.target.value as SettingsDraft["bind"] })}>
            <option value="lan">LAN — automatic private address</option>
            <option value="loopback">This server only — loopback</option>
            <option value="host">Specific address</option>
          </select>
          <div id="bind-host-row" className={draft.bind === "host" ? "" : "hidden"}>
            <input id="bind-host" className="input" list="lan-addresses" placeholder="192.168.1.20" spellCheck={false} value={draft.host} onChange={(event) => onChange({ host: event.target.value })} />
          </div>
          <datalist id="lan-addresses">
            {data.lan.addresses.map((entry) => <option key={entry.address} value={entry.address}>{entry.name}</option>)}
          </datalist>
          <p id="bind-hint" className="hint">{bindHint}</p>
        </div>
        <div className="field two">
          <div>
            <label htmlFor="server-port">Port</label>
            <input id="server-port" className="input" type="number" min="1" max="65535" step="1" value={draft.port} onChange={(event) => onChange({ port: event.target.value })} />
          </div>
          <div>
            <label htmlFor="server-token">Manual token</label>
            <div className="inputrow">
              <input id="server-token" className="input" type={showToken ? "text" : "password"} spellCheck={false} value={draft.token} onChange={(event) => onChange({ token: event.target.value })} />
              <button id="token-toggle" className="btn small" type="button" onClick={() => setShowToken((value) => !value)}>{showToken ? "Hide" : "Show"}</button>
            </div>
            <p className="hint">For CLI and older clients. Paired TVs receive their own device token.</p>
          </div>
        </div>
        <div className="actions">
          <button id="token-generate" className="btn small" type="button" onClick={onGenerateToken}>New manual token</button>
          <span className="hint">
            {data.app.tokenStorage === "protected" ? "Saved with OS user protection." : "Saved in the console config file."}{" "}
            Changing it restarts a running server and revokes legacy clients; paired TVs keep working.
          </span>
        </div>
        <label className="check">
          <input id="auto-start" type="checkbox" checked={draft.autoStart} onChange={(event) => onChange({ autoStart: event.target.checked })} />
          Start the pack server when ModSync starts
        </label>
        <label className="check">
          <input id="launch-login" type="checkbox" checked={draft.launchAtLogin} disabled={!supported} onChange={(event) => onChange({ launchAtLogin: event.target.checked })} />
          Start ModSync Server when I sign in
        </label>
        <label className="check">
          <input id="minimize-tray" type="checkbox" checked={draft.minimizeToTray} onChange={(event) => onChange({ minimizeToTray: event.target.checked })} />
          Minimize to the tray instead of the taskbar
        </label>
        <p id="login-hint" className="hint">
          {data.app.loginItem.error || (supported
            ? "Starts hidden in the tray at sign-in. The pack server follows its own setting. Closing the window always hides it to the tray."
            : "Sign-in startup is only available in the desktop app. Closing the window always hides it to the tray.")}
        </p>
        <div className="actions">
          <button className="btn primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
          <span id="settings-status" className="hint">{saved}</span>
        </div>
      </form>
    </section>
  );
}

export function GuidePanel({ data, onCopyInstall, onCopyManualInstall, onCopyFirewall }: {
  data: ConsoleState | null;
  onCopyInstall: () => void;
  onCopyManualInstall: () => void;
  onCopyFirewall: () => void;
}) {
  return (
    <details className="panel help">
      <summary>
        <div>
          <h2>SteamOS client setup</h2>
          <p className="muted">Install the TV app and allow the LAN port.</p>
        </div>
        <span className="chevron" aria-hidden="true">›</span>
      </summary>
      <div id="guide-body" className="guide">
        {!data ? <p className="muted">Loading…</p> : (
          <>
            {data.settings.bind === "loopback" ? <div className="callout">Loopback mode is for testing on this server. The SteamOS client cannot reach a loopback server.</div> : null}
            <h3>1. Install the app on the TV</h3>
            <pre className="codeblock">{data.guide.installCommand}</pre>
            <div className="actions">
              <button className="btn small" data-action="copy-install" onClick={onCopyInstall}>Copy</button>
              <span className="hint">The TV pairs after install. Approve it in the pack library.</span>
            </div>
            {data.guide.manualInstallCommand ? (
              <details className="manualinstall">
                <summary>Manual install (contains the manual token)</summary>
                <p className="hint">For unattended installs. The TV connects with the manual token from Settings instead of pairing.</p>
                <div className="actions">
                  <button className="btn small" data-action="copy-manual-install" onClick={onCopyManualInstall}>Copy manual command</button>
                </div>
              </details>
            ) : null}
            <h3>2. Let the client reach this server</h3>
            <p className="hint">Allow the port once from an admin PowerShell. Local subnet only.</p>
            <pre className="codeblock">{data.guide.firewallCommand}</pre>
            <div className="actions"><button className="btn small" data-action="copy-firewall" onClick={onCopyFirewall}>Copy</button></div>
            <ol>
              <li>Start the server, then run the install one-liner on the SteamOS client.</li>
              <li>Stop the server after the pack has downloaded.</li>
              <li>Do not port-forward this port or enable UPnP.</li>
            </ol>
          </>
        )}
      </div>
    </details>
  );
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal-card" onMouseDown={(event) => event.stopPropagation()}>{children}</div>
    </div>
  );
}

function recipeFor(data: ConsoleState, id?: string) {
  return data.recipes.find((recipe) => recipe.id === id)
    || data.recipes.find((recipe) => !recipe.packExists)
    || data.recipes[0]
    || null;
}

function slugPackId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64) || "pack";
}

function uniquePackId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function BuildModal({ data, job, viewJob, initialRecipeId, initialPackId, busy, onStart, onClose, onReveal, onBuildAnother }: {
  data: ConsoleState;
  job: BuildJobState | null;
  viewJob: boolean;
  initialRecipeId?: string;
  initialPackId?: string;
  busy: boolean;
  onStart: (form: BuildFormState, options?: BuildStartOptions) => void;
  onClose: () => void;
  onReveal: (id: string) => void;
  onBuildAnother: () => void;
}) {
  const initialRecipe = recipeFor(data, initialRecipeId);
  // A stale pack id must not retarget the fallback recipe the modal picks when
  // the recipe that built the pack is gone.
  const initialTargetPackId = initialRecipeId && data.recipes.some((entry) => entry.id === initialRecipeId)
    ? initialPackId
    : undefined;
  const [form, setForm] = useState<BuildFormState>({
    recipeId: initialRecipe?.id || "",
    source: initialRecipe?.source || "",
    version: "",
    copy: false,
    driverOptions: {},
    packId: initialTargetPackId,
  });
  const [confirming, setConfirming] = useState(false);
  const [createNew, setCreateNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newId, setNewId] = useState("");
  const [newIdTouched, setNewIdTouched] = useState(false);
  const recipe = data.recipes.find((entry) => entry.id === form.recipeId) || initialRecipe;
  const jobName = data.recipes.find((entry) => entry.id === job?.recipeId)?.name || job?.packId || "";

  useEffect(() => {
    if (!viewJob) setConfirming(false);
  }, [viewJob]);

  const targetId = form.packId || recipe?.id || "";
  const existingPack = data.packs.find((pack) => pack.id === targetId) || null;
  const replacing = !!existingPack || (!!recipe && targetId === recipe.id && recipe.packExists);
  const takenIds = new Set<string>();
  for (const pack of data.packs) takenIds.add(pack.id);
  for (const entry of data.recipes) takenIds.add(entry.id);

  const openConfirm = () => {
    const suggestedName = `${(existingPack?.name || recipe?.name || "Pack").slice(0, 115)} copy`;
    setNewName(suggestedName);
    setNewId(uniquePackId(slugPackId(suggestedName), takenIds));
    setNewIdTouched(false);
    setCreateNew(false);
    setConfirming(true);
  };

  const newIdError = !createNew
    ? ""
    : !newId
      ? "Enter a folder id."
      : newId === "." || newId === ".."
        ? "That folder id is reserved."
        : !/^[a-zA-Z0-9._-]+$/.test(newId)
          ? "Use only letters, numbers, dots, dashes, and underscores."
          : takenIds.has(newId)
            ? "That folder id is already used by a pack or recipe."
            : "";

  if (viewJob && job) {
    const done = job.status === "done";
    const failed = job.status === "error";
    const status = job.status === "running"
      ? `${job.phase === "hashing" ? "Hashing files" : job.phase === "copying" ? "Copying payload" : job.phase === "swapping" ? "Swapping pack" : "Preparing"} · ${job.percent}%`
      : done && job.result
        ? `${job.result.version} · ${job.result.files} files · ${formatBytes(job.result.totalBytes)}`
        : failed ? "Build failed" : "Finished";
    return (
      <Modal onClose={onClose}>
        <div className="modalhead">
          <div>
            <h2>{done ? "Pack built" : failed ? "Build failed" : `Building ${jobName}`}</h2>
            <p className="muted">{status}</p>
          </div>
          {job.status === "running" ? null : <button className="btn small" data-action="close-modal" onClick={onClose}>Close</button>}
        </div>
        <div className="progresswrap">
          <div className="progress"><div className="fill" style={{ width: `${Math.max(0, Math.min(100, job.percent))}%` }} /></div>
          <div className="progressmeta"><span>{job.phase}</span><span>{job.percent}%</span></div>
          {failed ? <div className="callout error">{job.error || "The build stopped."}</div> : null}
          <pre className="log">{job.log.join("\n")}</pre>
          <div className="actions">
            {job.status === "running" ? (
              <>
                <button className="btn small" data-action="close-modal" onClick={onClose}>Hide</button>
                <span className="hint">The build keeps running.</span>
              </>
            ) : (
              <>
                <button className="btn small primary" data-action="close-modal" onClick={onClose}>Done</button>
                {done ? <button className="btn small" data-action="reveal" data-id={job.packId} onClick={() => onReveal(job.packId)}>Open folder</button> : null}
                <button className="btn small" data-action="build-another" onClick={onBuildAnother}>Build another</button>
              </>
            )}
          </div>
        </div>
      </Modal>
    );
  }

  if (!recipe) {
    return (
      <Modal onClose={onClose}>
        <div className="modalhead"><div><h2>Build or rebuild a pack</h2><p className="muted">No recipes found. Add one under recipes/.</p></div><button className="btn small" onClick={onClose}>Close</button></div>
      </Modal>
    );
  }

  if (confirming) {
    return (
      <Modal onClose={onClose}>
        <div className="modalhead">
          <div>
            <h2>{createNew ? "Create a new pack" : `Replace ${existingPack?.name || recipe.name}?`}</h2>
            <p className="muted">{recipe.name} · {recipe.gameTitle}</p>
          </div>
          <button className="btn small" type="button" data-action="close-modal" onClick={onClose}>Cancel</button>
        </div>
        <div className="choicegrid">
          <label className={`choice${createNew ? "" : " on"}`}>
            <input
              type="radio"
              name="rebuild-mode"
              data-action="rebuild-overwrite"
              checked={!createNew}
              onChange={() => setCreateNew(false)}
            />
            <span>
              <b>Overwrite the existing pack</b>
              <span className="hint">Replace {existingPack?.root || recipe.out}. The old pack stays until the new build succeeds.</span>
            </span>
          </label>
          <label className={`choice${createNew ? " on" : ""}`}>
            <input
              type="radio"
              name="rebuild-mode"
              data-action="rebuild-new"
              checked={createNew}
              onChange={() => setCreateNew(true)}
            />
            <span>
              <b>Create a new pack</b>
              <span className="hint">Keep the existing pack and build a second one from this recipe.</span>
            </span>
          </label>
        </div>
        {createNew ? (
          <>
            <div className="callout info">The existing pack stays in place. The new pack is built into its own folder.</div>
            <div className="field">
              <label htmlFor="new-pack-name">New pack name</label>
              <input
                id="new-pack-name"
                className="input"
                type="text"
                maxLength={120}
                spellCheck={false}
                value={newName}
                placeholder={recipe.name}
                onChange={(event) => {
                  const value = event.target.value;
                  setNewName(value);
                  if (!newIdTouched) setNewId(uniquePackId(slugPackId(value || recipe.name), takenIds));
                }}
              />
              <p className="hint">Shown in the library and on paired TVs. Leave empty to use the recipe name.</p>
            </div>
            <div className="field">
              <label htmlFor="new-pack-id">Folder id</label>
              <input
                id="new-pack-id"
                className="input"
                type="text"
                maxLength={64}
                spellCheck={false}
                value={newId}
                onChange={(event) => {
                  setNewIdTouched(true);
                  setNewId(slugPackId(event.target.value));
                }}
              />
              <p className={`hint${newIdError ? " error" : ""}`}>{newIdError || `Creates packs/${newId}.`}</p>
            </div>
          </>
        ) : (
          <>
            <div className="callout">
              <b>This replaces the current pack.</b> The folder and payload are swapped only after the new build succeeds.
            </div>
            <div className="callout error">
              <b>Custom name, notes, and image are cleared.</b> They belong to this build. Reviews of the individual mods inside the pack are kept.
            </div>
          </>
        )}
        <div className="actions">
          <button
            className="btn primary"
            type="button"
            data-action="confirm-rebuild"
            disabled={busy || (createNew && !!newIdError)}
            onClick={() => {
              if (createNew) onStart(form, { packId: newId, createNew: true, packName: newName.trim() });
              else onStart(form);
            }}
          >{busy ? "Starting…" : createNew ? "Create pack" : "Replace pack"}</button>
          <button className="btn small" type="button" data-action="back-to-build" onClick={() => setConfirming(false)}>Back</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <div className="modalhead">
        <div><h2>Build or rebuild a pack</h2><p className="muted">The current pack stays in place until the new build succeeds.</p></div>
        <button className="btn small" data-action="close-modal" onClick={onClose}>Close</button>
      </div>
      <form
        id="build-form"
        className="modalform"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          if (replacing) {
            openConfirm();
            return;
          }
          onStart(form);
        }}
      >
        {data.server.running ? <div className="callout">The pack server is running. Stop it first if the SteamOS client is downloading this pack.</div> : null}
        <div className="field">
          <label htmlFor="build-recipe">Recipe</label>
          <select
            id="build-recipe"
            className="input"
            value={form.recipeId}
            onChange={(event) => {
              const next = recipeFor(data, event.target.value);
              setForm((value) => ({
                ...value,
                recipeId: event.target.value,
                source: next?.source || value.source,
                driverOptions: {},
                packId: undefined,
              }));
            }}
          >
            {data.recipes.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name} — {entry.gameTitle}{entry.packExists ? " (installed)" : ""}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="build-source">Working install</label>
          <div className="inputrow">
            <input id="build-source" className="input" type="text" spellCheck={false} value={form.source} onChange={(event) => setForm((value) => ({ ...value, source: event.target.value }))} />
            <button
              id="build-browse"
              className="btn small"
              type="button"
              disabled={!desktopBridge()?.pickFolder}
              onClick={async () => {
                const picked = await desktopBridge()?.pickFolder?.("Choose the working install");
                if (picked) setForm((value) => ({ ...value, source: picked }));
              }}
            >
              Browse
            </button>
          </div>
          <p className="hint">The folder ModSync reads the installed mod from. It is not modified.</p>
        </div>
        {(recipe.buildOptions || []).map((option) => {
          const id = `build-option-${option.key}`;
          return (
            <div className="field" key={option.key}>
              <label htmlFor={id}>{option.label}{option.optional ? " (optional)" : ""}</label>
              <div className="inputrow">
                <input
                  id={id}
                  className="input"
                  type="text"
                  spellCheck={false}
                  placeholder={option.placeholder || ""}
                  value={form.driverOptions[option.key] || ""}
                  onChange={(event) => setForm((value) => ({
                    ...value,
                    driverOptions: { ...value.driverOptions, [option.key]: event.target.value },
                  }))}
                />
                {option.type === "directory" ? (
                  <button
                    className="btn small"
                    type="button"
                    data-action="build-option-browse"
                    data-option={option.key}
                    disabled={!desktopBridge()?.pickFolder}
                    onClick={async () => {
                      const picked = await desktopBridge()?.pickFolder?.(`Choose ${option.label.toLowerCase()}`);
                      if (picked) {
                        setForm((value) => ({
                          ...value,
                          driverOptions: { ...value.driverOptions, [option.key]: picked },
                        }));
                      }
                    }}
                  >
                    Browse
                  </button>
                ) : null}
              </div>
              {option.help ? <p className="hint">{option.help}</p> : null}
            </div>
          );
        })}
        <div className="field two">
          <div>
            <label htmlFor="build-version">Version (optional)</label>
            <input id="build-version" className="input" type="text" spellCheck={false} placeholder={recipe.version || "automatic"} value={form.version} onChange={(event) => setForm((value) => ({ ...value, version: event.target.value }))} />
          </div>
          <label className="check" style={{ alignSelf: "end", paddingBottom: 7 }}>
            <input id="build-copy" type="checkbox" checked={form.copy} onChange={(event) => setForm((value) => ({ ...value, copy: event.target.checked }))} />
            Copy payload instead of hardlinks
          </label>
        </div>
        <div className="actions">
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "Starting…" : "Build pack"}</button>
          <button className="btn small" type="button" data-action="close-modal" onClick={onClose}>Cancel</button>
          <span className="hint">Output: <span className="mono">{form.packId ? `${data.settings.packsDir}/${form.packId}` : recipe.out}</span></span>
        </div>
      </form>
    </Modal>
  );
}

export function RemoveModal({ pack, busy, onConfirm, onClose }: {
  pack: PackState;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose}>
      <div className="modalhead">
        <div>
          <h2>Remove {pack.name || pack.id}?</h2>
          <p className="muted">{pack.game.title || "Pack"} · {pack.mod.version || "invalid pack"}</p>
        </div>
        <button className="btn small" data-action="close-modal" onClick={onClose}>Cancel</button>
      </div>
      <div className="callout error">
        This deletes the pack folder and all of its payload, tools, profiles, and art. The working mod install is not touched.
        The server stops serving this pack immediately.
      </div>
      <p className="packpath" style={{ margin: "14px 0" }}>{pack.root}</p>
      <div className="actions">
        <button className="btn danger" data-action="confirm-remove" data-id={pack.id} disabled={busy} onClick={onConfirm}>Remove pack</button>
        <button className="btn small" data-action="close-modal" onClick={onClose}>Keep it</button>
      </div>
    </Modal>
  );
}

export function UpdateModal({ info, installing, progress, onInstall, onClose }: {
  info: UpdateInfo;
  installing: boolean;
  progress: UpdateProgress | null;
  onInstall: () => void;
  onClose: () => void;
}) {
  const percent = progress?.total && progress.total > 0
    ? Math.max(0, Math.min(100, Math.round((progress.received / progress.total) * 100)))
    : null;
  const phase = progress?.phase === "verify"
    ? "Verifying the download…"
    : progress?.phase === "install"
      ? `Installing ModSync Server ${info.latest}…`
      : `Downloading ModSync Server ${info.latest}…`;
  const size = progress?.total
    ? `${formatBytes(progress.received)} of ${formatBytes(progress.total)}`
    : progress ? formatBytes(progress.received) : "";
  return (
    <Modal onClose={() => { if (!installing) onClose(); }}>
      <div className="modalhead">
        <div>
          <h2>Update ModSync Server to {info.latest}?</h2>
          <p className="muted">Currently running {info.current}.</p>
        </div>
        {installing ? null : <button className="btn small" data-action="close-modal" onClick={onClose}>Not now</button>}
      </div>
      {installing ? (
        <div className="updateinstall">
          <div className="callout installing">
            <span className="spinner" />
            <span>{phase}</span>
          </div>
          {percent != null ? (
            <div className="progresswrap">
              <div className="progress"><div className="fill" style={{ width: `${percent}%` }} /></div>
              <div className="progressmeta"><span>{size}</span><span>{percent}%</span></div>
            </div>
          ) : size ? <p className="hint">{size}</p> : null}
          <p className="hint">The pack server stops while it installs. The Server reopens on its own.</p>
        </div>
      ) : (
        <>
          <p>The pack server stops while the new version installs. Packs, settings, and the token stay in place, and the Server reopens when the install is done.</p>
          <div className="actions">
            <button className="btn primary" data-action="install-update" onClick={onInstall}>Install and restart</button>
            <button className="btn small" onClick={onClose}>Not now</button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function Toasts({ items }: { items: ToastItem[] }) {
  return <div id="toasts" className="toasts" aria-live="polite">{items.map((item) => <div key={item.id} className={`toast ${item.tone}`}>{item.message}</div>)}</div>;
}
