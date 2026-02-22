import * as vscode from "vscode";
import type { TransportMode } from "./routes/chat";

export type SidebarLogLevel = "in" | "out" | "event" | "error";

export interface SidebarStatus {
  running: boolean;
  ready: boolean;
  url: string;
  transport: TransportMode;
  port: number;
  autoStart: boolean;
  lastError?: string;
}

export interface SidebarLogEntry {
  ts: string;
  level: SidebarLogLevel;
  source: string;
  message: string;
  data?: unknown;
}

export interface SidebarSettings {
  port: number;
  transport: TransportMode;
  autoStart: boolean;
}

export interface SidebarActions {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  saveSettings: (settings: SidebarSettings) => Promise<void>;
  refresh: () => void;
}

export const LocalAiSidebarViewIds = {
  connection: "localAI.connection",
  controls: "localAI.controls",
  logs: "localAI.logs",
} as const;

interface SidebarMessage {
  type: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asTransport(value: unknown): TransportMode {
  return value === "websocket" ? "websocket" : "sse";
}

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

abstract class WebviewSectionProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  protected view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(readonly viewType: string) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    try {
      webviewView.webview.html = this.renderHtml(webviewView.webview);
    } catch (error) {
      const message =
        error instanceof Error ? error.stack ?? error.message : String(error);
      webviewView.webview.html = this.renderErrorHtml(
        webviewView.webview,
        message
      );
      console.error(
        `[Local AI Bridge] Failed to render view "${this.viewType}":`,
        error
      );
    }

    this.disposables.push(
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
        }
      })
    );

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => {
        void this.onMessage(message);
      })
    );
  }

  protected postMessage(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  protected async onMessage(_message: unknown): Promise<void> {
    return;
  }

  protected abstract renderHtml(webview: vscode.Webview): string;

  private renderErrorHtml(webview: vscode.Webview, message: string): string {
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const safe = escapeHtml(message);

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <style>
      body {
        margin: 0;
        padding: 10px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
      }
      .title {
        color: var(--vscode-errorForeground);
        margin-bottom: 8px;
      }
      pre {
        white-space: pre-wrap;
        font-family: var(--vscode-editor-font-family);
        background: var(--vscode-textCodeBlock-background);
        border: 1px solid var(--vscode-panel-border);
        padding: 8px;
        border-radius: 4px;
      }
    </style>
  </head>
  <body>
    <div class="title">Failed to load view: ${escapeHtml(this.viewType)}</div>
    <pre>${safe}</pre>
  </body>
</html>`;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.view = undefined;
  }
}

class ConnectionSectionProvider extends WebviewSectionProvider {
  private status: SidebarStatus;

  constructor(
    initialStatus: SidebarStatus,
    private readonly actions: SidebarActions
  ) {
    super(LocalAiSidebarViewIds.connection);
    this.status = initialStatus;
  }

  setStatus(status: SidebarStatus): void {
    this.status = status;
    this.postMessage({ type: "status", status });
  }

  protected async onMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }

    const payload = message as SidebarMessage;

    try {
      switch (payload.type) {
        case "ready":
          this.postMessage({ type: "status", status: this.status });
          return;
        case "start":
          await this.actions.start();
          return;
        case "stop":
          await this.actions.stop();
          return;
        default:
          return;
      }
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "Sidebar action failed.";
      this.postMessage({
        type: "error",
        message: messageText,
      });
    }
  }

  protected renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
      }

      body {
        margin: 0;
        padding: 10px;
        box-sizing: border-box;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
        display: grid;
        gap: 8px;
        overflow: auto;
      }

      .status-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--vscode-descriptionForeground);
      }

      .dot.ready {
        background: var(--vscode-charts-green);
      }

      .dot.error {
        background: var(--vscode-errorForeground);
      }

      .meta {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 6px 8px;
      }

      .label {
        color: var(--vscode-descriptionForeground);
      }

      .value {
        word-break: break-word;
      }

      .error {
        color: var(--vscode-errorForeground);
        min-height: 14px;
      }

      button {
        font: inherit;
        height: 26px;
        min-width: 72px;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 2px;
        padding: 0 10px;
        cursor: pointer;
      }

      button:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      button:disabled {
        opacity: 0.65;
        cursor: not-allowed;
      }
    </style>
  </head>
  <body>
    <div class="status-row">
      <span id="statusDot" class="dot"></span>
      <span id="statusText">Stopped</span>
    </div>
    <div class="meta">
      <span class="label">URL</span>
      <span class="value" id="urlValue">-</span>
      <span class="label">Transport</span>
      <span class="value" id="transportValue">-</span>
      <span class="label">Port</span>
      <span class="value" id="portValue">-</span>
    </div>
    <div class="actions">
      <button id="startButton" class="primary" type="button">Start</button>
      <button id="stopButton" class="secondary" type="button">Stop</button>
    </div>
    <div id="lastError" class="error"></div>

    <script nonce="${nonce}">
      (() => {
        const vscode = acquireVsCodeApi();
        const statusDot = document.getElementById("statusDot");
        const statusText = document.getElementById("statusText");
        const urlValue = document.getElementById("urlValue");
        const transportValue = document.getElementById("transportValue");
        const portValue = document.getElementById("portValue");
        const startButton = document.getElementById("startButton");
        const stopButton = document.getElementById("stopButton");
        const lastError = document.getElementById("lastError");

        function renderStatus(status) {
          const running = Boolean(status && status.running);
          const ready = Boolean(status && status.ready);
          statusText.textContent = ready ? "Ready" : running ? "Starting..." : "Stopped";

          statusDot.classList.remove("ready", "error");
          if (ready) {
            statusDot.classList.add("ready");
          } else if (status && status.lastError) {
            statusDot.classList.add("error");
          }

          urlValue.textContent = status && status.url ? status.url : "-";
          transportValue.textContent = status && status.transport ? status.transport : "-";
          portValue.textContent =
            status && typeof status.port === "number" ? String(status.port) : "-";
          startButton.disabled = Boolean(status && status.ready);
          stopButton.disabled = !(status && status.running);
          lastError.textContent = status && status.lastError ? status.lastError : "";
        }

        window.addEventListener("message", (event) => {
          const message = event.data;
          if (!message || message.type !== "status") {
            if (message && message.type === "error") {
              lastError.textContent = String(
                message.message || "Unknown sidebar error."
              );
            }
            return;
          }
          renderStatus(message.status);
        });

        startButton.addEventListener("click", () => {
          vscode.postMessage({ type: "start" });
        });
        stopButton.addEventListener("click", () => {
          vscode.postMessage({ type: "stop" });
        });

        vscode.postMessage({ type: "ready" });
      })();
    </script>
  </body>
</html>`;
  }
}

