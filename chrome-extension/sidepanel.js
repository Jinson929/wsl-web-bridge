// WSL Web Bridge - Side Panel Logic (v3.0.0)

const endpointInput = document.getElementById("endpointInput");
const tokenInput = document.getElementById("tokenInput");
const autoModeSelect = document.getElementById("autoModeSelect");
const maxAutoStepsInput = document.getElementById("maxAutoStepsInput");
const extraReadOnlyInput = document.getElementById("extraReadOnlyInput");
const transferModeSelect = document.getElementById("transferModeSelect");
const bundleModeSelect = document.getElementById("bundleModeSelect");
const attachThresholdInput = document.getElementById("attachThresholdInput");
const autoSendManualCb = document.getElementById("autoSendManualCb");
const connectBtn = document.getElementById("connectBtn");
const toggleConfigBtn = document.getElementById("toggleConfigBtn");
const configBody = document.getElementById("configBody");
const statusDot = document.getElementById("statusDot");
const workspaceBadge = document.getElementById("workspaceBadge");
const statusMsg = document.getElementById("statusMsg");
const refreshTreeBtn = document.getElementById("refreshTreeBtn");
const filterInput = document.getElementById("filterInput");
const treeContainer = document.getElementById("treeContainer");
const selectedCount = document.getElementById("selectedCount");
const clearSelBtn = document.getElementById("clearSelBtn");
const injectFilesBtn = document.getElementById("injectFilesBtn");
const injectProtocolBtn = document.getElementById("injectProtocolBtn");
const injectGitDiffBtn = document.getElementById("injectGitDiffBtn");

let cachedEntries = [];
const selectedPaths = new Set();
const expandedPaths = new Set();
let searchTimer = null;
let lastSearchQuery = "";

const PROTOCOL_PROMPT = `我们现在通过 WSL Web Bridge (v3.1) 协作开发本地 WSL 项目。
请使用以下代码块格式（L2 模式下，# @wsl-read 与只读白名单 # @wsl-cmd 会自动执行并回填发送；源码读取默认通过虚拟文件附件上传，对话框内仅保留轻量索引；写入与补丁始终由我手动点击确认，且支持一键撤销）：

1. 批量读取文件（每行一个相对路径，附件模式单轮可一次读 5-12 个文件，超大文件可用 :起始行-结束行 切片）：
\`\`\`text
# @wsl-read
backend/src/app.py
frontend-v5/src/index.ts:1-180
\`\`\`

2. 执行 WSL 命令（保持精简单行，支持 cwd=子目录）：
\`\`\`bash
# @wsl-cmd cwd=backend
git status -sb
\`\`\`

3. 局部修改已有文件（SEARCH 块保持最小上下文）：
\`\`\`text
# @wsl-patch: src/example.py
<<<<<<< SEARCH
old_code()
=======
new_code()
>>>>>>> REPLACE
\`\`\`

4. 写入或新建完整文件：
\`\`\`python
# @wsl-write: src/new_file.py
print("hello wsl")
\`\`\``;

function sendMsg(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res || !res.ok) {
        reject(new Error((res && res.error) || "操作失败"));
        return;
      }
      resolve(res);
    });
  });
}

function setStatus(text, type = "") {
  statusMsg.textContent = text;
  statusMsg.className = `status-msg ${type}`.trim();
}

