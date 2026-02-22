import * as vscode from "vscode";
import { LocalAiServer, type LocalAiServerConfig } from "./server";
import type { TransportMode } from "./routes/chat";

let server: LocalAiServer | undefined;
let outputChannel: vscode.OutputChannel | undefined;

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

function log(message: string): void {
  const now = new Date().toISOString();
  outputChannel?.appendLine(`[${now}] ${message}`);
}

async function startServer(options?: { openBrowser?: boolean }): Promise<void> {
  if (!server) {
    return;
  }

  const wasRunning = server.isRunning();
  await server.start();

  const url = server.getUrl();
  if (!url) {
    return;
  }

  if (!wasRunning) {
    const settings = readSettings();
    const summary = `Local AI Bridge is running at ${url} (${settings.transport}).`;
    log(summary);
    void vscode.window.showInformationMessage(summary);
  }

  if (options?.openBrowser) {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

async function stopServer(): Promise<void> {
  if (!server || !server.isRunning()) {
    return;
  }

  await server.stop();
  void vscode.window.showInformationMessage("Local AI Bridge server stopped.");
}

async function restartServerForConfigChange(): Promise<void> {
  if (!server?.isRunning()) {
    return;
  }

  await server.stop();
  await server.start();

  const url = server.getUrl();
  if (url) {
    const settings = readSettings();
    const summary = `Local AI Bridge restarted at ${url} (${settings.transport}).`;
    log(summary);
    void vscode.window.showInformationMessage(summary);
  }
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
    log
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("localAI.startServer", async () => {
      try {
        await startServer({ openBrowser: true });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to start server.";
        log(`Start failed: ${message}`);
        void vscode.window.showErrorMessage(`Local AI Bridge: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("localAI.stopServer", async () => {
      try {
        await stopServer();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to stop server.";
        log(`Stop failed: ${message}`);
        void vscode.window.showErrorMessage(`Local AI Bridge: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      const relevant =
        event.affectsConfiguration("localAI.port") ||
        event.affectsConfiguration("localAI.transport");

      if (!relevant) {
        return;
      }

      try {
        await restartServerForConfigChange();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to apply Local AI setting changes.";
        log(`Restart failed: ${message}`);
        void vscode.window.showErrorMessage(`Local AI Bridge: ${message}`);
      }
    })
  );

  const settings = readSettings();
  if (settings.autoStart) {
    try {
      await startServer({ openBrowser: false });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to auto-start server.";
      log(`Auto-start failed: ${message}`);
      void vscode.window.showErrorMessage(`Local AI Bridge: ${message}`);
    }
  }
}

export async function deactivate(): Promise<void> {
  if (server) {
    await server.stop();
  }
}