class ControlsSectionProvider extends WebviewSectionProvider {
  private status: SidebarStatus;

  constructor(
    initialStatus: SidebarStatus,
    private readonly actions: SidebarActions
  ) {
    super(LocalAiSidebarViewIds.controls);
    this.status = initialStatus;
  }

  setStatus(status: SidebarStatus): void {
    this.status = status;
    this.postMessage({ type: "status", status });
  }

  protected async onMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }

    const payload = message as SidebarMessage;

    try {
      switch (payload.type) {
        case "ready":
          this.postMessage({ type: "status", status: this.status });
          return;
        case "refresh":
          this.actions.refresh();
          return;
        case "saveSettings":
          await this.actions.saveSettings(this.parseSettings(payload.settings));
          return;
        default:
          return;
      }
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "Sidebar action failed.";
      this.postMessage({
        type: "error",
        message: messageText,
      });
    }
  }

  private parseSettings(value: unknown): SidebarSettings {
    if (!isRecord(value)) {
      throw new Error("Invalid settings payload.");
    }

    const portRaw = Number(value.port);
    if (!Number.isInteger(portRaw) || portRaw < 1024 || portRaw > 65535) {
      throw new Error("Port must be an integer between 1024 and 65535.");
    }

    return {
      port: portRaw,
      transport: asTransport(value.transport),
      autoStart: Boolean(value.autoStart),
    };
  }

  protected renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
      }

      body {
        margin: 0;
        padding: 10px;
        box-sizing: border-box;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
        display: grid;
        gap: 10px;
        overflow: auto;
      }

      .form {
        display: grid;
        gap: 10px;
      }

      .field {
        display: grid;
        gap: 4px;
      }

      .label {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
      }

      input,
      select,
      button {
        font: inherit;
      }

      input[type="number"],
      select {
        width: 100%;
        height: 26px;
        border: 1px solid var(--vscode-input-border);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border-radius: 2px;
        padding: 0 8px;
      }

      input[type="number"] {
        appearance: textfield;
        -moz-appearance: textfield;
      }

      input[type="number"]::-webkit-inner-spin-button,
      input[type="number"]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }

      input[type="number"]:focus,
      select:focus,
      button:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      .checkbox {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 22px;
      }

      .checkbox input[type="checkbox"] {
        margin: 0;
      }

      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      button {
        height: 26px;
        min-width: 72px;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 2px;
        padding: 0 10px;
        cursor: pointer;
      }

      button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      button:disabled {
        opacity: 0.65;
        cursor: not-allowed;
      }

      .error {
        color: var(--vscode-errorForeground);
        min-height: 16px;
        font-size: 11px;
      }
    </style>
  </head>
  <body>
    <div class="form">
      <label class="field">
        <span class="label">Port</span>
        <input id="portInput" type="number" min="1024" max="65535" />
      </label>
      <label class="field">
        <span class="label">Transport</span>
        <select id="transportSelect">
          <option value="sse">SSE</option>
          <option value="websocket">WebSocket</option>
        </select>
      </label>
      <label class="checkbox">
        <input id="autoStartInput" type="checkbox" />
        <span>Auto start on launch</span>
      </label>
      <div class="actions">
        <button id="saveButton" class="primary" type="button">Save</button>
        <button id="resetButton" class="secondary" type="button">Reset</button>
      </div>
    </div>
    <div id="errorText" class="error"></div>

    <script nonce="${nonce}">
      (() => {
        const vscode = acquireVsCodeApi();
        const portInput = document.getElementById("portInput");
        const transportSelect = document.getElementById("transportSelect");
        const autoStartInput = document.getElementById("autoStartInput");
        const saveButton = document.getElementById("saveButton");
        const resetButton = document.getElementById("resetButton");
        const errorText = document.getElementById("errorText");

        function renderStatus(status) {
          if (status && typeof status.port === "number") {
            portInput.value = String(status.port);
          }
          transportSelect.value =
            status && status.transport === "websocket" ? "websocket" : "sse";
          autoStartInput.checked = Boolean(status && status.autoStart);
          errorText.textContent = status && status.lastError ? status.lastError : "";
        }

        window.addEventListener("message", (event) => {
          const message = event.data;
          if (!message || typeof message.type !== "string") {
            return;
          }

          if (message.type === "status") {
            renderStatus(message.status);
            return;
          }

          if (message.type === "error") {
            errorText.textContent = String(message.message || "Unknown error.");
          }
        });

        saveButton.addEventListener("click", () => {
          vscode.postMessage({
            type: "saveSettings",
            settings: {
              port: Number(portInput.value),
              transport: transportSelect.value,
              autoStart: autoStartInput.checked,
            },
          });
        });
        resetButton.addEventListener("click", () => {
          vscode.postMessage({ type: "refresh" });
        });

        vscode.postMessage({ type: "ready" });
      })();
    </script>
  </body>
