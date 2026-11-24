// WSL Web Bridge - Content Script (v3.0.0)
// Features:
// - Server-side line-range /api/read (with client-side fallback for older bridges)
// - One-click Undo Snapshot button on /api/write and /api/patch cards
// - Multi-card accumulation & sequential batch execution bar
// - Bottom-right floating L2 Pause/Resume pill

(() => {
  const PROCESSED_ATTR = "data-wslb-bound";
  const MAX_CHAT_INSERT_CHARS = 24000;
  const MAX_PER_FILE_CHARS = 8000;
  let consecutiveAutoSteps = 0;
  let autoLoopPaused = false;
  let sawLiveStream = false;
  let autoArmedForNextScan = false;
  let cachedConfig = {
    autoMode: "l2_readonly",
    autoSendAfterManual: true,
    maxAutoSteps: 0,
    extraReadOnlyBins: ""
  };

  const cardExecutors = new WeakMap();

  const READ_ONLY_BINS = new Set([
    "ls", "ll", "pwd", "cat", "head", "tail", "wc", "file", "stat",
    "tree", "rg", "grep", "egrep", "fgrep", "find", "which", "uname", "whoami",
    "sort", "uniq", "cut", "awk", "sed", "du", "df", "jq", "fd", "bat"
  ]);
  const READ_ONLY_GIT_SUBS = new Set([
    "status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "grep", "blame", "tag"
  ]);

  // ---- Floating L2 Control Pill ----
  let floatPill = null;
  let floatDot = null;
  let floatLabel = null;
  let floatToggleBtn = null;

  function ensureFloatingPill() {
    if (floatPill && document.body.contains(floatPill)) return;
    floatPill = document.createElement("div");
    floatPill.className = "wslb-float-pill";

    floatDot = document.createElement("span");
    floatDot.className = "wslb-float-dot";

    floatLabel = document.createElement("span");
    floatLabel.className = "wslb-float-label";
    floatLabel.textContent = "WSL Bridge · L2 运行中";

    floatToggleBtn = document.createElement("button");
    floatToggleBtn.type = "button";
    floatToggleBtn.className = "wslb-float-toggle";
    floatToggleBtn.textContent = "暂停 L2";

    floatToggleBtn.addEventListener("click", () => {
      if (cachedConfig.autoMode !== "l2_readonly") {
        // Switch from L1 manual to L2 active directly
        chrome.runtime.sendMessage({ type: "SAVE_CONFIG", autoMode: "l2_readonly" }, () => {
          cachedConfig.autoMode = "l2_readonly";
          autoLoopPaused = false;
          consecutiveAutoSteps = 0;
          refreshFloatingPill();
        });
        return;
      }
      autoLoopPaused = !autoLoopPaused;
      if (!autoLoopPaused) {
        consecutiveAutoSteps = 0;
      }
      refreshFloatingPill();
    });

    floatPill.appendChild(floatDot);
    floatPill.appendChild(floatLabel);
    floatPill.appendChild(floatToggleBtn);
    document.body.appendChild(floatPill);
    refreshFloatingPill();
  }

  function refreshFloatingPill() {
    if (!floatPill) return;
    if (cachedConfig.autoMode !== "l2_readonly") {
      floatDot.className = "wslb-float-dot manual";
      floatLabel.textContent = "WSL Bridge · L1 手动";
      floatToggleBtn.textContent = "开启 L2";
    } else if (autoLoopPaused) {
      floatDot.className = "wslb-float-dot paused";
      floatLabel.textContent = "WSL Bridge · L2 已暂停";
      floatToggleBtn.textContent = "恢复 L2";
    } else {
      floatDot.className = "wslb-float-dot";
      floatLabel.textContent = "WSL Bridge · L2 运行中";
      floatToggleBtn.textContent = "暂停 L2";
    }
  }

  function getExtraReadOnlySet(extraStr) {
    const out = new Set();
    if (!extraStr) return out;
    for (const item of String(extraStr).split(/[,，\s]+/)) {
      const clean = item.trim();
      if (clean) out.add(clean);
    }
    return out;
  }

  function splitSafePipeline(command) {
    const trimmed = (command || "").trim();
    if (!trimmed || /[\r\n]/.test(trimmed)) return null;

    const segments = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      const next = trimmed[i + 1] || "";

      if (inSingle) {
        if (ch === "'") inSingle = false;
        current += ch;
        continue;
      }

      if (inDouble) {
        if (ch === "\\" && i + 1 < trimmed.length) {
          current += ch + next;
          i++;
          continue;
        }
        if (ch === "`" || (ch === "$" && next === "(")) return null;
        if (ch === '"') inDouble = false;
        current += ch;
        continue;
      }

      if (ch === "\\" && i + 1 < trimmed.length) {
        current += ch + next;
        i++;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        current += ch;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        current += ch;
        continue;
      }
      if (ch === ";" || ch === ">" || ch === "<" || ch === "`" || (ch === "$" && next === "(")) {
        return null;
      }
      if (ch === "&") return null;
      if (ch === "|") {
        if (next === "|") return null;
        segments.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }

    if (inSingle || inDouble) return null;
    if (current.trim()) segments.push(current.trim());
    return segments;
  }

  function isSafeReadOnlyCommand(command, extraBinsStr = "") {
    const segments = splitSafePipeline(command);
    if (!segments || segments.length === 0 || segments.length > 6) return false;
    const extraBins = getExtraReadOnlySet(extraBinsStr);

    for (const seg of segments) {
      const tokens = seg.split(/\s+/).filter(Boolean);
      if (!tokens.length) return false;
      const bin = tokens[0];
      const args = tokens.slice(1);

      if (bin === "git") {
        let subIdx = 0;
        while (subIdx < args.length && (args[subIdx] === "-C" || args[subIdx] === "--no-pager")) {
          subIdx += args[subIdx] === "-C" ? 2 : 1;
        }
        const sub = args[subIdx] || "";
        if (!READ_ONLY_GIT_SUBS.has(sub)) return false;
        if (sub === "branch" && args.some((a) => /^-[dDmMcC]/.test(a) || a === "--delete")) return false;
        continue;
      }

      if (!READ_ONLY_BINS.has(bin) && !extraBins.has(bin)) return false;

      if (bin === "find") {
        const forbiddenFind = args.some((a) =>
          ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprintf"].includes(a)
        );
        if (forbiddenFind) return false;
      }

      if (bin === "sed") {
        if (args.some((a) => a === "-i" || a.startsWith("-i") || a.startsWith("--in-place"))) return false;
      }
    }
    return true;
  }

  function parseReadSpec(rawLine) {
    const cleaned = rawLine.trim().replace(/^[-*]\s+/, "").replace(/^`|`$/g, "");
    if (!cleaned || cleaned.startsWith("#")) return null;
    const m = cleaned.match(/^(.+?):(\d+)(?:-(\d+))?$/);
    if (m) {
      const start = Math.max(1, parseInt(m[2], 10));
      const end = m[3] ? Math.max(start, parseInt(m[3], 10)) : start + 150;
      return { raw: `${m[1].trim()}:${start}-${end}`, path: m[1].trim(), start, end };
    }
    return { raw: cleaned, path: cleaned, start: null, end: null };
  }

  // ---- Chat Input & Send Button Helpers ----
  function findChatInput() {
    const selectors = [
      'rich-textarea div.ql-editor[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea[aria-label]',
      'textarea'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'button[aria-label="Send message"]',
      'button[aria-label="发送消息"]',
      'button[aria-label="发送"]',
      'button.send-button',
      'button[data-test-id="send-button"]',
      'button[mattooltip*="Send"]',
      'button[mattooltip*="发送"]'
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        return btn;
      }
    }
    return null;
  }

  function triggerSendChat() {
    const input = findChatInput();
    const sendBtn = findSendButton();
    if (sendBtn) {
      sendBtn.click();
      return true;
    }
    if (input) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      return true;
    }
    return false;
  }

  function isAssistantStreaming() {
    const stopSelectors = [
      'button[aria-label="Stop response"]',
      'button[aria-label="停止回答"]',
      'button[aria-label="停止生成"]',
      'button[aria-label="Stop generating"]'
    ];
    for (const sel of stopSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return true;
    }
    return false;
  }

  function clampChatPayload(text) {
    if (text.length <= MAX_CHAT_INSERT_CHARS) return text;
    return (
      text.slice(0, MAX_CHAT_INSERT_CHARS) +
      `\n\n... [内容总长 ${text.length} 字符，为防止浏览器输入框卡死已截断至 ${MAX_CHAT_INSERT_CHARS} 字符；请拆分请求或使用 \`路径:起始行-结束行\` 分段读取]`
    );
  }

  function insertTextIntoChat(rawText, autoSend = false) {
    const text = clampChatPayload(rawText || "");
    const input = findChatInput();
    if (!input) {
      navigator.clipboard.writeText(text).catch(() => {});
      return { inserted: false, copiedToClipboard: true, reason: "未检测到聊天输入框，已复制到剪贴板，请直接 Ctrl+V 粘贴" };
    }

    input.focus();

    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
      const existing = input.value || "";
      const sep = existing.trim() ? "\n\n" : "";
      input.value = existing + sep + text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const existingText = (input.innerText || "").trim();
      const prefix = existingText ? "\n\n" : "";
      const payload = prefix + text;

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);

      let inserted = false;
      if (payload.length > 1500 && typeof DataTransfer !== "undefined" && typeof ClipboardEvent !== "undefined") {
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", payload);
          const pasteEvt = new ClipboardEvent("paste", {
            clipboardData: dt,
            bubbles: true,
            cancelable: true
          });
          input.dispatchEvent(pasteEvt);
          if ((input.innerText || "").length > existingText.length + 10) {
            inserted = true;
          }
        } catch {
          inserted = false;
        }
      }

      if (!inserted) {
        const ok = document.execCommand("insertText", false, payload);
        if (!ok) {
          input.textContent = existingText + payload;
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: payload }));
        }
      }
    }

    if (autoSend) {
      setTimeout(() => {
        triggerSendChat();
      }, 320);
    }

    return { inserted: true, autoSent: Boolean(autoSend) };
  }

  document.addEventListener("keydown", (e) => {
    if (e.isTrusted && e.key === "Enter" && !e.shiftKey) {
      consecutiveAutoSteps = 0;
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "INSERT_CHAT_TEXT") {
      const result = insertTextIntoChat(message.text || "", Boolean(message.autoSend));
      sendResponse(result);
    }
  });

  // ---- Config & Bridge Helpers ----
  function getConfig() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          resolve(cachedConfig);
          return;
        }
        cachedConfig = res.config;
        refreshFloatingPill();
        resolve(res.config);
      });
    });
  }

  function sendBridgeRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "BRIDGE_REQUEST", method, path, body },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response || !response.ok) {
            reject(new Error((response && response.error) || "请求失败"));
            return;
          }
          resolve(response.data);
        }
      );
    });
  }

  // ---- Action Block Parsing ----
  function parseSearchReplaceBlocks(body) {
    const edits = [];
    const regex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
      edits.push({ search: match[1], replace: match[2] });
    }
    return edits;
  }

  function parseActionFromCodeBlock(codeText, extraBinsStr) {
    const trimmed = codeText.trim();
    if (!trimmed) return null;

    const lines = trimmed.split(/\r?\n/);
    const firstLine = lines[0].trim();

    if (/^#\s*@wsl-read$/i.test(firstLine)) {
      const specs = lines.slice(1).map(parseReadSpec).filter(Boolean);
      if (specs.length === 0) return null;
      // Send raw specs ("path:start-end") to Go v3.0 server for server-side line slicing
      const paths = specs.map((s) => s.raw);
      return {
        kind: "read",
        readOnly: true,
        label: "读取 WSL 文件",
        summary: specs.length === 1 ? specs[0].raw : `${specs[0].raw} 等 ${specs.length} 个文件`,
        specs,
        payload: { paths }
      };
    }

    if (/^#\s*@wsl-cmd(?:\s+cwd=(\S+))?$/i.test(firstLine)) {
      const m = firstLine.match(/^#\s*@wsl-cmd(?:\s+cwd=(\S+))?$/i);
      const cwd = m && m[1] ? m[1] : ".";
      const command = lines.slice(1).join("\n").trim();
      if (!command) return null;
      const readOnly = isSafeReadOnlyCommand(command, extraBinsStr);
      return {
        kind: "exec",
        readOnly,
        label: readOnly ? "WSL 只读命令" : "WSL 命令",
        summary: command.split("\n")[0].slice(0, 120),
        payload: { command, cwd }
      };
    }

    if (/^#\s*@wsl-write:\s*(.+)$/i.test(firstLine)) {
      const relPath = firstLine.replace(/^#\s*@wsl-write:\s*/i, "").trim();
      const content = lines.slice(1).join("\n") + "\n";
      if (!relPath) return null;
      return {
        kind: "write",
        readOnly: false,
        label: "写入文件",
        summary: relPath,
        payload: { path: relPath, content }
      };
    }

    if (/^#\s*@wsl-patch:\s*(.+)$/i.test(firstLine)) {
      const relPath = firstLine.replace(/^#\s*@wsl-patch:\s*/i, "").trim();
      const rest = lines.slice(1).join("\n");
      const edits = parseSearchReplaceBlocks(rest);
      if (!relPath || edits.length === 0) return null;
      return {
        kind: "patch",
        readOnly: false,
        label: "应用补丁",
        summary: `${relPath} (${edits.length} 处修改)`,
        payload: { path: relPath, edits }
      };
    }

    if (/^#\s*@wsl-diff$/i.test(firstLine)) {
      const diff = lines.slice(1).join("\n").trim();
      if (!diff) return null;
      return {
        kind: "patch",
        readOnly: false,
        label: "应用 Git Diff",
        summary: "Unified Diff 补丁",
        payload: { diff }
      };
    }

    return null;
  }

  function formatResultForChat(action, data) {
    if (action.kind === "read") {
      const specs = action.specs || [];
      const files = data.files || [];
      const perFileBudget = files.length > 1 ? Math.min(MAX_PER_FILE_CHARS, Math.floor((MAX_CHAT_INSERT_CHARS - 1200) / files.length)) : MAX_CHAT_INSERT_CHARS - 1000;
      const blocks = ["[WSL 文件读取结果]"];

      files.forEach((f, idx) => {
        if (f.error) {
          blocks.push(`### \`${f.path}\`\n> 读取跳过：${f.error}`);
          return;
        }
        const spec = specs[idx] || { start: null, end: null };
        const ext = (f.path.split(".").pop() || "").toLowerCase();

        let displayContent = f.content || "";
        let totalLines = f.totalLines || displayContent.split(/\r?\n/).length;
        let headerNote = ` (共 ${totalLines} 行)`;

        if (f.sliced) {
          headerNote = ` (第 ${f.startLine}-${f.endLine} 行 / 共 ${totalLines} 行)`;
        } else if (spec.start !== null) {
          const allLines = displayContent.split(/\r?\n/);
          totalLines = allLines.length;
          displayContent = allLines.slice(spec.start - 1, spec.end).join("\n");
          headerNote = ` (第 ${spec.start}-${Math.min(spec.end, totalLines)} 行 / 共 ${totalLines} 行)`;
        }

        if (displayContent.length > perFileBudget) {
          const shownLines = displayContent.slice(0, perFileBudget).split(/\r?\n/).length;
          const nextStart = (f.sliced ? f.startLine : 1) + shownLines;
          displayContent =
            displayContent.slice(0, perFileBudget) +
            `\n... [已按防卡顿配额截断，仅展示前约 ${shownLines} 行；如需后续请用 \`${f.path}:${nextStart}-${Math.min(totalLines, nextStart + 150)}\` 分段读取]`;
          headerNote += " [已截断]";
        }

        blocks.push(`### \`${f.path}\`${headerNote}\n\`\`\`${ext}\n${displayContent}\n\`\`\``);
      });

      return clampChatPayload(blocks.join("\n\n"));
    }

    if (action.kind === "exec") {
      const out = [
        `[WSL 命令执行结果]`,
        `命令: \`${action.payload.command}\``,
        `退出码: ${data.returncode} (${data.durationMs}ms)`
      ];
      if (data.stdout && data.stdout.trim()) {
        out.push(`\`\`\`text\n${data.stdout.trim()}\n\`\`\``);
      }
      if (data.stderr && data.stderr.trim()) {
        out.push(`stderr:\n\`\`\`text\n${data.stderr.trim()}\n\`\`\``);
      }
      return clampChatPayload(out.join("\n"));
    }

    if (action.kind === "write") {
      const out = [`[WSL 文件写入完成] \`${data.path}\` (${data.bytesWritten} bytes)`];
      if (data.diff && data.diff.trim()) {
        out.push(`\`\`\`diff\n${data.diff.trim()}\n\`\`\``);
      }
      return clampChatPayload(out.join("\n"));
    }

    const matchNote = data.matchMode === "tolerant-line" ? " (行级宽松匹配)" : "";
    const out = [`[WSL 补丁已应用] ${data.path || data.mode}${matchNote}`];
    if (data.diff && data.diff.trim()) {
      out.push(`\`\`\`diff\n${data.diff.trim()}\n\`\`\``);
    }
    return clampChatPayload(out.join("\n"));
  }

  function findTurnContainer(el) {
    return el.closest("model-response, .model-response, message-content");
  }

  function getPendingCardsInTurn(turnEl) {
    if (!turnEl) return [];
    return Array.from(turnEl.querySelectorAll('.wslb-card[data-wsl-executed="0"]'));
  }

  function updateBatchBarForTurn(turnEl) {
    if (!turnEl) return;
    const allCards = Array.from(turnEl.querySelectorAll(".wslb-card"));
    if (allCards.length < 2) return;

    const pending = getPendingCardsInTurn(turnEl);
    let bar = turnEl.querySelector(".wslb-batch-bar");

    if (!bar) {
      bar = document.createElement("div");
      bar.className = "wslb-batch-bar";

      const info = document.createElement("span");
      info.className = "wslb-batch-info";

      const btns = document.createElement("div");
      btns.className = "wslb-actions";

      const runAllBtn = document.createElement("button");
      runAllBtn.type = "button";
      runAllBtn.className = "wslb-btn wslb-btn-primary";
      runAllBtn.textContent = "按顺序全部执行";

      const sendNowBtn = document.createElement("button");
      sendNowBtn.type = "button";
      sendNowBtn.className = "wslb-btn wslb-btn-secondary";
      sendNowBtn.textContent = "立即发送已暂存结果";

      runAllBtn.addEventListener("click", async () => {
        const toRun = getPendingCardsInTurn(turnEl);
        if (!toRun.length) return;
        runAllBtn.disabled = true;
        runAllBtn.textContent = "批量执行中...";
        consecutiveAutoSteps = 0;

        let allOk = true;
        for (let i = 0; i < toRun.length; i++) {
          const cardEl = toRun[i];
          const execFn = cardExecutors.get(cardEl);
          if (!execFn) continue;
          const isLast = i === toRun.length - 1;
          const ok = await execFn({ isAuto: false, deferSend: !isLast });
          if (!ok) {
            allOk = false;
            break;
          }
        }
        runAllBtn.disabled = false;
        runAllBtn.textContent = allOk ? "全部执行完成 ✓" : "遇到错误已暂停";
        updateBatchBarForTurn(turnEl);
      });

      sendNowBtn.addEventListener("click", () => {
        triggerSendChat();
      });

      btns.appendChild(runAllBtn);
      btns.appendChild(sendNowBtn);
      bar.appendChild(info);
      bar.appendChild(btns);

      allCards[allCards.length - 1].insertAdjacentElement("afterend", bar);
    }

    const infoEl = bar.querySelector(".wslb-batch-info");
    const runAllBtn = bar.querySelector(".wslb-btn-primary");
    if (pending.length === 0) {
      infoEl.textContent = `本条回复共 ${allCards.length} 项操作，已全部执行`;
      runAllBtn.disabled = true;
    } else {
      infoEl.textContent = `本条回复共 ${allCards.length} 项操作（待执行 ${pending.length} 项，逐项点击会先暂存到输入框，最后一项完成时自动发送）`;
      runAllBtn.disabled = false;
    }
  }

  function attachActionCard(preEl, action, allowAutoRun, cfg) {
    const turnEl = findTurnContainer(preEl);
    const card = document.createElement("div");
    card.className = "wslb-card";
    card.setAttribute("data-wsl-executed", "0");

    const header = document.createElement("div");
    header.className = "wslb-card-header";

    const meta = document.createElement("div");
    meta.className = "wslb-meta";

    const badge = document.createElement("span");
    badge.className = `wslb-badge wslb-badge-${action.kind}`;
    badge.textContent = action.label;

    const title = document.createElement("span");
    title.className = "wslb-summary";
    title.title = action.summary;
    title.textContent = action.summary;

    meta.appendChild(badge);
    meta.appendChild(title);

    const actionsRow = document.createElement("div");
    actionsRow.className = "wslb-actions";

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "wslb-btn wslb-btn-primary";
    runBtn.textContent =
      action.kind === "read"
        ? "读取文件"
        : action.kind === "exec"
          ? "确认在 WSL 执行"
          : "确认应用到 WSL";

    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "wslb-btn wslb-btn-danger";
    undoBtn.textContent = "撤销本次修改";
    undoBtn.style.display = "none";

    const insertBtn = document.createElement("button");
    insertBtn.type = "button";
    insertBtn.className = "wslb-btn wslb-btn-secondary";
    insertBtn.textContent = "回填结果到输入框";
    insertBtn.style.display = "none";

    actionsRow.appendChild(runBtn);
    actionsRow.appendChild(undoBtn);
    actionsRow.appendChild(insertBtn);

    header.appendChild(meta);
    header.appendChild(actionsRow);
    card.appendChild(header);

    const outputPre = document.createElement("pre");
    outputPre.className = "wslb-output";
    outputPre.style.display = "none";
    card.appendChild(outputPre);

    let lastFormattedResult = "";
    let currentUndoId = "";

    undoBtn.addEventListener("click", async () => {
      if (!currentUndoId) return;
      undoBtn.disabled = true;
      undoBtn.textContent = "撤销中...";
      try {
        const res = await sendBridgeRequest("POST", "/api/undo", { undoId: currentUndoId });
        const verb = res.action === "deleted" ? "已删除新建文件" : "已恢复原文件内容";
        outputPre.style.display = "block";
        outputPre.classList.remove("wslb-output-error");
        outputPre.textContent = `[撤销成功] ${verb}: ${res.path}`;
        currentUndoId = "";
        undoBtn.textContent = "已撤销 ✓";
      } catch (err) {
        outputPre.classList.add("wslb-output-error");
        outputPre.textContent = `撤销失败: ${err.message}`;
        undoBtn.disabled = false;
        undoBtn.textContent = "撤销本次修改";
      }
    });

    async function executeAction({ isAuto = false, deferSend = false } = {}) {
      const latestCfg = await getConfig();
      runBtn.disabled = true;
      runBtn.textContent = isAuto ? "L2 自动执行中..." : "执行中...";
      outputPre.style.display = "block";
      outputPre.classList.remove("wslb-output-error");
      outputPre.textContent = "正在通过本地 WSL Bridge 执行...";

      const endpointMap = {
        read: "/api/read",
        exec: "/api/exec",
        write: "/api/write",
        patch: "/api/patch"
      };

      try {
        const data = await sendBridgeRequest("POST", endpointMap[action.kind], action.payload);
        lastFormattedResult = formatResultForChat(action, data);

        if (action.kind === "read") {
          const summaryLines = (data.files || []).map((f) => {
            if (f.error) return `✗ ${f.path}: ${f.error}`;
            if (f.sliced) return `✓ ${f.path} (第 ${f.startLine}-${f.endLine} 行 / 共 ${f.totalLines} 行)`;
            return `✓ ${f.path} (${f.lines} 行)`;
          });
          outputPre.textContent = summaryLines.join("\n");
        } else if (action.kind === "exec") {
          const combined = [
            `exit code: ${data.returncode} (${data.durationMs}ms)`,
            data.stdout ? `--- stdout ---\n${data.stdout}` : "",
            data.stderr ? `--- stderr ---\n${data.stderr}` : ""
          ].filter(Boolean).join("\n");
          outputPre.textContent = combined;
          if (data.returncode !== 0) {
            outputPre.classList.add("wslb-output-error");
          }
        } else {
          const modeHint = data.matchMode === "tolerant-line" ? "[行级宽松匹配]\n" : "";
          outputPre.textContent = modeHint + (data.diff ? data.diff : `已成功应用 (${data.path || data.mode})`);
          if (data.undoId) {
            currentUndoId = data.undoId;
            undoBtn.style.display = "inline-flex";
            undoBtn.disabled = false;
            undoBtn.textContent = "撤销本次修改";
          }
        }

        card.setAttribute("data-wsl-executed", "1");
        insertBtn.style.display = "inline-flex";

        const remainingCount = getPendingCardsInTurn(turnEl).length;
        const wantAutoFill = isAuto || latestCfg.autoSendAfterManual;
        const shouldSendNow = wantAutoFill && !deferSend && remainingCount === 0;

        if (shouldSendNow) {
          insertTextIntoChat(lastFormattedResult, true);
          runBtn.textContent = isAuto ? "L2 已自动回填 ✓" : "已执行并发送 ✓";
        } else if (wantAutoFill && remainingCount > 0) {
          insertTextIntoChat(lastFormattedResult, false);
          runBtn.textContent = `已暂存 (还剩 ${remainingCount} 项) ✓`;
        } else {
          runBtn.textContent = "重新执行";
        }
        runBtn.disabled = false;
        updateBatchBarForTurn(turnEl);
        return true;
      } catch (err) {
        outputPre.classList.add("wslb-output-error");
        outputPre.textContent = `执行失败: ${err.message}`;
        lastFormattedResult = `[WSL 操作失败] ${action.label} (${action.summary})\n错误: ${err.message}`;
        runBtn.textContent = "重试";
        runBtn.disabled = false;
        insertBtn.style.display = "inline-flex";
        updateBatchBarForTurn(turnEl);
        return false;
      }
    }

    cardExecutors.set(card, executeAction);

    runBtn.addEventListener("click", () => {
      consecutiveAutoSteps = 0;
      executeAction({ isAuto: false });
    });

    insertBtn.addEventListener("click", () => {
      if (!lastFormattedResult) return;
      const res = insertTextIntoChat(lastFormattedResult, false);
      insertBtn.textContent = res.inserted ? "已回填 ✓" : "已复制 ✓";
      setTimeout(() => {
        insertBtn.textContent = "回填结果到输入框";
      }, 1800);
    });

    preEl.insertAdjacentElement("afterend", card);
    updateBatchBarForTurn(turnEl);

    if (allowAutoRun && action.readOnly && !autoLoopPaused) {
      if (cfg.autoMode !== "l2_readonly") return;
      if (cfg.maxAutoSteps > 0 && consecutiveAutoSteps >= cfg.maxAutoSteps) {
        outputPre.style.display = "block";
        outputPre.textContent = `已达到连续自动执行上限 (${cfg.maxAutoSteps} 步)，请手动点击上方按钮继续（可在侧边栏将上限设为 0 以不限制）。`;
        return;
      }
      consecutiveAutoSteps += 1;
      executeAction({ isAuto: true });
    }
  }

  function isExcludedContainer(el) {
    return Boolean(
      el.closest("user-query, .user-query, [data-message-author-role='user'], mat-expansion-panel, .skill-card")
    );
  }

  function getLatestAssistantContainer() {
    const candidates = document.querySelectorAll("model-response, .model-response, message-content");
    if (!candidates.length) return null;
    return candidates[candidates.length - 1];
  }

  async function scanCodeBlocks() {
    ensureFloatingPill();
    const streaming = isAssistantStreaming();
    if (streaming) {
      sawLiveStream = true;
      return;
    }

    if (sawLiveStream) {
      sawLiveStream = false;
      autoArmedForNextScan = true;
    }

    const cfg = await getConfig();
    const latestContainer = getLatestAssistantContainer();
    const shouldAutoThisScan = autoArmedForNextScan;
    autoArmedForNextScan = false;

    const codeNodes = document.querySelectorAll("pre > code, pre");
    let autoTriggeredCount = 0;

    for (const node of codeNodes) {
      const preEl = node.tagName === "PRE" ? node : node.parentElement;
      if (!preEl || preEl.hasAttribute(PROCESSED_ATTR)) continue;
      if (preEl.classList.contains("wslb-output")) continue;
      if (isExcludedContainer(preEl)) continue;

      const text = node.textContent || "";
      const action = parseActionFromCodeBlock(text, cfg.extraReadOnlyBins);
      if (!action) continue;

      preEl.setAttribute(PROCESSED_ATTR, "1");

      const inLatestTurn = !latestContainer || latestContainer.contains(preEl);
      const allowAuto = shouldAutoThisScan && inLatestTurn && action.readOnly && autoTriggeredCount === 0;
      if (allowAuto) {
        autoTriggeredCount += 1;
      }
      attachActionCard(preEl, action, allowAuto, cfg);
    }
  }

  let scanTimer = null;
  const observer = new MutationObserver(() => {
    if (isAssistantStreaming()) {
      sawLiveStream = true;
      return;
    }
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scanCodeBlocks(); }, 750);
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  setTimeout(() => { scanCodeBlocks(); }, 1000);
})();
