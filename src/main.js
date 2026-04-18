import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import DOMPurify from "dompurify";
import "./style.css";

const app = document.getElementById("app");
let currentFile = null; // { name, content, path }

// ─── Frontmatter ─────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: null, body: content };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) meta[key] = val;
  }
  return { meta: Object.keys(meta).length ? meta : null, body: content.slice(match[0].length) };
}

// ─── Render ──────────────────────────────────────────────

function render(name, content, path) {
  currentFile = { name, content, path };
  const { meta: fmMeta, body: bodyContent } = parseFrontmatter(content);
  const safeHtml = DOMPurify.sanitize(marked.parse(bodyContent));

  const article = document.createElement("article");
  article.className = "article";

  // Meta bar with filename + action buttons
  const metaBar = document.createElement("div");
  metaBar.className = "article-meta";

  const filename = document.createElement("span");
  filename.className = "meta-filename";
  filename.textContent = name;

  const actions = document.createElement("span");
  actions.className = "meta-actions";

  const copyBtn = makeButton("Copy as Markdown", "\u2398", () => {
    navigator.clipboard.writeText(content);
    flash(copyBtn, "Copied");
  });

  const richBtn = makeButton("Copy as rich text", "\u00B6", async () => {
    const ok = await copyRichText(body.innerHTML, body.textContent || content);
    flash(richBtn, ok ? "Copied" : "Failed");
  });

  const shareBtn = makeButton("Share", "\u21AA", async () => {
    try {
      await invoke("share_file", { path });
    } catch (_) {
      navigator.clipboard.writeText(content);
      flash(shareBtn, "Copied");
    }
  });

  actions.append(copyBtn, richBtn, shareBtn);
  metaBar.append(filename, actions);

  // Frontmatter metadata block
  let fmBlock = null;
  if (fmMeta) {
    fmBlock = document.createElement("div");
    fmBlock.className = "frontmatter";
    const label = document.createElement("div");
    label.className = "frontmatter-label";
    label.textContent = "Metadaten";
    const table = document.createElement("table");
    table.className = "frontmatter-table";
    for (const [key, val] of Object.entries(fmMeta)) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.className = "fm-key";
      td1.textContent = key;
      const td2 = document.createElement("td");
      td2.className = "fm-val";
      td2.textContent = val;
      tr.append(td1, td2);
      table.append(tr);
    }
    fmBlock.append(label, table);
  }

  const body = document.createElement("div");
  body.className = "content";
  body.innerHTML = safeHtml;

  article.append(metaBar, ...(fmBlock ? [fmBlock] : []), body);
  app.replaceChildren(article);
  addCodeCopyButtons(body);
  wireLinks(body, path);

  document.title = `${name} \u2014 Lesepult`;
  window.scrollTo(0, 0);

  // Register this window as displaying `path` so other open_md_window calls
  // can focus it instead of opening a duplicate.
  invoke("set_window_file", { path }).catch(() => {});
}

// ─── Clipboard detection ─────────────────────────────────