</html>`;
  }
}

class LogsSectionProvider extends WebviewSectionProvider {
  private readonly getLogs: () => SidebarLogEntry[];
  private readonly onClearLogs: () => void;

  constructor(getLogs: () => SidebarLogEntry[], onClearLogs: () => void) {
    super(LocalAiSidebarViewIds.logs);
    this.getLogs = getLogs;
    this.onClearLogs = onClearLogs;
  }

  appendLog(entry: SidebarLogEntry): void {
    this.postMessage({ type: "log", entry });
  }

  setLogs(entries: SidebarLogEntry[]): void {
    this.postMessage({ type: "logs", entries });
  }

  protected async onMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }

    if (message.type === "ready") {
      this.postMessage({ type: "logs", entries: this.getLogs() });
      return;
    }

    if (message.type === "clearLogs") {
      this.onClearLogs();
    }
  }

  protected renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
      }

      body {
        margin: 0;
        padding: 10px;
        box-sizing: border-box;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 0;
        overflow: hidden;
      }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }

      .subtitle {
        color: var(--vscode-descriptionForeground);
      }

      button {
        font: inherit;
        height: 26px;
        min-width: 72px;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 2px;
        padding: 0 10px;
        cursor: pointer;
      }

      button:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      button:disabled {
        opacity: 0.65;
        cursor: not-allowed;
      }

      .log-box {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        background: var(--vscode-textCodeBlock-background);
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        font-family: var(--vscode-editor-font-family);
        font-size: 11px;
        line-height: 1.4;
      }

      .log-item {
        padding: 6px 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
        word-break: break-word;
      }

      .log-item:last-child {
        border-bottom: 0;
      }

      .log-meta {
        color: var(--vscode-descriptionForeground);
      }

      .log-item.error .log-meta {
        color: var(--vscode-errorForeground);
      }

      .log-item.in .log-meta {
        color: var(--vscode-charts-green);
      }

      .log-item.out .log-meta {
        color: var(--vscode-charts-blue);
      }

      .log-data {
        margin-top: 4px;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <div class="header">
      <span class="subtitle">Live bridge events</span>
      <button id="clearLogsButton" class="secondary" type="button">Clear</button>
    </div>
    <div id="logBox" class="log-box"></div>

    <script nonce="${nonce}">
      (() => {
        const vscode = acquireVsCodeApi();
        const logBox = document.getElementById("logBox");
        const clearLogsButton = document.getElementById("clearLogsButton");
        let logCount = 0;

        function appendLog(entry) {
          const item = document.createElement("div");
          const level = entry && typeof entry.level === "string" ? entry.level : "event";
          item.className = "log-item " + level;

          const meta = document.createElement("div");
          meta.className = "log-meta";
          const ts = entry && entry.ts
            ? new Date(entry.ts).toLocaleTimeString()
            : new Date().toLocaleTimeString();
          const source = entry && entry.source ? entry.source : "bridge";
          const message = entry && entry.message ? entry.message : "";
          meta.textContent = "[" + ts + "] [" + level.toUpperCase() + "] " + source + ": " + message;
          item.appendChild(meta);

          const data = entry ? entry.data : undefined;
          if (data !== undefined) {
            const dataNode = document.createElement("div");
            dataNode.className = "log-data";
            try {
              dataNode.textContent =
                typeof data === "string" ? data : JSON.stringify(data);
            } catch {
              dataNode.textContent = String(data);
            }
            item.appendChild(dataNode);
          }

          logBox.appendChild(item);
          logCount += 1;
          while (logCount > 500 && logBox.firstChild) {
            logBox.removeChild(logBox.firstChild);
            logCount -= 1;
          }
          logBox.scrollTop = logBox.scrollHeight;
        }

        function replaceLogs(entries) {
          logBox.innerHTML = "";
          logCount = 0;
          if (!Array.isArray(entries)) {
            return;
          }
          for (const entry of entries) {
            appendLog(entry);
          }
        }

        window.addEventListener("message", (event) => {
          const message = event.data;
          if (!message || typeof message.type !== "string") {
            return;
          }

          if (message.type === "logs") {
            replaceLogs(message.entries);
            return;
          }

          if (message.type === "log") {
            appendLog(message.entry);
          }
        });

        clearLogsButton.addEventListener("click", () => {
          vscode.postMessage({ type: "clearLogs" });
        });

        vscode.postMessage({ type: "ready" });
      })();
    </script>
  </body>
</html>`;
  }
}

