import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked, Lexer } from "marked";
import DOMPurify from "dompurify";
import "./style.css";

const app = document.getElementById("app");
let currentFile = null; // { name, content, path, modified, size, tokens, fmOffset }
let openFiles = []; // [{ name, content, path, modified, size }]
let activeIndex = -1;

// ─── Block index tracking ────────────────────────────────

let blockQueue = [];
let blockCounter = 0;

function injectAttr(html) {
  if (blockCounter >= blockQueue.length) return html;
  const idx = blockQueue[blockCounter++];
  return html.replace(/^<(\w+)/, `<$1 data-block-index="${idx}"`);
}

marked.use({
  renderer: {
    paragraph(token) {
      const body = this.parser.parseInline(token.tokens);
      return injectAttr(`<p>${body}</p>\n`);
    },
    heading(token) {
      const body = this.parser.parseInline(token.tokens);
      return injectAttr(`<h${token.depth}>${body}</h${token.depth}>\n`);
    },
    code(token) {
      const code = token.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const lang = token.lang ? ` class="language-${token.lang}"` : "";
      return injectAttr(`<pre><code${lang}>${code}\n</code></pre>\n`);
    },
    blockquote(token) {
      const body = this.parser.parse(token.tokens);
      return injectAttr(`<blockquote>${body}</blockquote>\n`);
    },
    list(token) {
      const tag = token.ordered ? "ol" : "ul";
      const start = token.ordered && token.start !== 1 ? ` start="${token.start}"` : "";
      let body = "";
      for (const item of token.items) {
        let itemBody = this.parser.parse(item.tokens, !!item.loose);
        if (item.task) {
          const cb = `<input type="checkbox"${item.checked ? " checked" : ""} disabled> `;
          itemBody = itemBody.replace(/^<p>/, `<p>${cb}`);
        }
        body += `<li>${itemBody}</li>\n`;
      }
      return injectAttr(`<${tag}${start}>${body}</${tag}>\n`);
    },
    table(token) {
      let header = "<tr>";
      for (let j = 0; j < token.header.length; j++) {
        const cell = token.header[j];
        const align = cell.align ? ` style="text-align:${cell.align}"` : "";
        header += `<th${align}>${this.parser.parseInline(cell.tokens)}</th>`;
      }
      header += "</tr>\n";
      let body = "";
      for (const row of token.rows) {
        body += "<tr>";
        for (let j = 0; j < row.length; j++) {
          const cell = row[j];
          const align = cell.align ? ` style="text-align:${cell.align}"` : "";
          body += `<td${align}>${this.parser.parseInline(cell.tokens)}</td>`;
        }
        body += "</tr>\n";
      }
      return injectAttr(`<table><thead>${header}</thead><tbody>${body}</tbody></table>\n`);
    },
    hr() {
      return injectAttr(`<hr>\n`);
    },
  },
});

// ─── Frontmatter ─────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: null, body: content, offset: 0 };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) meta[key] = val;
  }
  const offset = match[0].length;
  return { meta: Object.keys(meta).length ? meta : null, body: content.slice(offset), offset };
}

// ─── Tab / status bar ────────────────────────────────────

