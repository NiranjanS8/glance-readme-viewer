# Glance — README Viewer

A lightweight cross-platform desktop app that opens and renders Markdown files
(primarily READMEs) with clean, GitHub-style formatting. Serif prose, mono
chrome, flat surfaces, one accent color. No card-and-shadow dashboard look.

## Features

- Open `.md` / `.markdown` / `.mdown` files via **File > Open** (`Ctrl/Cmd+O`)
  or **drag-and-drop** onto the window
- GitHub-flavored rendering: tables, strikethrough, task lists, autolinks
- Syntax-highlighted fenced code blocks (highlight.js)
- Forgiving tables: delimiter rows with "smart" dashes (`|—|—|`, common in
  LLM- or chat-pasted markdown) render as real tables
- Safe HTML: `<details>`, `<div>`, `<br>` render; `<script>`, event handlers,
  and `javascript:` URLs are stripped silently
- Dark and light themes (`Ctrl/Cmd+T`), OS preference on first launch,
  persisted afterwards
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
macOS: DMG, Linux: AppImage). Local builds are **unsigned** — see
`signAndEditExecutable` in `package.json`. For public releases, sign with
your own certificate and remove that flag.

## Project structure

```
├── main.js       # Main process: window, menu, dialogs, file reads, IPC
├── preload.js    # contextBridge: the only Node/Electron access the renderer gets
├── renderer.js   # Markdown parsing, sanitizing, rendering, UI logic
├── index.html    # App shell
├── style.css     # Design tokens, themes, GitHub-style markdown styling
├── vendor/       # highlight.js browser bundle (npm ships no UMD build; see note below)
├── assets/       # App icon
└── SAMPLE.md     # Demo file exercising the render pipeline
```

## Security model

- `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer
- Main-process access (dialogs, file reads, `shell.openExternal`) goes only
  through `preload.js` via `contextBridge` — the renderer never touches Node
  or `fs` directly
- All rendered Markdown HTML passes through DOMPurify before hitting the DOM
- Strict Content Security Policy (`script-src 'self'`, no remote resources)

## Scripts

| Command         | What it does                              |
|-----------------|-------------------------------------------|
| `npm start`     | Launch the app in dev                     |
| `npm run build` | Package an installer for the current OS   |

## Tech stack

[Electron](https://www.electronjs.org/) ·
[markdown-it](https://github.com/markdown-it/markdown-it) ·
[highlight.js](https://highlightjs.org/) ·
[DOMPurify](https://github.com/cure53/DOMPurify) ·
[electron-builder](https://www.electron.build/)

Note: `vendor/highlight.min.js` is the official highlight.js browser bundle
(v11.10.0, via cdnjs), vendored because the npm package ships only ESM/CJS
builds. Everything else loads from `node_modules`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