export class LocalAiSidebar implements vscode.Disposable {
  private static readonly logLimit = 500;

  private readonly logs: SidebarLogEntry[] = [];
  private readonly connectionProvider: ConnectionSectionProvider;
  private readonly controlsProvider: ControlsSectionProvider;
  private readonly logsProvider: LogsSectionProvider;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(actions: SidebarActions, initialStatus: SidebarStatus) {
    this.connectionProvider = new ConnectionSectionProvider(initialStatus, actions);
    this.controlsProvider = new ControlsSectionProvider(initialStatus, actions);
    this.logsProvider = new LogsSectionProvider(
      () => this.logs,
      () => this.clearLogs()
    );
  }

  register(context: vscode.ExtensionContext): void {
    const options = {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    };

    this.disposables.push(
      vscode.window.registerWebviewViewProvider(
        LocalAiSidebarViewIds.connection,
        this.connectionProvider,
        options
      )
    );
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(
        LocalAiSidebarViewIds.controls,
        this.controlsProvider,
        options
      )
    );
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(
        LocalAiSidebarViewIds.logs,
        this.logsProvider,
        options
      )
    );

    context.subscriptions.push(this);
  }

  setStatus(status: SidebarStatus): void {
    this.connectionProvider.setStatus(status);
    this.controlsProvider.setStatus(status);
  }

  appendLog(entry: SidebarLogEntry): void {
    this.logs.push(entry);
    while (this.logs.length > LocalAiSidebar.logLimit) {
      this.logs.shift();
    }
    this.logsProvider.appendLog(entry);
  }

  clearLogs(): void {
    this.logs.length = 0;
    this.logsProvider.setLogs([]);
  }

  dispose(): void {
    this.connectionProvider.dispose();
    this.controlsProvider.dispose();
    this.logsProvider.dispose();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