function updateSelectedUI() {
  const count = selectedPaths.size;
  selectedCount.textContent = `已选 ${count} 个文件`;
  injectFilesBtn.disabled = count === 0;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function findNodeByPath(entries, targetPath) {
  for (const node of entries) {
    if (node.path === targetPath) return node;
    if (node.type === "dir" && node.children && node.children.length > 0) {
      const found = findNodeByPath(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

async function loadSubdirectory(dirNode) {
  const encoded = encodeURIComponent(dirNode.path);
  const res = await sendMsg({
    type: "BRIDGE_REQUEST",
    method: "GET",
    path: `/api/tree?dir=${encoded}&depth=1`
  });
  const target = findNodeByPath(cachedEntries, dirNode.path);
  if (target) {
    target.children = res.data.entries || [];
    target.hasMore = false;
  }
}

function filterTreeLocal(entries, keyword) {
  if (!keyword) return entries;
  const kw = keyword.toLowerCase();
  const out = [];
  for (const node of entries) {
    if (node.type === "file") {
      if (node.path.toLowerCase().includes(kw)) out.push(node);
    } else if (node.type === "dir") {
      const children = filterTreeLocal(node.children || [], kw);
      if (children.length > 0 || node.path.toLowerCase().includes(kw)) {
        out.push({ ...node, children });
      }
    }
  }
  return out;
}

function renderSearchResults(data) {
  treeContainer.innerHTML = "";
  const results = data.results || [];
  if (!results.length) {
    treeContainer.innerHTML = `<div class="empty-hint">未在仓库中找到匹配文件</div>`;
    return;
  }

  const meta = document.createElement("div");
  meta.style.cssText = "font-size:11px;color:#94a3b8;padding:2px 4px 6px 4px;";
  meta.textContent = data.truncated
    ? `共匹配 ${data.totalMatched} 个文件，仅展示前 ${results.length} 个（${data.source}）`
    : `共匹配 ${results.length} 个文件（${data.source}）`;
  treeContainer.appendChild(meta);

  const list = document.createElement("div");
  list.className = "tree-root";

  for (const item of results) {
    const label = document.createElement("label");
    label.className = "file-row";
    label.title = item.path;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedPaths.has(item.path);
    cb.addEventListener("change", () => {
      if (cb.checked) selectedPaths.add(item.path);
      else selectedPaths.delete(item.path);
      updateSelectedUI();
    });

    const span = document.createElement("span");
    span.className = "file-name";
    span.textContent = item.path;

    label.appendChild(cb);
    label.appendChild(span);
    list.appendChild(label);
  }
  treeContainer.appendChild(list);
}

function renderNodes(entries, container, isRoot = false) {
  const ul = document.createElement("div");
  ul.className = isRoot ? "tree-root" : "tree-dir";

  for (const node of entries) {
    if (node.type === "dir") {
      const details = document.createElement("details");
      details.open = expandedPaths.has(node.path);

      const summary = document.createElement("summary");
      summary.className = "dir-row";
      summary.title = node.path;
      summary.innerHTML = `<span class="dir-name">📁 ${escapeHtml(node.name)}</span>`;
      details.appendChild(summary);

      const childMount = document.createElement("div");
      if (node.children && node.children.length > 0) {
        renderNodes(node.children, childMount, false);
      } else if (node.hasMore) {
        childMount.innerHTML = `<div class="tree-dir" style="color:#64748b;padding:3px 6px;">点击展开加载...</div>`;
      }
      details.appendChild(childMount);

      details.addEventListener("toggle", async () => {
        if (details.open) {
          expandedPaths.add(node.path);
          if (node.hasMore) {
            childMount.innerHTML = `<div class="tree-dir" style="color:#94a3b8;padding:3px 6px;">加载中...</div>`;
            try {
              await loadSubdirectory(node);
              rerenderTree();
            } catch (err) {
              childMount.innerHTML = `<div class="tree-dir" style="color:#fca5a5;padding:3px 6px;">加载失败: ${escapeHtml(err.message)}</div>`;
            }
          }
        } else {
          expandedPaths.delete(node.path);
        }
      });

      ul.appendChild(details);
    } else {
      const label = document.createElement("label");
      label.className = "file-row";
      label.title = node.path;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selectedPaths.has(node.path);
      cb.addEventListener("change", () => {
        if (cb.checked) selectedPaths.add(node.path);
        else selectedPaths.delete(node.path);
        updateSelectedUI();
      });

      const span = document.createElement("span");
      span.className = "file-name";
      span.textContent = node.name;

      label.appendChild(cb);
      label.appendChild(span);
      ul.appendChild(label);
    }
  }

  container.appendChild(ul);
}

function rerenderTree() {
  treeContainer.innerHTML = "";
  if (!cachedEntries.length) {
    treeContainer.innerHTML = `<div class="empty-hint">目录为空</div>`;
    return;
  }
  renderNodes(cachedEntries, treeContainer, true);
}

async function runGlobalSearch(query) {
  const q = query.trim();
  lastSearchQuery = q;
  if (!q) {
    rerenderTree();
    return;
  }

  treeContainer.innerHTML = `<div class="empty-hint">正在全局搜索 "${escapeHtml(q)}"...</div>`;
  try {
    const res = await sendMsg({
      type: "BRIDGE_REQUEST",
      method: "GET",
      path: `/api/search?q=${encodeURIComponent(q)}&limit=100`
    });
    if (lastSearchQuery !== q) return;
    renderSearchResults(res.data);
  } catch {
    if (lastSearchQuery !== q) return;
    treeContainer.innerHTML = "";
    const filtered = filterTreeLocal(cachedEntries, q);
    if (!filtered.length) {
      treeContainer.innerHTML = `<div class="empty-hint">没有匹配的文件</div>`;
      return;
    }
    renderNodes(filtered, treeContainer, true);
  }
}

async function loadWorkspace() {
  try {
    setStatus("正在连接 WSL Bridge...");
    const infoRes = await sendMsg({ type: "BRIDGE_REQUEST", method: "GET", path: "/api/info" });
    const info = infoRes.data;
    statusDot.classList.add("online");
    workspaceBadge.textContent = info.gitBranch ? `${info.name} (${info.gitBranch})` : info.name;
    workspaceBadge.title = `${info.distro}: ${info.root}`;

    const treeRes = await sendMsg({ type: "BRIDGE_REQUEST", method: "GET", path: "/api/tree?depth=1" });
    cachedEntries = treeRes.data.entries || [];
    expandedPaths.clear();
    if (filterInput.value.trim()) {
      await runGlobalSearch(filterInput.value);
    } else {
      rerenderTree();
    }
    setStatus(`已连接 ${info.distro} · ${info.root}`, "success");
  } catch (err) {
    statusDot.classList.remove("online");
    workspaceBadge.textContent = "未连接";
    setStatus(err.message, "error");
  }
}

function makeTimeStampTag() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sanitizeAttachmentName(relPath) {
  const flat = String(relPath || "file")
    .replace(/^\/+/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "__");
  return flat.endsWith(".txt") || flat.endsWith(".md") ? flat : `${flat}.txt`;
}

async function injectToChat(text, successLabel) {
  try {
    const res = await sendMsg({ type: "INJECT_TEXT_TO_TAB", text });
    if (res.result && res.result.inserted) {
      setStatus(successLabel, "success");
    } else if (res.result && res.result.copiedToClipboard) {
      setStatus(res.result.reason || "已复制到剪贴板，请 Ctrl+V 粘贴", "success");
    } else {
      setStatus("已发送到页面", "success");
    }
  } catch (err) {
    await navigator.clipboard.writeText(text).catch(() => {});
    setStatus(`未检测到已打开的聊天标签页，内容已复制到剪贴板 (${err.message})`, "error");
  }
}

async function injectPayloadToChat(payload, successLabel) {
  try {
    const res = await sendMsg({ type: "INJECT_PAYLOAD_TO_TAB", payload, autoSend: false });
    const r = res.result || {};
    if (r.attachedCount > 0) {
      setStatus(`${successLabel}（已挂载 ${r.attachedCount} 个附件）`, "success");
    } else if (r.fallbackUsed) {
      setStatus(`${successLabel}（附件未生效，已降级为文本注入）`, "success");
    } else if (r.inserted) {
      setStatus(successLabel, "success");
    } else if (r.copiedToClipboard) {
      setStatus(r.reason || "已复制到剪贴板，请 Ctrl+V 粘贴", "success");
    } else {
      setStatus("已发送到页面", "success");
    }
  } catch (err) {
    const fallbackText = payload.fallbackText || payload.text || "";
    if (fallbackText) {
      await navigator.clipboard.writeText(fallbackText).catch(() => {});
    }
    setStatus(`未检测到已打开的聊天标签页，内容已复制到剪贴板 (${err.message})`, "error");
  }
}

async function saveCurrentSettings(reconnect = false) {
  try {
    await sendMsg({
      type: "SAVE_CONFIG",
      endpoint: endpointInput.value,
      token: tokenInput.value,
      autoMode: autoModeSelect.value,
      maxAutoSteps: maxAutoStepsInput.value,
      extraReadOnlyBins: extraReadOnlyInput.value,
      transferMode: transferModeSelect.value,
      bundleMode: bundleModeSelect.value,
      attachThresholdChars: attachThresholdInput.value,
      autoSendAfterManual: autoSendManualCb.checked
    });
    if (reconnect) {
      await loadWorkspace();
    } else {
      setStatus("自动化与传输设置已保存并立即生效", "success");
    }
  } catch (err) {
    setStatus(err.message, "error");
  }
}

toggleConfigBtn.addEventListener("click", () => {
  const hidden = configBody.style.display === "none";
  configBody.style.display = hidden ? "block" : "none";
  toggleConfigBtn.textContent = hidden ? "收起" : "展开";
});

connectBtn.addEventListener("click", () => saveCurrentSettings(true));
autoModeSelect.addEventListener("change", () => saveCurrentSettings(false));
autoSendManualCb.addEventListener("change", () => saveCurrentSettings(false));
maxAutoStepsInput.addEventListener("change", () => saveCurrentSettings(false));
extraReadOnlyInput.addEventListener("change", () => saveCurrentSettings(false));
transferModeSelect.addEventListener("change", () => saveCurrentSettings(false));
bundleModeSelect.addEventListener("change", () => saveCurrentSettings(false));
attachThresholdInput.addEventListener("change", () => saveCurrentSettings(false));

refreshTreeBtn.addEventListener("click", loadWorkspace);

filterInput.addEventListener("input", () => {
  if (searchTimer) clearTimeout(searchTimer);
  const val = filterInput.value;
  if (!val.trim()) {
    lastSearchQuery = "";
    rerenderTree();
    return;
  }
  searchTimer = setTimeout(() => {
    runGlobalSearch(val);
  }, 220);
});

clearSelBtn.addEventListener("click", () => {
  selectedPaths.clear();
  updateSelectedUI();
  if (filterInput.value.trim()) {
    runGlobalSearch(filterInput.value);
  } else {
    rerenderTree();
  }
});

injectProtocolBtn.addEventListener("click", () => {
  injectToChat(PROTOCOL_PROMPT, "已将 WSL 协作协议注入聊天输入框");
});

injectGitDiffBtn.addEventListener("click", async () => {
  try {
    setStatus("正在读取 git status & diff...");
    const cfgRes = await sendMsg({ type: "GET_CONFIG" });
    const cfg = cfgRes.config || {};
    const res = await sendMsg({ type: "BRIDGE_REQUEST", method: "GET", path: "/api/git/diff" });
    const d = res.data;
    const inlineParts = ["以下是当前 WSL 仓库的 Git 状态与改动："];
    if (d.status) inlineParts.push(`\`\`\`text\n${d.status}\n\`\`\``);
    if (d.diff && d.diff.trim()) {
      inlineParts.push(`\`\`\`diff\n${d.diff.trim()}\n\`\`\``);
    } else {
      inlineParts.push("（当前工作区无未暂存 Diff）");
    }
    const inlineText = inlineParts.join("\n\n");
    const threshold = cfg.attachThresholdChars || 4000;
    const shouldAttach =
      d.diff &&
      d.diff.trim() &&
      cfg.transferMode !== "text_only" &&
      (cfg.transferMode === "always_attach" || inlineText.length > threshold);

    if (shouldAttach) {
      const filename = `wsl-git-diff-${makeTimeStampTag()}.txt`;
      const bundleContent = [
        "# WSL Git Status & Diff",
        d.status ? `## git status\n${d.status}` : "",
        `## git diff\n${d.diff.trim()}`
      ].filter(Boolean).join("\n\n");
      const summaryLines = [
        `以下是当前 WSL 仓库的 Git 状态与改动（完整 Diff 已通过附件 \`${filename}\` 上传，${formatByteSize(bundleContent.length)}）：`
      ];
      if (d.status) {
        summaryLines.push(`\`\`\`text\n${d.status}\n\`\`\``);
      }
      await injectPayloadToChat(
        {
          text: summaryLines.join("\n\n"),
          fallbackText: inlineText,
          files: [{ name: filename, content: bundleContent, mimeType: "text/plain" }]
        },
        "已将 Git Diff 注入聊天页面"
      );
    } else {
      await injectToChat(inlineText, "已将 Git Diff 注入聊天输入框");
    }
  } catch (err) {
    setStatus(err.message, "error");
  }
});

injectFilesBtn.addEventListener("click", async () => {
  const paths = Array.from(selectedPaths);
  if (!paths.length) return;
  try {
    setStatus(`正在读取 ${paths.length} 个文件...`);
    const cfgRes = await sendMsg({ type: "GET_CONFIG" });
    const cfg = cfgRes.config || {};
    const res = await sendMsg({
      type: "BRIDGE_REQUEST",
      method: "POST",
      path: "/api/read",
      body: { paths }
    });
    const files = res.data.files || [];
    const inlineBlocks = ["以下是来自我本地 WSL 项目的文件上下文："];
    for (const f of files) {
      if (f.error) {
        inlineBlocks.push(`### \`${f.path}\`\n> 读取跳过：${f.error}`);
      } else {
        const ext = (f.path.split(".").pop() || "").toLowerCase();
        const truncNote = f.truncated ? " (内容过长已截断)" : "";
        inlineBlocks.push(`### \`${f.path}\`${truncNote}\n\`\`\`${ext}\n${f.content}\n\`\`\``);
      }
    }
    const inlineText = inlineBlocks.join("\n\n");

    const okFiles = files.filter((f) => !f.error);
    if (cfg.transferMode === "text_only" || okFiles.length === 0) {
      await injectToChat(inlineText, `已将 ${paths.length} 个文件注入聊天输入框`);
      return;
    }

    const usePerFile = cfg.bundleMode === "per_file" && okFiles.length <= 8;
    const attachFiles = [];
    const indexLines = [];

    if (usePerFile) {
      for (const f of okFiles) {
        const attachName = sanitizeAttachmentName(f.path);
        const linesCount = f.totalLines || f.lines || (f.content || "").split(/\r?\n/).length;
        const header = `// FILE: ${f.path} (共 ${linesCount} 行)\n\n`;
        attachFiles.push({
          name: attachName,
          content: header + (f.content || ""),
          mimeType: "text/plain"
        });
        indexLines.push(`- \`${f.path}\` (共 ${linesCount} 行) -> 附件 \`${attachName}\``);
      }
    } else {
      const bundleName = `wsl-context-${makeTimeStampTag()}.txt`;
      const bundleIndex = [];
      const bundleSections = [];
      okFiles.forEach((f, idx) => {
        const linesCount = f.totalLines || f.lines || (f.content || "").split(/\r?\n/).length;
        const truncNote = f.truncated ? " [truncated]" : "";
        bundleIndex.push(`${idx + 1}. ${f.path} (lines 1-${linesCount} / ${linesCount})${truncNote}`);
        bundleSections.push(
          `================================================================================\n` +
          `FILE: ${f.path} (lines 1-${linesCount} / ${linesCount})${truncNote}\n` +
          `================================================================================\n` +
          (f.content || "")
        );
        indexLines.push(`- \`${f.path}\` (共 ${linesCount} 行)${f.truncated ? " [已截断]" : ""}`);
      });
      const bundleContent =
        `# WSL Web Bridge Context Bundle\n` +
        `Files: ${okFiles.length}\n\n` +
        `## Index\n${bundleIndex.join("\n")}\n\n` +
        bundleSections.join("\n\n");
      attachFiles.push({ name: bundleName, content: bundleContent, mimeType: "text/plain" });
    }

    for (const f of files) {
      if (f.error) {
        indexLines.push(`- \`${f.path}\` [读取跳过: ${f.error}]`);
      }
    }

    const totalBytes = attachFiles.reduce((acc, f) => acc + (f.content ? f.content.length : 0), 0);
    const attachNamesText = attachFiles.map((f) => `\`${f.name}\``).join("、");
    const summaryText = [
      `以下是来自我本地 WSL 项目的源码上下文（已通过附件 ${attachNamesText} 上传，共 ${okFiles.length} 个文件 / ${formatByteSize(totalBytes)}）：`,
      ...indexLines,
      "请直接结合附件中的源码进行分析。"
    ].join("\n");

    await injectPayloadToChat(
      {
        text: summaryText,
        fallbackText: inlineText,
        files: attachFiles
      },
      `已将 ${paths.length} 个文件注入聊天页面`
    );
  } catch (err) {
    setStatus(err.message, "error");
  }
});

(async function init() {
  try {
    const res = await sendMsg({ type: "GET_CONFIG" });
    endpointInput.value = res.config.endpoint;
    tokenInput.value = res.config.token;
    autoModeSelect.value = res.config.autoMode || "l2_readonly";
    maxAutoStepsInput.value = String(res.config.maxAutoSteps ?? 0);
    extraReadOnlyInput.value = res.config.extraReadOnlyBins || "";
    transferModeSelect.value = res.config.transferMode || "auto_attach";
    bundleModeSelect.value = res.config.bundleMode || "single_bundle";
    attachThresholdInput.value = String(res.config.attachThresholdChars ?? 4000);
    autoSendManualCb.checked = res.config.autoSendAfterManual !== false;
    if (res.config.token) {
      await loadWorkspace();
    }
  } catch (err) {
    setStatus(err.message, "error");
  }
})();