function countWords(content) {
  const body = content.replace(/^---[\s\S]*?---\r?\n?/, "");
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#*_~>|\\]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function renderBottomBar() {
  let bar = document.getElementById("bottom-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "bottom-bar";
    bar.className = "bottom-bar";
    document.body.appendChild(bar);
  }
  if (openFiles.length === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const tabList = document.createElement("div");
  tabList.className = "tab-list";
  openFiles.forEach((file, i) => {
    const tab = document.createElement("button");
    tab.className = "tab" + (i === activeIndex ? " tab-active" : "");
    tab.title = file.path ?? file.name;
    const nameSpan = document.createElement("span");
    nameSpan.textContent = file.name;
    tab.appendChild(nameSpan);
    if (openFiles.length > 1) {
      const closeSpan = document.createElement("span");
      closeSpan.className = "tab-close";
      closeSpan.textContent = "×";
      closeSpan.addEventListener("click", (e) => { e.stopPropagation(); closeTab(i); });
      tab.appendChild(closeSpan);
    }
    tab.addEventListener("click", () => { if (i !== activeIndex) switchToFile(i); });
    tabList.appendChild(tab);
  });

  const statusDiv = document.createElement("div");
  statusDiv.className = "status-bar";
  if (activeIndex >= 0 && activeIndex < openFiles.length) {
    const f = openFiles[activeIndex];
    const words = countWords(f.content);
    const mins = Math.max(1, Math.ceil(words / 200));
    const kb = Math.round(f.size / 1024);
    const parts = [
      words.toLocaleString("de-DE") + "\u00a0Wörter",
      mins + "\u00a0min",
      (kb > 0 ? kb : "<1") + "\u00a0KB",
    ];
    if (f.modified) {
      parts.push(new Date(f.modified * 1000).toLocaleDateString("de-DE", { day: "numeric", month: "short" }));
    }
    statusDiv.textContent = parts.join(" · ");
  }

  bar.replaceChildren(tabList, statusDiv);
}

function addFile({ name, content, path, modified = 0, size = 0 }) {
  const existing = path != null ? openFiles.findIndex((f) => f.path === path) : -1;
  if (existing >= 0) {
    activeIndex = existing;
  } else {
    openFiles.push({ name, content, path, modified, size });
    activeIndex = openFiles.length - 1;
  }
  renderActive();
}

function renderActive() {
  const f = openFiles[activeIndex];
  render(f.name, f.content, f.path, f.modified, f.size);
}

function switchToFile(i) {
  activeIndex = i;
  renderActive();
}

function closeTab(i) {
  openFiles.splice(i, 1);
  if (openFiles.length === 0) {
    activeIndex = -1;
    showWelcome();
    return;
  }
  if (activeIndex >= openFiles.length) activeIndex = openFiles.length - 1;
  else if (activeIndex > i) activeIndex--;
  renderActive();
}

// ─── Render ──────────────────────────────────────────────

function render(name, content, path, modified = 0, size = 0) {
  currentFile = { name, content, path, modified, size };
  const { meta: fmMeta, body: bodyContent, offset: fmOffset } = parseFrontmatter(content);
  const tokens = Lexer.lex(bodyContent);
  currentFile.tokens = tokens;
  currentFile.fmOffset = fmOffset;

  // Build queue of token indices that produce rendered output
  blockQueue = [];
  blockCounter = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "space") blockQueue.push(i);
  }

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

  const richBtn = makeCopyMenu("Mit Format kopieren", "\u00B6", [
    {
      label: "Für E-Mail",
      run: async (btn) => {
        const ok = await copyRichText(body.innerHTML, body.textContent || content);
        flash(btn, ok ? "Copied" : "Failed");
      },
    },
    {
      label: "Für LinkedIn",
      run: async (btn) => {
        try {
          await navigator.clipboard.writeText(tokensToUnicode(tokens));
          flash(btn, "Copied");
        } catch (_) {
          flash(btn, "Failed");
        }
      },
    },
  ]);

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

  // Inline editing via double-click
  body.addEventListener("dblclick", (e) => {
    const block = e.target.closest("[data-block-index]");
    if (!block) return;
    e.preventDefault();
    openBlockEditor(parseInt(block.dataset.blockIndex, 10));
  });

  document.title = `${name} \u2014 Lesepult`;
  window.scrollTo(0, 0);

  // Keep openFiles entry in sync (e.g. after block edit saves new content)
  if (activeIndex >= 0 && activeIndex < openFiles.length) {
    Object.assign(openFiles[activeIndex], { name, content, path, modified, size });
  }

  renderBottomBar();

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
  activeIndex = -1;
  openFiles = [];
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
        addFile(r);
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
      addFile({ name: "Zwischenablage", content: clip.value, path: null, modified: 0, size: clip.value.length });
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
  renderBottomBar();
}

// ─── Inline block editor ─────────────────────────────────

const BLOCK_LABELS = {
  heading: "Überschrift bearbeiten",
  paragraph: "Absatz bearbeiten",
  blockquote: "Zitat bearbeiten",
  code: "Codeblock bearbeiten",
  list: "Liste bearbeiten",
  table: "Tabelle bearbeiten",
  hr: "Trennlinie bearbeiten",
  html: "HTML bearbeiten",
};

