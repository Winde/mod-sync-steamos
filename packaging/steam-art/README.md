# Steam library artwork

Deterministic, not generative: the app icon plus a flat gradient and
typography. The icon is Iconoir's `refresh-double` (MIT; see
`THIRD-PARTY-NOTICES.md` and `licenses/iconoir.txt`) on the app's red accent.
No game or store artwork is included.

| File | Size | Steam name |
|---|---|---|
| `hero.png` | 1920×620 | `<appid>_hero.png` |
| `portrait.png` | 600×900 | `<appid>p.png` |
| `header.png` | 460×215 | `<appid>.png` |
| `logo.png` | 512×512, transparent | `<appid>_logo.png` |
| `icon.png` | 256×256, transparent corners | `<appid>_icon.png` |

`generate/` holds the reference scripts used to produce the PNGs. They are
Windows-only (`System.Drawing` and Electron) and are not part of the release
archive; the committed PNGs are the source of truth.

From the repository root:

```powershell
# Renders build/icon.png and the transparent logo from build/icon.svg.
electron packaging/steam-art/generate/render-art.js
powershell -File packaging/steam-art/generate/generate.ps1
```

`generate.ps1` also copies the art into `web/` for the local ModSync shortcut
and dashboard. `register` maps the files to Steam's `<appid>` names and is
idempotent: running it again updates the existing shortcut instead of adding a
second one.
