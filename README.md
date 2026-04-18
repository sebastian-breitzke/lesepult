# Lesepult

Minimal desktop app that opens Markdown files and renders them with clean typography. Read, review, make quick edits — nothing more.

## Features

- Open `.md` files via Cmd+O / Ctrl+O, drag & drop, or file association
- Tufte-inspired layout: Palatino body, Fraunces headings, IBM Plex Mono for code
- YAML frontmatter parsed and displayed as structured metadata block
- Clipboard detection on launch: open markdown files or render markdown text from clipboard
- Inline editing: double-click any block to edit its raw markdown, saved directly to file
- Copy as Markdown or rich text (for Teams, Word, Mail)
- Copy buttons on code blocks
- macOS native share sheet (Windows: copies to clipboard)
- Light and dark mode (follows system)

## Install

### macOS (Homebrew)

```
brew tap sebastian-breitzke/tap
brew install --cask lesepult
```

Or download the DMG from [Releases](https://github.com/sebastian-breitzke/lesepult/releases).

### Windows

Download the `.exe` installer or `.msi` from [Releases](https://github.com/sebastian-breitzke/lesepult/releases).

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
