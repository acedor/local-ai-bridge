import * as vscode from "vscode";
import type { BridgeEvent } from "./events";
import {
  LocalAiSidebar,
  type SidebarLogLevel,
  type SidebarSettings,
  type SidebarStatus,
} from "./sidebar";
import { LocalAiServer, type LocalAiServerConfig } from "./server";
import type { TransportMode } from "./routes/chat";

const LOCALHOST = "127.0.0.1";

let server: LocalAiServer | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let sidebarView: LocalAiSidebar | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let lastErrorMessage: string | undefined;

interface LocalAiSettings extends LocalAiServerConfig {
  autoStart: boolean;
}

function readSettings(): LocalAiSettings {
  const config = vscode.workspace.getConfiguration("localAI");
  const port = config.get<number>("port", 3000);
  const transportSetting = config.get<string>("transport", "sse");
  const autoStart = config.get<boolean>("autoStart", true);
  const transport: TransportMode =
    transportSetting === "websocket" ? "websocket" : "sse";

  return {
    port,
    transport,
    autoStart,
  };
}

function stringifyLogData(data: unknown): string {
  if (data === undefined) {
    return "";
  }

  let output: string;
  if (typeof data === "string") {
    output = data;
  } else {
    try {
      output = JSON.stringify(data);
    } catch {
      output = String(data);
    }
  }

  if (output.length > 1200) {
    return ` ${output.slice(0, 1200)} ...[truncated]`;
  }

  return ` ${output}`;
}

function log(
  message: string,
  options?: {
    source?: string;
    level?: SidebarLogLevel;
    data?: unknown;
    ts?: string;
  }
): void {
  const ts = options?.ts ?? new Date().toISOString();
  const source = options?.source ?? "extension";
  const level = options?.level ?? "event";

  outputChannel?.appendLine(
    `[${ts}] [${source}/${level}] ${message}${stringifyLogData(options?.data)}`
  );

  sidebarView?.appendLog({
    ts,
    source,
    level,
    message,
    data: options?.data,
  });
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return fallback;
}

function mapDirectionToLogLevel(
  direction: BridgeEvent["direction"]
): SidebarLogLevel {
  switch (direction) {
    case "in":
      return "in";
    case "out":
      return "out";
    case "error":
      return "error";
    default:
      return "event";
  }
}

function getConfigTarget(): vscode.ConfigurationTarget {
  if (vscode.workspace.workspaceFolders?.length) {
    return vscode.ConfigurationTarget.Workspace;
  }

  return vscode.ConfigurationTarget.Global;
}

function getSidebarStatus(): SidebarStatus {
  const settings = readSettings();
  const running = server?.isRunning() ?? false;
  const url = server?.getUrl() ?? `http://${LOCALHOST}:${settings.port}`;

  return {
    running,
    ready: running,
    url,
    transport: settings.transport,
    port: settings.port,
    autoStart: settings.autoStart,
    lastError: lastErrorMessage,
  };
}

function refreshSidebarStatus(): void {
  sidebarView?.setStatus(getSidebarStatus());
}

function setLastError(message?: string): void {
  lastErrorMessage = message;
  refreshSidebarStatus();
}

function captureBridgeEvent(event: BridgeEvent): void {
  log(event.message, {
    source: event.source,
    level: mapDirectionToLogLevel(event.direction),
    data: event.data,
    ts: event.ts,
  });
}

