import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import DOMPurify from "dompurify";
import "./style.css";

const app = document.getElementById("app");
let currentFile = null; // { name, content, path }

// ─── Render ──────────────────────────────────────────────

function render(name, content, path) {
  currentFile = { name, content, path };
  const safeHtml = DOMPurify.sanitize(marked.parse(content));

  const article = document.createElement("article");
  article.className = "article";

  // Meta bar with filename + action buttons
  const meta = document.createElement("div");
  meta.className = "article-meta";

  const filename = document.createElement("span");
  filename.className = "meta-filename";
  filename.textContent = name;

  const actions = document.createElement("span");
  actions.className = "meta-actions";

  const copyBtn = makeButton("Copy", "\u2398", () => {
    navigator.clipboard.writeText(content);
    flash(copyBtn, "Copied");
  });

  const shareBtn = makeButton("Share", "\u21AA", async () => {
    try {
      await invoke("share_file", { path });
    } catch (_) {
      navigator.clipboard.writeText(content);
      flash(shareBtn, "Copied");
    }
  });

  actions.append(copyBtn, shareBtn);
  meta.append(filename, actions);

  const body = document.createElement("div");
  body.className = "content";
  body.innerHTML = safeHtml;

  article.append(meta, body);
  app.replaceChildren(article);
  addCodeCopyButtons(body);
  wireLinks(body, path);

  document.title = `${name} \u2014 Lesepult`;
  window.scrollTo(0, 0);

  // Register this window as displaying `path` so other open_md_window calls
  // can focus it instead of opening a duplicate.
  invoke("set_window_file", { path }).catch(() => {});
}

function showWelcome() {
  currentFile = null;
  app.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "welcome";

  const title = document.createElement("p");
  title.className = "welcome-title";
  title.textContent = "Lesepult";

  const hint = document.createElement("p");
  hint.className = "welcome-hint";
  const kbd = document.createElement("kbd");
  kbd.textContent = "\u2318O";
  hint.append(kbd, " oder Markdown hierher ziehen");

  wrap.append(title, hint);
  app.append(wrap);
  document.title = "Lesepult";
  invoke("set_window_file", { path: null }).catch(() => {});
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