function openBlockEditor(tokenIndex) {
  if (!currentFile || currentFile.path == null) return;
  const token = currentFile.tokens[tokenIndex];
  if (!token) return;

  const label = BLOCK_LABELS[token.type] || "Block bearbeiten";
  // Token raw usually ends with \n — trim trailing newlines for editing
  const rawText = token.raw.replace(/\n+$/, "");

  // Overlay
  const overlay = document.createElement("div");
  overlay.className = "edit-overlay";

  // Dialog
  const dialog = document.createElement("div");
  dialog.className = "edit-dialog";

  // Header
  const header = document.createElement("div");
  header.className = "edit-header";
  header.textContent = label;

  // Textarea
  const textarea = document.createElement("textarea");
  textarea.className = "edit-textarea";
  textarea.value = rawText;
  textarea.spellcheck = false;
  // Auto-size to fit content
  requestAnimationFrame(() => {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  });

  // Footer
  const footer = document.createElement("div");
  footer.className = "edit-footer";

  const info = document.createElement("span");
  info.className = "edit-info";
  info.textContent = "Änderungen werden direkt in der Datei gespeichert";

  const actions = document.createElement("span");
  actions.className = "edit-actions";

  const discardBtn = document.createElement("button");
  discardBtn.className = "edit-btn edit-btn-secondary";
  discardBtn.textContent = "Verwerfen";

  const saveBtn = document.createElement("button");
  saveBtn.className = "edit-btn edit-btn-primary";
  saveBtn.textContent = "Speichern";

  actions.append(discardBtn, saveBtn);
  footer.append(info, actions);
  dialog.append(header, textarea, footer);
  overlay.append(dialog);

  // Close handler
  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }

  // Save handler
  async function save() {
    const edited = textarea.value;
    // Preserve trailing newline convention from original raw
    const trailingMatch = token.raw.match(/(\n+)$/);
    const trailing = trailingMatch ? trailingMatch[1] : "\n";
    const editedRaw = edited + trailing;

    // Compute position of this token in the full content
    let offset = currentFile.fmOffset;
    for (let i = 0; i < tokenIndex; i++) {
      offset += currentFile.tokens[i].raw.length;
    }
    const end = offset + token.raw.length;
    const newContent =
      currentFile.content.slice(0, offset) +
      editedRaw +
      currentFile.content.slice(end);

    try {
      await invoke("write_file", { path: currentFile.path, content: newContent });
      close();
      render(currentFile.name, newContent, currentFile.path, currentFile.modified, currentFile.size);
    } catch (err) {
      console.error("save failed:", err);
      flash(saveBtn, "Fehler");
    }
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save(); }
  }

  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  discardBtn.addEventListener("click", close);
  saveBtn.addEventListener("click", save);
  document.addEventListener("keydown", onKey);

  document.body.append(overlay);
  textarea.focus();
  textarea.setSelectionRange(0, 0);
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

// ─── Unicode styled-text for LinkedIn ─────────────────────
// LinkedIn strips text/html on paste, so real bold/italic is lost.
// Workaround: remap letters/digits to Mathematical Sans-Serif code-point
// ranges that survive as "plain text". Accessibility trade-off:
// screen readers announce these as "mathematical bold B" etc.

const U_BOLD_UPPER = 0x1d5d4;   // 𝗔  sans-serif bold A
const U_BOLD_LOWER = 0x1d5ee;   // 𝗮  sans-serif bold a
const U_BOLD_DIGIT = 0x1d7ec;   // 𝟬  sans-serif bold 0
const U_ITAL_UPPER = 0x1d608;   // 𝘈  sans-serif italic A
const U_ITAL_LOWER = 0x1d622;   // 𝘢  sans-serif italic a
const U_BITA_UPPER = 0x1d63c;   // 𝘼  sans-serif bold italic A
const U_BITA_LOWER = 0x1d656;   // 𝙖  sans-serif bold italic a
const U_MONO_UPPER = 0x1d670;   // 𝙰  monospace A
const U_MONO_LOWER = 0x1d68a;   // 𝚊  monospace a
const U_MONO_DIGIT = 0x1d7f6;   // 𝟶  monospace 0

function mapChar(ch, upper, lower, digit) {
  const c = ch.codePointAt(0);
  if (c >= 0x41 && c <= 0x5a) return String.fromCodePoint(upper + (c - 0x41));
  if (c >= 0x61 && c <= 0x7a) return String.fromCodePoint(lower + (c - 0x61));
  if (digit && c >= 0x30 && c <= 0x39) return String.fromCodePoint(digit + (c - 0x30));
  return ch;
}

function styleText(s, { bold, italic, mono }) {
  if (mono) return [...s].map((ch) => mapChar(ch, U_MONO_UPPER, U_MONO_LOWER, U_MONO_DIGIT)).join("");
  if (bold && italic) return [...s].map((ch) => mapChar(ch, U_BITA_UPPER, U_BITA_LOWER, U_BOLD_DIGIT)).join("");
  if (bold) return [...s].map((ch) => mapChar(ch, U_BOLD_UPPER, U_BOLD_LOWER, U_BOLD_DIGIT)).join("");
  if (italic) return [...s].map((ch) => mapChar(ch, U_ITAL_UPPER, U_ITAL_LOWER, 0)).join("");
  return s;
}

function renderInlineU(tokens, style = {}) {
  let out = "";
  if (!tokens) return out;
  for (const t of tokens) {
    switch (t.type) {
      case "text":
      case "escape":
        if (t.tokens) out += renderInlineU(t.tokens, style);
        else out += styleText(t.text ?? t.raw ?? "", style);
        break;
      case "strong":
        out += renderInlineU(t.tokens, { ...style, bold: true });
        break;
      case "em":
        out += renderInlineU(t.tokens, { ...style, italic: true });
        break;
      case "codespan":
        out += styleText(t.text ?? "", { mono: true });
        break;
      case "del":
        out += renderInlineU(t.tokens, style);
        break;
      case "link": {
        const label = renderInlineU(t.tokens, style);
        const href = t.href ?? "";
        out += href && href !== label ? `${label} (${href})` : label;
        break;
      }
      case "image":
        out += styleText(t.text ?? "", style);
        break;
      case "br":
        out += "\n";
        break;
      case "html":
        break;
      default:
        if (t.tokens) out += renderInlineU(t.tokens, style);
        else if (t.text) out += styleText(t.text, style);
    }
  }
  return out;
}

