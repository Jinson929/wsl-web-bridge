// WSL Web Bridge - Background Service Worker (Manifest V3, v3.0.0)
// Proxies all localhost WSL Bridge requests and manages connection + configurable L2 settings.

const DEFAULT_CONFIG = {
  endpoint: "http://127.0.0.1:18423",
  token: "",
  autoMode: "l2_readonly",       // "manual" | "l2_readonly"
  autoSendAfterManual: true,     // Auto insert & send after user clicks manual Approve
  maxAutoSteps: 0,               // 0 = unlimited consecutive L2 read-only auto steps
  extraReadOnlyBins: ""          // Comma-separated extra read-only commands
};

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

async function getConfig() {
  const stored = await chrome.storage.local.get([
    "endpoint",
    "token",
    "autoMode",
    "autoSendAfterManual",
    "maxAutoSteps",
    "extraReadOnlyBins"
  ]);
  const parsedMax = Number(stored.maxAutoSteps);
  return {
    endpoint: (stored.endpoint || DEFAULT_CONFIG.endpoint).replace(/\/+$/, ""),
    token: (stored.token || "").trim(),
    autoMode: stored.autoMode === "manual" ? "manual" : "l2_readonly",
    autoSendAfterManual: stored.autoSendAfterManual !== undefined ? Boolean(stored.autoSendAfterManual) : DEFAULT_CONFIG.autoSendAfterManual,
    maxAutoSteps: Number.isInteger(parsedMax) && parsedMax >= 0 ? parsedMax : DEFAULT_CONFIG.maxAutoSteps,
    extraReadOnlyBins: typeof stored.extraReadOnlyBins === "string" ? stored.extraReadOnlyBins : DEFAULT_CONFIG.extraReadOnlyBins
  };
}

function assertLocalEndpoint(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("无效的 Bridge 地址格式");
  }
  if (parsed.protocol !== "http:") {
    throw new Error("仅允许连接本地 http://127.0.0.1 或 http://localhost 服务");
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(`安全限制：拒绝连接非本机地址 (${parsed.hostname})`);
  }
}

async function callBridge({ method = "GET", path, body = null, overrideConfig = null }) {
  const cfg = overrideConfig
    ? {
        endpoint: (overrideConfig.endpoint || DEFAULT_CONFIG.endpoint).replace(/\/+$/, ""),
        token: (overrideConfig.token || "").trim()
      }
    : await getConfig();

  assertLocalEndpoint(cfg.endpoint);

  const headers = { "Content-Type": "application/json" };
  if (cfg.token) {
    headers["Authorization"] = `Bearer ${cfg.token}`;
  }

  let response;
  try {
    response = await fetch(`${cfg.endpoint}${path}`, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw new Error(`无法连接到本地 WSL Bridge (${cfg.endpoint})，请确认服务端已启动。详情: ${err.message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Bridge 返回了非 JSON 响应 (HTTP ${response.status})`);
  }

  if (!response.ok) {
    const detail = data.error || data.stderr || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return data;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "GET_CONFIG") {
        const cfg = await getConfig();
        sendResponse({ ok: true, config: cfg });
        return;
      }

      if (message.type === "SAVE_CONFIG") {
        const current = await getConfig();
        const endpoint = (message.endpoint !== undefined ? message.endpoint : current.endpoint).trim().replace(/\/+$/, "");
        const token = (message.token !== undefined ? message.token : current.token).trim();
        const autoMode = message.autoMode !== undefined ? (message.autoMode === "manual" ? "manual" : "l2_readonly") : current.autoMode;
        const autoSendAfterManual = message.autoSendAfterManual !== undefined ? Boolean(message.autoSendAfterManual) : current.autoSendAfterManual;
        let maxAutoSteps = current.maxAutoSteps;
        if (message.maxAutoSteps !== undefined) {
          const n = parseInt(String(message.maxAutoSteps), 10);
          maxAutoSteps = Number.isNaN(n) || n < 0 ? 0 : Math.min(100, n);
        }
        const extraReadOnlyBins = message.extraReadOnlyBins !== undefined ? String(message.extraReadOnlyBins).trim() : current.extraReadOnlyBins;

        assertLocalEndpoint(endpoint);
        await chrome.storage.local.set({ endpoint, token, autoMode, autoSendAfterManual, maxAutoSteps, extraReadOnlyBins });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "BRIDGE_REQUEST") {
        const data = await callBridge({
          method: message.method,
          path: message.path,
          body: message.body ?? null,
          overrideConfig: message.overrideConfig ?? null
        });
        sendResponse({ ok: true, data });
        return;
      }

      if (message.type === "INJECT_TEXT_TO_TAB") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
          throw new Error("未找到当前激活的浏览器标签页");
        }
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: "INSERT_CHAT_TEXT",
          text: message.text,
          autoSend: Boolean(message.autoSend)
        });
        sendResponse({ ok: true, result: res });
        return;
      }

      sendResponse({ ok: false, error: `未知消息类型: ${message.type}` });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  return true;
});
