# Glance — README Viewer

A lightweight cross-platform desktop app that opens and renders Markdown files
(primarily READMEs) with clean, GitHub-style formatting. Serif prose, mono
chrome, flat surfaces, one accent color. No card-and-shadow dashboard look.

## Features

- Open Markdown and text files (`.md`, `.markdown`, `.mdown`, `.txt`) via
  **File > Open** (`Ctrl/Cmd+O`), **drag-and-drop**, or a multi-file selection
- Windows Explorer integration: **Open with Glance** for `.md`, `.markdown`,
  and `.mdown`, plus drag a file or folder onto the Glance icon to open it in
  the existing window instead of starting another copy
- Open an entire folder (`Ctrl/Cmd+Shift+E`) with a browsable sidebar tree,
  root `README.md` auto-open, and folder-scoped relative links and images
- GitHub-flavored rendering: tables, strikethrough, task lists, autolinks
- Mermaid diagrams rendered locally, theme-matched, with lazy loading and a
  source fallback when a diagram cannot be rendered
- Inline (`$...$`) and display (`$$...$$`) math through KaTeX, including
  raw-source fallbacks for invalid expressions
- GitHub alerts (`NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`), footnotes,
  and emoji shortcodes
- Syntax-highlighted fenced code blocks with hover/focus **copy** controls that
  copy the original code and confirm with **copied**
- Forgiving tables: delimiter rows with "smart" dashes (`|—|—|`, common in
  LLM- or chat-pasted markdown) render as real tables
- Safe HTML: `<details>`, `<div>`, `<br>` render; `<script>`, event handlers,
  and `javascript:` URLs are stripped silently
- Live reload, back/forward history, a contents rail, in-document find, and
  sidebar search across the open folder or session files
- Dark and light themes (`Ctrl/Cmd+T`), OS preference on first launch,
  persisted afterwards
- Built-in help (`F1`) read from the bundled `HELP.md`
- External links always open in the default browser, never inside the app
- Session file list in the collapsible sidebar; window title tracks the open file

## Quickstart

Prerequisites: **Node.js 20 LTS or newer**.

```bash
npm install
npm start
```

Then open `SAMPLE.md` (included) via File > Open or drag-and-drop to try it out.

## Build a distributable

```bash
npm run build
```

Packages via electron-builder into `dist/` (Windows: NSIS installer,
macOS: DMG, Linux: AppImage). The Windows installer registers `.md`,
`.markdown`, and `.mdown` under **Open with Glance**; development launches do
not register file associations. Local builds are **unsigned** — see
`signAndEditExecutable` in `package.json`. For public releases, sign with
your own certificate and remove that flag.

## Project structure

```
├── main.js       # Main process: window, menu, dialogs, file reads, IPC
├── preload.js    # contextBridge: the only Node/Electron access the renderer gets
├── renderer.js   # Markdown parsing, sanitizing, rendering, help, UI logic
├── watcher.js    # Single-file live-reload watcher
├── folder.js     # Folder scan, path guard, and folder-tree watcher
├── index.html    # App shell
├── HELP.md       # Built-in help, opened from Help > Help (F1)
├── theme-init.js # Applies the stored/OS theme before first paint (no flash)
├── style.css     # Design tokens, themes, GitHub-style markdown styling
├── build/        # NSIS installer include for Open with Glance
├── vendor/       # highlight.js browser bundle + self-hosted webfonts (see notes below)
├── assets/       # App icon
└── SAMPLE.md     # Demo file exercising the render pipeline
```

## Security model

- `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer
- Main-process access (dialogs, file reads, clipboard writes,
  `shell.openExternal`) goes only through `preload.js` via `contextBridge` —
  the renderer never touches Node or `fs` directly
- All rendered Markdown HTML passes through DOMPurify before hitting the DOM;
  KaTeX output gets a second allowlist pass for only its HTML and MathML
- Mermaid runs with `securityLevel: "strict"`, KaTeX trust is disabled, and
  local files are guarded to the open file or folder root
- Strict Content Security Policy (`script-src 'self'`, no remote resources);
  Mermaid, KaTeX, fonts, and the other renderers are bundled and lazy-loaded
  from disk

## Scripts

| Command         | What it does                              |
|-----------------|-------------------------------------------|
| `npm start`     | Launch the app in dev                     |
| `npm run build` | Package an installer for the current OS   |

## Tech stack

[Electron](https://www.electronjs.org/) ·
[markdown-it](https://github.com/markdown-it/markdown-it) ·
[Mermaid](https://mermaid.js.org/) ·
[KaTeX](https://katex.org/) ·
[highlight.js](https://highlightjs.org/) ·
[DOMPurify](https://github.com/cure53/DOMPurify) ·
[electron-builder](https://www.electron.build/)

Note: `vendor/highlight.min.js` is the official highlight.js browser bundle
(v11.10.0, via cdnjs), vendored because the npm package ships only ESM/CJS
builds. `vendor/fonts.css` and `vendor/fonts/` hold the Latin and Latin
Extended subsets of Source Serif 4 and JetBrains Mono (SIL Open Font License),
vendored because the app's CSP allows no remote resources. Mermaid, KaTeX, and
the markdown-it footnote/emoji/texmath plugins load from `node_modules` only
when a document needs them. The packaged allowlist ships the minified runtime
assets and prunes the rest of each dependency tree.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[PolyForm Noncommercial 1.0.0](LICENSE)

Personal, educational, research, and other noncommercial use is permitted.
Commercial use requires a separate written license from the copyright holder.

The already-published `v0.1.1` and `v0.1.2` releases were published under the
MIT license. Those grants cannot be revoked retroactively; this license applies
to the current source and future releases.