function looksLikeMarkdown(text) {
  return /^#{1,6}\s/m.test(text) ||
    /\*\*[^*]+\*\*/m.test(text) ||
    /^```/m.test(text) ||
    /^\s*[-*+]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /\[.+\]\(.+\)/m.test(text) ||
    /^---\r?\n/.test(text);
}

function detectClipboard(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  if (trimmed.split("\n").length === 1 && /\.(md|markdown)$/i.test(trimmed)) {
    return { type: "path", value: trimmed };
  }
  if (looksLikeMarkdown(trimmed)) {
    return { type: "text", value: trimmed };
  }
  return null;
}

async function showWelcome() {
  currentFile = null;
  app.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "welcome";

  const title = document.createElement("p");
  title.className = "welcome-title";
  title.textContent = "Lesepult";

  // Check clipboard for markdown content
  let clip = null;
  try { clip = detectClipboard(await invoke("read_clipboard_text")); } catch (_) {}

  if (clip?.type === "path") {
    const msg = document.createElement("p");
    msg.className = "welcome-clip-msg";
    msg.textContent = "Markdown-Datei in der Zwischenablage";

    const cta = document.createElement("button");
    cta.className = "welcome-cta";
    cta.textContent = "Anzeigen";
    cta.addEventListener("click", async () => {
      try {
        const r = await invoke("read_file_at_path", { path: clip.value });
        render(r.name, r.content, r.path);
      } catch (_) {
        flash(cta, "Nicht gefunden");
      }
    });

    const hint = document.createElement("p");
    hint.className = "welcome-hint";
    const kbd = document.createElement("kbd");
    kbd.textContent = "\u2318O";
    hint.append(kbd, " oder Markdown hierher ziehen");

    wrap.append(title, msg, cta, hint);
  } else if (clip?.type === "text") {
    const msg = document.createElement("p");
    msg.className = "welcome-clip-msg";
    msg.textContent = "Markdown-Text in der Zwischenablage";

    const cta = document.createElement("button");
    cta.className = "welcome-cta";
    cta.textContent = "Anzeigen";
    cta.addEventListener("click", () => {
      render("Zwischenablage", clip.value, null);
    });

    const hint = document.createElement("p");
    hint.className = "welcome-hint";
    const kbd = document.createElement("kbd");
    kbd.textContent = "\u2318O";
    hint.append(kbd, " oder Markdown hierher ziehen");

    wrap.append(title, msg, cta, hint);
  } else {
    const hint = document.createElement("p");
    hint.className = "welcome-hint";
    const kbd = document.createElement("kbd");
    kbd.textContent = "\u2318O";
    hint.append(kbd, " oder Markdown hierher ziehen");

    wrap.append(title, hint);
  }

  app.append(wrap);
  document.title = "Lesepult";
  invoke("set_window_file", { path: null }).catch(() => {});
}

// ─── Rich text clipboard ─────────────────────────────────
// Writes both text/html and text/plain so Teams, Word, Mail, etc. paste
// with formatting, while plain-text targets still get readable content.

async function copyRichText(html, plain) {
  try {
    const item = new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plain], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch (err) {
    console.error("rich copy failed:", err);
    try {
      await navigator.clipboard.writeText(plain);
      return true;
    } catch (_) {
      return false;
    }
  }
}

// ─── Link handling ───────────────────────────────────────
// External URLs -> OS default browser. In-page anchors keep default.

function wireLinks(container, basePath) {
  container.addEventListener("click", async (e) => {
    const a = e.target.closest("a");
    if (!a || !container.contains(a)) return;

    const href = a.getAttribute("href");
    if (!href || href.startsWith("#")) return;

    const hasScheme = /^([a-z][a-z0-9+.\-]*):/i.test(href);
    if (hasScheme) {
      e.preventDefault();
      try {
        await invoke("open_external", { url: href });
      } catch (err) {
        console.error("open_external failed:", err);
      }
      return;
    }

    // Local path: .md -> new Lesepult window, anything else -> OS opener.
    e.preventDefault();
    const [filePath] = href.split("#");
    if (/\.(md|markdown)$/i.test(filePath)) {
      try {
        await invoke("open_md_window", { path: filePath, base: basePath ?? null });
      } catch (err) {
        console.error("open_md_window failed:", err);
      }
    } else {
      try {
        await invoke("open_external", { url: href });
      } catch (err) {
        console.error("open_external failed:", err);
      }
    }
  });
}

// ─── Copy buttons on code blocks ─────────────────────────

function addCodeCopyButtons(container) {
  for (const pre of container.querySelectorAll("pre")) {
    const btn = document.createElement("button");
    btn.className = "code-copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code");
      navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
      flash(btn, "Copied");
    });
    pre.style.position = "relative";
    pre.append(btn);
  }
}

// ─── Helpers ─────────────────────────────────────────────

function makeButton(label, icon, onClick) {
  const btn = document.createElement("button");
  btn.className = "meta-btn";
  btn.title = label;
  btn.textContent = icon;
  btn.addEventListener("click", onClick);
  return btn;
}

function flash(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  btn.classList.add("flashed");
  setTimeout(() => {
    btn.textContent = orig;
    btn.classList.remove("flashed");
  }, 1200);
}

// ─── File open ───────────────────────────────────────────

async function openFile() {
  try {
    const r = await invoke("open_file_dialog");
    if (r) render(r.name, r.content, r.path);
  } catch (_) {}
}

// Cmd+O
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "o") {
    e.preventDefault();
    openFile();
  }
});

// ─── Drag & drop ─────────────────────────────────────────

listen("tauri://drag-enter", () => document.body.classList.add("drag-over"));
listen("tauri://drag-leave", () => document.body.classList.remove("drag-over"));
listen("tauri://drag-drop", async (event) => {
  document.body.classList.remove("drag-over");
  const paths = event.payload?.paths ?? [];
  const md = paths.find((p) => /\.(md|markdown)$/i.test(p));
  if (md) {
    try {
      const r = await invoke("read_file_at_path", { path: md });
      render(r.name, r.content, r.path);
    } catch (_) {}
  }
});

// ─── macOS file association (open-with) ──────────────────

async function openPath(path) {
  try {
    const r = await invoke("read_file_at_path", { path });
    render(r.name, r.content, r.path);
  } catch (_) {}
}

// ─── Init ────────────────────────────────────────────────

function getFileFromHash() {
  const hash = window.location.hash;
  if (!hash.startsWith("#file=")) return null;
  try {
    return decodeURIComponent(hash.slice("#file=".length));
  } catch (_) {
    return null;
  }
}

(async () => {
  // Register open-file listener BEFORE checking initial file
  await listen("open-file", (event) => openPath(event.payload));

  // New-window path: file passed via URL hash (#file=<encoded path>)
  const hashed = getFileFromHash();
  if (hashed) {
    try {
      const r = await invoke("read_file_at_path", { path: hashed });
      return render(r.name, r.content, r.path);
    } catch (_) {}
  }

  try {
    const r = await invoke("get_initial_file");
    if (r) return render(r.name, r.content, r.path);
  } catch (_) {}
  showWelcome();
})();
