# Lesepult

Minimal desktop app that opens Markdown files and renders them with Tufte-style typography. No editing, no state — just reading.

## Features

- Open `.md` files via Cmd+O, drag & drop, or file association
- Tufte-inspired layout: Palatino body, Fraunces headings, IBM Plex Mono for code
- Copy buttons on code blocks
- Copy whole file to clipboard
- macOS native share sheet
- Light and dark mode (follows system)

## Install

```
brew tap sebastian-breitzke/tap
brew install --cask lesepult
```

Or download the DMG from [Releases](https://github.com/sebastian-breitzke/lesepult/releases).

## Build from source

Requires [Bun](https://bun.sh) and [Rust](https://rustup.rs).

```
bun install
make app
```

## Tech

- [Tauri v2](https://v2.tauri.app) (Rust + system WebView)
- [marked](https://marked.js.org) for Markdown parsing
- [Vite](https://vite.dev) for frontend bundling
- ~4 MB app size

## License

MIT — see [LICENSE](LICENSE).
