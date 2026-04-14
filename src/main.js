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

  document.title = `${name} \u2014 Lesepult`;
  window.scrollTo(0, 0);
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

// ─── Init ────────────────────────────────────────────────

(async () => {
  try {
    const r = await invoke("get_initial_file");
    if (r) return render(r.name, r.content, r.path);
  } catch (_) {}
  showWelcome();
})();
