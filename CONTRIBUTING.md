# Contributing to Glance

Thanks for helping out. Keep it small, quiet, and readable — same as the app.

## Setup

```bash
npm install
npm start
```

Open `SAMPLE.md` to exercise tables, task lists, code blocks, themes, and links.

## How to contribute

1. Fork the repo and create a branch from `main`.
2. Make the smallest change that solves the problem; match the existing
   code style (plain functions, explicit names, no new abstractions unless
   they earn their place).
3. Test manually: open `SAMPLE.md` plus a file of your own, in **both**
   themes, via menu, shortcut, and drag-and-drop.
4. Open a pull request describing what changed and how you tested it.

## Ground rules

- **Security is non-negotiable.** Never enable `nodeIntegration`, never give
  the renderer direct Node/`fs` access, and never inject unsanitized HTML.
  All main-process access goes through `preload.js`.
- **Design system lives in `style.css`.** New UI must use the existing
  tokens (`--bg`, `--text`, `--accent`, …), hairline borders instead of
  shadows, and the serif-prose / mono-chrome type split.
- Don't commit `node_modules/`, `dist/`, or OS/editor files — they're gitignored.
- Don't commit the `vendor/highlight.min.js` replacement unless the pinned
  version changes; note the version and source in `README.md`.

## Releases

Maintainers build installers with `npm run build`. Public releases should be
code-signed — remove `signAndEditExecutable: false` from `package.json` and
configure signing per the
[electron-builder docs](https://www.electron.build/code-signing).
