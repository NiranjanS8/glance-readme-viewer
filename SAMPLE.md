# Glance — Sample README

Welcome to **Glance**, a lightweight README viewer. This file exercises the v1 render pipeline: tables, strikethrough, task lists, autolinks, and highlighted code.

## Task list

- [x] Open a file via menu, shortcut, or drag-and-drop
- [ ] Live-reload on change (v2)
- [ ] Sidebar file tree (v2)

## Table

| Feature | v1 | v2 |
|---|---|---|
| Render Markdown | yes | yes |
| Theme toggle | yes | yes |
| Recent files | no | yes |

## Code

```js
const { app, BrowserWindow } = require('electron');

function createWindow() {
  const win = new BrowserWindow({ width: 1100, height: 750 });
  win.loadFile('index.html');
}
```

```python
def greet(name: str) -> str:
    return f"Hello, {name}!"
```

Inline `code` looks like this. Deleted text looks like ~~this~~.

## Links

Autolink: https://electronjs.org and a [named link](https://github.com).

> External links must open in the default browser, never inside the app window.

---

<details>
<summary>Safe HTML still works</summary>

This `details` block renders GitHub-style. Dangerous markup is stripped silently — never shown, never run.

</details>

<!-- an HTML comment: stripped from the preview, never shown -->