function renderListItemU(tokens) {
  let out = "";
  if (!tokens) return out;
  for (const t of tokens) {
    if (t.type === "text") {
      out += t.tokens ? renderInlineU(t.tokens) : (t.text ?? "");
    } else if (t.type === "paragraph") {
      if (out) out += "\n";
      out += renderInlineU(t.tokens);
    } else if (t.type === "list") {
      let idx = t.start ?? 1;
      for (const sub of t.items) {
        const bullet = t.ordered ? `${idx}. ` : "◦ ";
        const body = renderListItemU(sub.tokens).replace(/\n/g, "\n  ");
        out += `\n  ${bullet}${body}`;
        idx++;
      }
    } else if (t.type === "code") {
      out += "\n" + styleText(t.text, { mono: true });
    }
  }
  return out;
}

function renderTableU(token) {
  const rows = [];
  rows.push(token.header.map((c) => styleText(renderInlineU(c.tokens), { bold: true })));
  for (const row of token.rows) {
    rows.push(row.map((c) => renderInlineU(c.tokens)));
  }
  return rows.map((r) => r.join("  |  ")).join("\n");
}

function tokensToUnicode(tokens) {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "heading":
        out += styleText(renderInlineU(token.tokens), { bold: true }) + "\n\n";
        break;
      case "paragraph":
        out += renderInlineU(token.tokens) + "\n\n";
        break;
      case "list": {
        let idx = token.start ?? 1;
        for (const item of token.items) {
          const bullet = token.ordered ? `${idx}. ` : "• ";
          out += bullet + renderListItemU(item.tokens).trimEnd() + "\n";
          idx++;
        }
        out += "\n";
        break;
      }
      case "code":
        out += styleText(token.text, { mono: true }) + "\n\n";
        break;
      case "blockquote": {
        const body = tokensToUnicode(token.tokens).trimEnd();
        out += body.split("\n").map((l) => (l ? `❝ ${l}` : l)).join("\n") + "\n\n";
        break;
      }
      case "hr":
        out += "──────────\n\n";
        break;
      case "table":
        out += renderTableU(token) + "\n\n";
        break;
      case "html":
        break;
      default:
        if (token.tokens) out += renderInlineU(token.tokens) + "\n\n";
    }
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Copy menu ───────────────────────────────────────────

function makeCopyMenu(label, icon, items) {
  const wrapper = document.createElement("span");
  wrapper.className = "meta-menu-wrapper";

  const btn = document.createElement("button");
  btn.className = "meta-btn";
  btn.title = label;
  btn.textContent = icon;

  const menu = document.createElement("div");
  menu.className = "meta-menu";
  menu.hidden = true;

  for (const item of items) {
    const entry = document.createElement("button");
    entry.className = "meta-menu-item";
    entry.textContent = item.label;
    entry.addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.hidden = true;
      await item.run(btn);
    });
    menu.append(entry);
  }

  let closeHandler = null;
  const close = () => {
    menu.hidden = true;
    if (closeHandler) {
      document.removeEventListener("click", closeHandler);
      document.removeEventListener("keydown", closeHandler);
      closeHandler = null;
    }
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!menu.hidden) { close(); return; }
    menu.hidden = false;
    closeHandler = (ev) => {
      if (ev.type === "keydown" && ev.key !== "Escape") return;
      close();
    };
    setTimeout(() => {
      document.addEventListener("click", closeHandler);
      document.addEventListener("keydown", closeHandler);
    }, 0);
  });

  wrapper.append(btn, menu);
  return wrapper;
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
    const files = await invoke("open_file_dialog");
    for (const f of files) addFile(f);
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
  const paths = (event.payload?.paths ?? []).filter((p) => /\.(md|markdown)$/i.test(p));
  for (const p of paths) {
    try {
      const r = await invoke("read_file_at_path", { path: p });
      addFile(r);
    } catch (_) {}
  }
});

// ─── macOS file association (open-with) ──────────────────

async function openPath(path) {
  try {
    const r = await invoke("read_file_at_path", { path });
    addFile(r);
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
      addFile(r);
      return;
    } catch (_) {}
  }

  try {
    const files = await invoke("get_initial_file");
    if (files && files.length > 0) {
      for (const f of files) addFile(f);
      return;
    }
  } catch (_) {}
  showWelcome();
})();
