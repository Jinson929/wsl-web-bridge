// WSL Web Bridge - Content Script (v3.1.0)
// Features:
// - Dual-channel delivery: virtual file attachments for source code / large outputs, inline text for short commands
// - Server-side line-range /api/read (with client-side fallback for older bridges)
// - One-click Undo Snapshot button on /api/write and /api/patch cards
// - Multi-card accumulation & sequential batch execution bar
// - Bottom-right floating L2 Pause/Resume pill

(() => {
  const PROCESSED_ATTR = "data-wslb-bound";
  const MAX_CHAT_INSERT_CHARS = 24000;
  const MAX_PER_FILE_CHARS = 8000;
  const MAX_ATTACH_BUNDLE_CHARS = 512 * 1024;
  let consecutiveAutoSteps = 0;
  let autoLoopPaused = false;
  let sawLiveStream = false;
  let autoArmedForNextScan = false;
  let chatDeliveryQueue = Promise.resolve();
  let cachedConfig = {
    autoMode: "l2_readonly",
    autoSendAfterManual: true,
    maxAutoSteps: 0,
    extraReadOnlyBins: "",
    transferMode: "auto_attach",
    bundleMode: "single_bundle",
    attachThresholdChars: 4000
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

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  function clampChatPayload(text) {
    if (text.length <= MAX_CHAT_INSERT_CHARS) return text;
    return (
      text.slice(0, MAX_CHAT_INSERT_CHARS) +
      `\n\n... [内容总长 ${text.length} 字符，为防止浏览器输入框卡死已截断至 ${MAX_CHAT_INSERT_CHARS} 字符；请开启附件传输或使用 \`路径:起始行-结束行\` 分段读取]`
    );
  }

  function getComposerRoot(input) {
    if (!input) return document.body;
    const known = input.closest(
      "input-container, .input-area-container, .text-input-field, form, fieldset, footer, ms-prompt-input-wrapper, .prompt-input-wrapper"
    );
    if (known) return known;
    let cur = input;
    for (let i = 0; i < 6 && cur && cur.parentElement && cur.parentElement !== document.body; i++) {
      cur = cur.parentElement;
    }
    return cur || document.body;
  }

  function getAttachmentSnapshot(composerRoot) {
    const root = composerRoot || document.body;
    const chipSelectors = [
      "uploader-file-preview",
      "file-preview",
      "ms-file-chip",
      "[data-test-id*='file-preview']",
      "[data-test-id*='attachment']",
      "[class*='file-preview']",
      "[class*='attachment-preview']",
      "mat-chip",
      "mat-chip-row",
      "button[aria-label*='Remove']",
      "button[aria-label*='移除']",
      "button[aria-label*='删除']"
    ].join(", ");
    const chipCount = root.querySelectorAll(chipSelectors).length;
    const text = (root.innerText || "").slice(0, 8000);
    return { chipCount, text };
  }

  function hasAttachmentAppeared(composerRoot, beforeSnap, expectedNames) {
    const afterSnap = getAttachmentSnapshot(composerRoot);
    if (afterSnap.chipCount > beforeSnap.chipCount) return true;
    for (const name of expectedNames) {
      if (!name) continue;
      const base = name.replace(/\.txt$/i, "");
      const inAfter = afterSnap.text.includes(name) || (base.length >= 8 && afterSnap.text.includes(base));
      const inBefore = beforeSnap.text.includes(name) || (base.length >= 8 && beforeSnap.text.includes(base));
      if (inAfter && !inBefore) return true;
    }
    return false;
  }

  function hasActiveUploadSpinner(composerRoot) {
    const root = composerRoot || document.body;
    const spinners = root.querySelectorAll(
      "mat-progress-spinner, mat-progress-bar, [role='progressbar'], [aria-busy='true'], .uploading, .upload-progress"
    );
    for (const el of spinners) {
      if (el.offsetParent !== null) return true;
    }
    return false;
  }

  async function waitForAttachmentMount(composerRoot, beforeSnap, expectedNames, timeoutMs = 900) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (hasAttachmentAppeared(composerRoot, beforeSnap, expectedNames)) {
        return true;
      }
      await delay(100);
    }
    return hasAttachmentAppeared(composerRoot, beforeSnap, expectedNames);
  }

  async function waitForUploadsReadyAndSend(composerRoot, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    // Brief initial wait so Angular/React renders upload progress indicators
    await delay(350);
    while (Date.now() < deadline) {
      const uploading = hasActiveUploadSpinner(composerRoot);
      const sendBtn = findSendButton();
      if (!uploading && sendBtn) {
        await delay(220);
        if (!hasActiveUploadSpinner(composerRoot)) {
          return triggerSendChat();
        }
      }
      await delay(220);
    }
    return triggerSendChat();
  }

  function findBestFileInput(composerRoot) {
    const scopes = [composerRoot, document].filter(Boolean);
    for (const scope of scopes) {
      const inputs = Array.from(scope.querySelectorAll('input[type="file"]'));
      if (!inputs.length) continue;
      const preferred = inputs.find((el) => {
        const accept = (el.getAttribute("accept") || "").toLowerCase();
        return !accept || accept.includes("text") || accept.includes(".txt") || accept.includes("*/*");
      });
      if (preferred) return preferred;
      return inputs[0];
    }
    return null;
  }

  async function attachFilesToChat(fileSpecs) {
    if (!fileSpecs || !fileSpecs.length) {
      return { attached: false, attachedCount: 0, method: "none" };
    }
    const input = findChatInput();
    if (!input) {
      return { attached: false, attachedCount: 0, method: "no_input" };
    }

    const composerRoot = getComposerRoot(input);
    const expectedNames = fileSpecs.map((f) => f.name);
    const makeDataTransfer = () => {
      const dt = new DataTransfer();
      for (const spec of fileSpecs) {
        const fileObj = new File([spec.content || ""], spec.name, {
          type: spec.mimeType || "text/plain"
        });
        dt.items.add(fileObj);
      }
      return dt;
    };

    // Tier 1: Synthetic ClipboardEvent("paste") with File items only
    try {
      const beforeSnap = getAttachmentSnapshot(composerRoot);
      input.focus();
      const dt = makeDataTransfer();
      const pasteEvt = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      input.dispatchEvent(pasteEvt);
      if (await waitForAttachmentMount(composerRoot, beforeSnap, expectedNames, 750)) {
        return { attached: true, attachedCount: fileSpecs.length, method: "paste" };
      }
    } catch {
      // Proceed to Tier 2
    }

    // Tier 2: Synthetic DragEvent("drop") on composer / input
    try {
      const beforeSnap = getAttachmentSnapshot(composerRoot);
      const dropTarget = composerRoot || input;
      const dt = makeDataTransfer();
      for (const evtName of ["dragenter", "dragover", "drop"]) {
        const dragEvt = new DragEvent(evtName, {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true
        });
        dropTarget.dispatchEvent(dragEvt);
      }
      if (await waitForAttachmentMount(composerRoot, beforeSnap, expectedNames, 750)) {
        return { attached: true, attachedCount: fileSpecs.length, method: "drop" };
      }
    } catch {
      // Proceed to Tier 3
    }

    // Tier 3: Direct <input type="file"> injection
    try {
      const fileInput = findBestFileInput(composerRoot);
      if (fileInput) {
        const beforeSnap = getAttachmentSnapshot(composerRoot);
        const dt = makeDataTransfer();
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("input", { bubbles: true }));
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        if (await waitForAttachmentMount(composerRoot, beforeSnap, expectedNames, 900)) {
          return { attached: true, attachedCount: fileSpecs.length, method: "file_input" };
        }
      }
    } catch {
      // Fall through to text fallback
    }

    return { attached: false, attachedCount: 0, method: "failed" };
  }

  async function insertTextIntoChat(rawText, autoSend = false) {
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
          // Wait for Quill/React async paste handler before checking DOM to avoid double-paste
          await delay(80);
          const afterLen = (input.innerText || "").length;
          if (pasteEvt.defaultPrevented || afterLen > existingText.length + Math.min(20, text.length / 2)) {
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
      await delay(320);
      triggerSendChat();
    }

    return { inserted: true, autoSent: Boolean(autoSend) };
  }

  function deliverPayloadToChat(payload, autoSend = false) {
    const run = async () => {
      const input = findChatInput();
      const composerRoot = getComposerRoot(input);
      const files = Array.isArray(payload.files) ? payload.files : [];

      if (files.length > 0) {
        const attachRes = await attachFilesToChat(files);
        if (attachRes.attached) {
          const textRes = await insertTextIntoChat(payload.text || "", false);
          if (autoSend) {
            await waitForUploadsReadyAndSend(composerRoot);
          }
          return {
            inserted: textRes.inserted,
            attachedCount: attachRes.attachedCount,
            attachMethod: attachRes.method,
            autoSent: Boolean(autoSend),
            fallbackUsed: false
          };
        }
        // Attachment failed -> safe fallback to clamped inline text
        const fallbackBody = payload.fallbackText || payload.text || "";
        const textRes = await insertTextIntoChat(fallbackBody, autoSend);
        return {
          ...textRes,
          attachedCount: 0,
          fallbackUsed: true
        };
      }

      const textRes = await insertTextIntoChat(payload.text || "", autoSend);
      return {
        ...textRes,
        attachedCount: 0,
        fallbackUsed: false
      };
    };

    const next = chatDeliveryQueue.then(run, run);
    chatDeliveryQueue = next.catch(() => {});
    return next;
  }

  document.addEventListener("keydown", (e) => {
    if (e.isTrusted && e.key === "Enter" && !e.shiftKey) {
      consecutiveAutoSteps = 0;
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "INSERT_CHAT_TEXT") {
      deliverPayloadToChat({ text: message.text || "" }, Boolean(message.autoSend))
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ inserted: false, error: err.message }));
      return true;
    }
    if (message.type === "INSERT_CHAT_PAYLOAD") {
      deliverPayloadToChat(message.payload || { text: "" }, Boolean(message.autoSend))
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ inserted: false, error: err.message }));
      return true;
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

  function normalizeReadFileEntry(f, spec) {
    if (f.error) {
      return { path: f.path, error: f.error };
    }
    let content = f.content || "";
    let totalLines = f.totalLines || content.split(/\r?\n/).length;
    let startLine = f.startLine || 1;
    let endLine = f.endLine || totalLines;
    let sliced = Boolean(f.sliced);

    if (!sliced && spec && spec.start !== null) {
      const allLines = content.split(/\r?\n/);
      totalLines = allLines.length;
      startLine = spec.start;
      endLine = Math.min(spec.end, totalLines);
      content = allLines.slice(startLine - 1, endLine).join("\n");
      sliced = true;
    }

    const rangeLabel = sliced
      ? `第 ${startLine}-${endLine} 行 / 共 ${totalLines} 行`
      : `共 ${totalLines} 行`;
    const asciiRange = `lines ${startLine}-${endLine} / ${totalLines}`;
    return {
      path: f.path,
      content,
      totalLines,
      startLine,
      endLine,
      sliced,
      truncated: Boolean(f.truncated),
      rangeLabel,
      asciiRange
    };
  }

  function formatInlineResultForChat(action, data) {
    if (action.kind === "read") {
      const specs = action.specs || [];
      const files = data.files || [];
      const perFileBudget = files.length > 1 ? Math.min(MAX_PER_FILE_CHARS, Math.floor((MAX_CHAT_INSERT_CHARS - 1200) / files.length)) : MAX_CHAT_INSERT_CHARS - 1000;
      const blocks = ["[WSL 文件读取结果]"];

      files.forEach((f, idx) => {
        const norm = normalizeReadFileEntry(f, specs[idx] || { start: null, end: null });
        if (norm.error) {
          blocks.push(`### \`${norm.path}\`\n> 读取跳过：${norm.error}`);
          return;
        }
        const ext = (norm.path.split(".").pop() || "").toLowerCase();
        let displayContent = norm.content;
        let headerNote = ` (${norm.rangeLabel})`;

        if (displayContent.length > perFileBudget) {
          const shownLines = displayContent.slice(0, perFileBudget).split(/\r?\n/).length;
          const nextStart = norm.startLine + shownLines;
          displayContent =
            displayContent.slice(0, perFileBudget) +
            `\n... [已按防卡顿配额截断，仅展示前约 ${shownLines} 行；如需后续请用 \`${norm.path}:${nextStart}-${Math.min(norm.totalLines, nextStart + 150)}\` 分段读取]`;
          headerNote += " [已截断]";
        }

        blocks.push(`### \`${norm.path}\`${headerNote}\n\`\`\`${ext}\n${displayContent}\n\`\`\``);
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

  function buildChatPayload(action, data, cfg = cachedConfig) {
    const transferMode = (cfg && cfg.transferMode) || "auto_attach";
    const bundleMode = (cfg && cfg.bundleMode) || "single_bundle";
    const threshold = (cfg && cfg.attachThresholdChars) || 4000;
    const fallbackText = formatInlineResultForChat(action, data);

    if (transferMode === "text_only") {
      return { text: fallbackText, fallbackText, files: [] };
    }

    if (action.kind === "read") {
      const specs = action.specs || [];
      const entries = (data.files || []).map((f, idx) =>
        normalizeReadFileEntry(f, specs[idx] || { start: null, end: null })
      );
      const okEntries = entries.filter((e) => !e.error);
      if (okEntries.length === 0) {
        return { text: fallbackText, fallbackText, files: [] };
      }

      const usePerFile = bundleMode === "per_file" && okEntries.length <= 8;
      const attachFiles = [];
      const summaryLines = [];

      if (usePerFile) {
        for (const e of okEntries) {
          const attachName = sanitizeAttachmentName(e.path);
          let body = e.content;
          let truncMark = e.truncated ? " [已截断]" : "";
          if (body.length > MAX_ATTACH_BUNDLE_CHARS) {
            body = body.slice(0, MAX_ATTACH_BUNDLE_CHARS) + "\n... [超出单附件上限已截断]";
            truncMark = " [已截断]";
          }
          const fileHeader = `// FILE: ${e.path} (${e.asciiRange})\n\n`;
          attachFiles.push({
            name: attachName,
            content: fileHeader + body,
            mimeType: "text/plain"
          });
          summaryLines.push(`- \`${e.path}\` (${e.rangeLabel})${truncMark} -> 附件 \`${attachName}\``);
        }
      } else {
        const bundleName = `wsl-read-${makeTimeStampTag()}.txt`;
        const bundleIndex = [];
        const bundleSections = [];
        let usedChars = 0;

        okEntries.forEach((e, idx) => {
          let body = e.content;
          let truncMark = e.truncated ? " [已截断]" : "";
          const remainingBudget = MAX_ATTACH_BUNDLE_CHARS - usedChars;
          if (remainingBudget <= 512) {
            summaryLines.push(`- \`${e.path}\` [超出附件总配额未打包，请单独切片读取]`);
            return;
          }
          if (body.length > remainingBudget) {
            body = body.slice(0, remainingBudget) + "\n... [超出附件总配额已截断，请使用 路径:起始行-结束行 分段读取]";
            truncMark = " [已截断]";
          }
          usedChars += body.length;
          bundleIndex.push(`${idx + 1}. ${e.path} (${e.asciiRange})${truncMark}`);
          bundleSections.push(
            `================================================================================\n` +
            `FILE: ${e.path} (${e.asciiRange})${truncMark}\n` +
            `================================================================================\n` +
            body
          );
          summaryLines.push(`- \`${e.path}\` (${e.rangeLabel})${truncMark}`);
        });

        const bundleContent =
          `# WSL Web Bridge Read Bundle\n` +
          `Files: ${bundleSections.length}\n\n` +
          `## Index\n${bundleIndex.join("\n")}\n\n` +
          bundleSections.join("\n\n");
        attachFiles.push({ name: bundleName, content: bundleContent, mimeType: "text/plain" });
      }

      for (const e of entries) {
        if (e.error) {
          summaryLines.push(`- \`${e.path}\` [读取跳过: ${e.error}]`);
        }
      }

      const totalBytes = attachFiles.reduce((acc, f) => acc + f.content.length, 0);
      const namesDesc = attachFiles.map((f) => `\`${f.name}\``).join("、");
      const text = [
        `[WSL 文件读取结果] 已通过附件 ${namesDesc} 上传（${okEntries.length} 个文件，${formatByteSize(totalBytes)}）：`,
        ...summaryLines,
        "请直接读取附件中的源码内容继续。"
      ].join("\n");

      return { text, fallbackText, files: attachFiles };
    }

    if (action.kind === "exec") {
      const stdout = (data.stdout || "").trim();
      const stderr = (data.stderr || "").trim();
      const rawTotal = stdout.length + stderr.length;
      const shouldAttach =
        rawTotal > 0 && (transferMode === "always_attach" || rawTotal > threshold);

      if (!shouldAttach) {
        return { text: fallbackText, fallbackText, files: [] };
      }

      const fileName = `wsl-cmd-${makeTimeStampTag()}.txt`;
      const parts = [
        `# WSL Command Output`,
        `Command: ${action.payload.command}`,
        `Exit Code: ${data.returncode} (${data.durationMs}ms)`
      ];
      if (stdout) parts.push(`\n=== STDOUT ===\n${stdout}`);
      if (stderr) parts.push(`\n=== STDERR ===\n${stderr}`);
      let content = parts.join("\n");
      if (content.length > MAX_ATTACH_BUNDLE_CHARS) {
        content = content.slice(0, MAX_ATTACH_BUNDLE_CHARS) + "\n... [命令输出超出附件上限已截断]";
      }
      const lineCount = (stdout ? stdout.split(/\r?\n/).length : 0) + (stderr ? stderr.split(/\r?\n/).length : 0);
      const summary = [
        `[WSL 命令执行结果]`,
        `命令: \`${action.payload.command}\``,
        `退出码: ${data.returncode} (${data.durationMs}ms)`,
        `输出较长（约 ${lineCount} 行 / ${formatByteSize(content.length)}），完整内容已通过附件 \`${fileName}\` 上传。`
      ].join("\n");

      return {
        text: summary,
        fallbackText,
        files: [{ name: fileName, content, mimeType: "text/plain" }]
      };
    }

    // write / patch: keep compact diff inline, auto-upgrade large diff to attachment
    const diffText = (data.diff || "").trim();
    const shouldAttachDiff =
      diffText.length > 0 && (transferMode === "always_attach" || diffText.length > threshold);
    if (!shouldAttachDiff) {
      return { text: fallbackText, fallbackText, files: [] };
    }

    const diffFileName = `wsl-${action.kind}-diff-${makeTimeStampTag()}.txt`;
    const head =
      action.kind === "write"
        ? `[WSL 文件写入完成] \`${data.path}\` (${data.bytesWritten} bytes)`
        : `[WSL 补丁已应用] ${data.path || data.mode}${data.matchMode === "tolerant-line" ? " (行级宽松匹配)" : ""}`;
    const summary = `${head}\n变更 Diff 较长（${formatByteSize(diffText.length)}），已通过附件 \`${diffFileName}\` 上传。`;
    return {
      text: summary,
      fallbackText,
      files: [{ name: diffFileName, content: diffText, mimeType: "text/plain" }]
    };
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

    let lastChatPayload = null;
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
        lastChatPayload = buildChatPayload(action, data, latestCfg);

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
          const deliveryRes = await deliverPayloadToChat(lastChatPayload, true);
          const viaAttach = deliveryRes && deliveryRes.attachedCount > 0 ? " (附件)" : "";
          runBtn.textContent = isAuto ? `L2 已自动回填${viaAttach} ✓` : `已执行并发送${viaAttach} ✓`;
        } else if (wantAutoFill && remainingCount > 0) {
          const deliveryRes = await deliverPayloadToChat(lastChatPayload, false);
          const viaAttach = deliveryRes && deliveryRes.attachedCount > 0 ? "附件" : "文本";
          runBtn.textContent = `已暂存${viaAttach} (还剩 ${remainingCount} 项) ✓`;
        } else {
          runBtn.textContent = "重新执行";
        }
        runBtn.disabled = false;
        updateBatchBarForTurn(turnEl);
        return true;
      } catch (err) {
        outputPre.classList.add("wslb-output-error");
        outputPre.textContent = `执行失败: ${err.message}`;
        const errText = `[WSL 操作失败] ${action.label} (${action.summary})\n错误: ${err.message}`;
        lastChatPayload = { text: errText, fallbackText: errText, files: [] };
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

    insertBtn.addEventListener("click", async () => {
      if (!lastChatPayload) return;
      const res = await deliverPayloadToChat(lastChatPayload, false);
      if (res && res.attachedCount > 0) {
        insertBtn.textContent = "已挂载附件 ✓";
      } else {
        insertBtn.textContent = res && res.inserted ? "已回填 ✓" : "已复制 ✓";
      }
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
