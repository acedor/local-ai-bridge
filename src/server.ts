import express, { type Response } from "express";
import expressWs from "express-ws";
import type { Server } from "http";
import * as path from "path";
import { registerChatRoutes, type TransportMode } from "./routes/chat";
import type { BridgeEvent } from "./events";

const LOCALHOST = "127.0.0.1";
const EVENT_KEEP_ALIVE_MS = 15000;

class BridgeEventHub {
  private readonly clients = new Set<Response>();
  private readonly keepAliveByClient = new Map<Response, NodeJS.Timeout>();

  subscribe(response: Response): void {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();

    this.clients.add(response);

    const keepAlive = setInterval(() => {
      if (!response.writableEnded) {
        response.write(": keep-alive\n\n");
      }
    }, EVENT_KEEP_ALIVE_MS);
    this.keepAliveByClient.set(response, keepAlive);

    response.on("close", () => {
      this.removeClient(response, false);
    });
  }

  emit(event: BridgeEvent): void {
    const chunk = `data: ${JSON.stringify(event)}\n\n`;

    for (const response of this.clients) {
      if (response.writableEnded) {
        this.removeClient(response, false);
        continue;
      }

      try {
        response.write(chunk);
      } catch {
        this.removeClient(response, false);
      }
    }
  }

  dispose(): void {
    for (const response of this.clients) {
      this.removeClient(response, true);
    }
  }

  private removeClient(response: Response, endResponse: boolean): void {
    const keepAlive = this.keepAliveByClient.get(response);
    if (keepAlive) {
      clearInterval(keepAlive);
      this.keepAliveByClient.delete(response);
    }

    this.clients.delete(response);

    if (endResponse && !response.writableEnded) {
      response.end();
    }
  }
}

export interface LocalAiServerConfig {
  port: number;
  transport: TransportMode;
}

export class LocalAiServer {
  private server?: Server;
  private disposeRoutes?: () => void;
  private eventHub?: BridgeEventHub;
  private activeConfig?: LocalAiServerConfig;

  constructor(
    private readonly extensionPath: string,
    private readonly getConfig: () => LocalAiServerConfig,
    private readonly appVersion: string,
    private readonly log: (message: string) => void,
    private readonly onBridgeEvent?: (event: BridgeEvent) => void
  ) {}

  isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  getUrl(): string | undefined {
    if (!this.activeConfig) {
      return undefined;
    }

    return `http://${LOCALHOST}:${this.activeConfig.port}`;
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      return;
    }

    const config = this.getConfig();
    const app = express();
    const eventHub = new BridgeEventHub();
    this.eventHub = eventHub;

    const emitEvent = (event: Omit<BridgeEvent, "ts">): void => {
      const fullEvent: BridgeEvent = {
        ts: new Date().toISOString(),
        ...event,
      };
      eventHub.emit(fullEvent);
      this.onBridgeEvent?.(fullEvent);
    };

    expressWs(app);

    app.disable("x-powered-by");
    app.use(express.json({ limit: "1mb" }));

    app.use((req, res, next) => {
      const remote = req.socket.remoteAddress;
      const isLocal =
        !remote ||
        remote === "127.0.0.1" ||
        remote === "::1" ||
        remote === "::ffff:127.0.0.1";

      if (!isLocal) {
        res.status(403).json({ error: "Localhost access only." });
        return;
      }

      next();
    });

    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }

      next();
    });

    app.get("/events", (_req, res) => {
      eventHub.subscribe(res);
      emitEvent({
        source: "events",
        direction: "event",
        message: "Event subscriber connected.",
      });
    });

    app.use((req, res, next) => {
      if (req.path !== "/events") {
        emitEvent({
          source: "http",
          direction: "in",
          message: `${req.method} ${req.path}`,
          data: req.method === "GET" ? undefined : req.body,
        });

        res.on("finish", () => {
          emitEvent({
            source: "http",
            direction: res.statusCode >= 400 ? "error" : "out",
            message: `${req.method} ${req.path} -> ${res.statusCode}`,
          });
        });
      }

      next();
    });

    app.get("/", (_req, res) => {
      res.sendFile(path.join(this.extensionPath, "webview", "index.html"));
    });

    app.get("/config", (_req, res) => {
      res.json({
        transport: config.transport,
        port: config.port,
        version: this.appVersion,
      });
    });

    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });

    this.disposeRoutes = registerChatRoutes({
      app,
      getTransportMode: () => config.transport,
      log: this.log,
      emitEvent,
    });

    this.server = await new Promise<Server>((resolve, reject) => {
      const instance = app.listen(config.port, LOCALHOST, () => {
        resolve(instance);
      });

      instance.on("error", reject);
    });

    this.activeConfig = config;
    this.log(
      `Server started at http://${LOCALHOST}:${config.port} using ${config.transport} transport.`
    );
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    this.disposeRoutes?.();
    this.disposeRoutes = undefined;
    this.eventHub?.dispose();
    this.eventHub = undefined;

    const serverRef = this.server;
    this.server = undefined;

    await new Promise<void>((resolve, reject) => {
      serverRef.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.log("Server stopped.");
  }
}