async function startServer(options?: { openBrowser?: boolean }): Promise<void> {
  if (!server) {
    return;
  }

  const wasRunning = server.isRunning();
  await server.start();
  setLastError(undefined);

  const url = server.getUrl();
  if (!url) {
    return;
  }

  if (!wasRunning) {
    const settings = readSettings();
    const summary = `Local AI Bridge is running at ${url} (${settings.transport}).`;
    log(summary, { source: "server" });
    void vscode.window.showInformationMessage(summary);
  }

  if (options?.openBrowser) {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

async function stopServer(): Promise<void> {
  if (!server || !server.isRunning()) {
    refreshSidebarStatus();
    return;
  }

  await server.stop();
  setLastError(undefined);
  log("Local AI Bridge server stopped.", { source: "server" });
  void vscode.window.showInformationMessage("Local AI Bridge server stopped.");
}

async function restartServerForConfigChange(): Promise<void> {
  if (!server?.isRunning()) {
    refreshSidebarStatus();
    return;
  }

  await server.stop();
  await server.start();
  setLastError(undefined);

  const url = server.getUrl();
  if (url) {
    const settings = readSettings();
    const summary = `Local AI Bridge restarted at ${url} (${settings.transport}).`;
    log(summary, { source: "server" });
    void vscode.window.showInformationMessage(summary);
  }
}

function handleOperationError(prefix: string, error: unknown): void {
  const message = getErrorMessage(error, `${prefix}.`);
  log(`${prefix}: ${message}`, {
    source: "extension",
    level: "error",
  });
  setLastError(message);
  void vscode.window.showErrorMessage(`Local AI Bridge: ${message}`);
}

function scheduleRestartForConfigChange(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    void restartServerForConfigChange().catch((error) => {
      handleOperationError("Restart failed", error);
    });
  }, 200);
}

async function updateSettingsFromSidebar(
  settings: SidebarSettings
): Promise<void> {
  const current = readSettings();
  const config = vscode.workspace.getConfiguration("localAI");
  const target = getConfigTarget();
  const updates: Thenable<void>[] = [];

  if (current.port !== settings.port) {
    updates.push(config.update("port", settings.port, target));
  }

  if (current.transport !== settings.transport) {
    updates.push(config.update("transport", settings.transport, target));
  }

  if (current.autoStart !== settings.autoStart) {
    updates.push(config.update("autoStart", settings.autoStart, target));
  }

  if (updates.length === 0) {
    log("Settings unchanged.", { source: "settings" });
    refreshSidebarStatus();
    return;
  }

  await Promise.all(updates);
  setLastError(undefined);
  log("Settings updated from sidebar.", {
    source: "settings",
    data: settings,
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Local AI Bridge");
  context.subscriptions.push(outputChannel);

  const appVersion =
    typeof context.extension.packageJSON.version === "string"
      ? context.extension.packageJSON.version
      : "0.0.0";
  server = new LocalAiServer(
    context.extensionPath,
    () => readSettings(),
    appVersion,
    (message) => log(message, { source: "server" }),
    captureBridgeEvent
  );

  sidebarView = new LocalAiSidebar(
    {
      start: async () => {
        try {
          await startServer({ openBrowser: false });
        } catch (error) {
          handleOperationError("Start failed", error);
          throw error;
        }
      },
      stop: async () => {
        try {
          await stopServer();
        } catch (error) {
          handleOperationError("Stop failed", error);
          throw error;
        }
      },
      saveSettings: async (settings) => {
        try {
          await updateSettingsFromSidebar(settings);
        } catch (error) {
          handleOperationError("Failed to update settings", error);
          throw error;
        }
      },
      refresh: () => {
        refreshSidebarStatus();
      },
    },
    getSidebarStatus()
  );
  sidebarView.register(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("localAI.startServer", async () => {
      try {
        await startServer({ openBrowser: true });
      } catch (error) {
        handleOperationError("Start failed", error);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("localAI.stopServer", async () => {
      try {
        await stopServer();
      } catch (error) {
        handleOperationError("Stop failed", error);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      const affectsPort = event.affectsConfiguration("localAI.port");
      const affectsTransport = event.affectsConfiguration("localAI.transport");
      const affectsAutoStart = event.affectsConfiguration("localAI.autoStart");

      if (affectsPort || affectsTransport) {
        scheduleRestartForConfigChange();
      }

      if (affectsPort || affectsTransport || affectsAutoStart) {
        log("Configuration changed.", {
          source: "settings",
          data: readSettings(),
        });
        setLastError(undefined);
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
    },
  });

  refreshSidebarStatus();

  const settings = readSettings();
  if (settings.autoStart) {
    void startServer({ openBrowser: false }).catch((error) => {
      handleOperationError("Auto-start failed", error);
    });
  }
}

export async function deactivate(): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }

  if (server) {
    await server.stop();
  }
}
