import type { Application, Request, Response } from "express";
import type WebSocket from "ws";
import * as vscode from "vscode";
import type { BridgeEvent } from "../events";
import { listModels, streamPromptToTransport } from "../llm";
import type { StreamTransport } from "../transport/interface";
import { SseTransport } from "../transport/sse";
import { WebSocketTransport } from "../transport/websocket";

export type TransportMode = "sse" | "websocket";
type EmitBridgeEvent = (event: Omit<BridgeEvent, "ts">) => void;

interface RegisterChatRoutesOptions {
  app: Application;
  getTransportMode: () => TransportMode;
  log: (message: string) => void;
  emitEvent: EmitBridgeEvent;
}

interface ClientSession {
  transport: StreamTransport;
  cancellation?: vscode.CancellationTokenSource;
  keepAliveTimer?: NodeJS.Timeout;
}

interface WsEnabledApp extends Application {
  ws(path: string, handler: (socket: WebSocket, request: Request) => void): void;
}

function parseClientId(input: unknown): string {
  if (typeof input === "string" && input.trim().length > 0) {
    return input.trim();
  }

  return "default";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseJsonLike(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export function registerChatRoutes(options: RegisterChatRoutesOptions): () => void {
  const { app, getTransportMode, log, emitEvent } = options;
  const sessions = new Map<string, ClientSession>();

  const disposeSession = (clientId: string, expected?: ClientSession): void => {
    const current = sessions.get(clientId);
    if (!current) {
      return;
    }

    if (expected && current !== expected) {
      return;
    }

    current.cancellation?.cancel();
    current.cancellation?.dispose();

    if (current.keepAliveTimer) {
      clearInterval(current.keepAliveTimer);
    }

    current.transport.close();
    sessions.delete(clientId);
  };

  app.get("/models", async (_req: Request, res: Response) => {
    try {
      const models = await listModels();
      res.json({ models });
      emitEvent({
        source: "models",
        direction: "out",
        message: `Returned ${models.length} model(s).`,
      });
    } catch (error) {
      emitEvent({
        source: "models",
        direction: "error",
        message: "Failed to list models.",
        data: getErrorMessage(error),
      });
      res.status(500).json({
        error: getErrorMessage(error),
      });
    }
  });

  app.post("/chat", async (req: Request, res: Response) => {
    const prompt =
      typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const modelId =
      typeof req.body?.model === "string" && req.body.model.length > 0
        ? req.body.model
        : undefined;
    const clientId = parseClientId(req.body?.clientId);
    emitEvent({
      source: "chat",
      direction: "in",
      message: "Incoming chat request.",
      data: {
        clientId,
        model: modelId ?? null,
        prompt,
      },
    });

    if (!prompt) {
      emitEvent({
        source: "chat",
        direction: "error",
        message: "Rejected chat request: prompt is empty.",
      });
      res.status(400).json({
        error: "Request body must include a non-empty prompt.",
        done: true,
      });
      return;
    }

    const session = sessions.get(clientId);
    if (!session) {
      emitEvent({
        source: "chat",
        direction: "error",
        message: `Rejected chat request: no active stream for client ${clientId}.`,
      });
      res.status(409).json({
        error: `No active ${getTransportMode()} stream connection for client "${clientId}".`,
        done: true,
      });
      return;
    }

    if (session.cancellation) {
      session.cancellation.cancel();
      session.cancellation.dispose();
      session.cancellation = undefined;
    }

    const cancellation = new vscode.CancellationTokenSource();
    session.cancellation = cancellation;

    res.status(202).json({ accepted: true, clientId });
    emitEvent({
      source: "chat",
      direction: "out",
      message: `Accepted chat request for client ${clientId}.`,
    });

    const observedTransport: StreamTransport = {
      send: (chunk: string) => {
        emitEvent({
          source: "stream",
          direction: "out",
          message: `Chunk sent to client ${clientId}.`,
          data: parseJsonLike(chunk),
        });
        session.transport.send(chunk);
      },
      close: () => {
        session.transport.close();
      },
    };

    void streamPromptToTransport({
      prompt,
      modelId,
      transport: observedTransport,
      token: cancellation.token,
    }).finally(() => {
      if (session.cancellation === cancellation) {
        session.cancellation.dispose();
        session.cancellation = undefined;
      }

      emitEvent({
        source: "chat",
        direction: "event",
        message: `Chat request finished for client ${clientId}.`,
      });
    });
  });

  app.post("/chat/stop", (req: Request, res: Response) => {
    const clientId = parseClientId(req.body?.clientId);
    emitEvent({
      source: "chat",
      direction: "in",
      message: "Incoming stop request.",
      data: { clientId },
    });
    const session = sessions.get(clientId);

    if (!session?.cancellation) {
      emitEvent({
        source: "chat",
        direction: "event",
        message: `No active generation to stop for client ${clientId}.`,
      });
      res.json({ stopped: false, clientId });
      return;
    }

    session.cancellation.cancel();
    session.cancellation.dispose();
    session.cancellation = undefined;
    res.json({ stopped: true, clientId });
    emitEvent({
      source: "chat",
      direction: "out",
      message: `Stopped active generation for client ${clientId}.`,
    });
  });

  app.get("/chat/stream", (req: Request, res: Response) => {
    if (getTransportMode() !== "sse") {
      emitEvent({
        source: "stream",
        direction: "error",
        message: "SSE stream request rejected because transport is websocket.",
      });
      res.status(400).json({
        error:
          "SSE endpoint is disabled because localAI.transport is set to websocket.",
      });
      return;
    }

    const clientId = parseClientId(req.query.clientId);
    disposeSession(clientId);

    const transport = new SseTransport(res);
    const keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": keep-alive\n\n");
      }
    }, 15000);

    const session: ClientSession = {
      transport,
      keepAliveTimer,
    };
    sessions.set(clientId, session);
    emitEvent({
      source: "connection",
      direction: "event",
      message: `SSE client connected (${clientId}).`,
    });
    log(`SSE client connected (${clientId}).`);

    req.on("close", () => {
      disposeSession(clientId, session);
      emitEvent({
        source: "connection",
        direction: "event",
        message: `SSE client disconnected (${clientId}).`,
      });
      log(`SSE client disconnected (${clientId}).`);
    });
  });

  (app as WsEnabledApp).ws("/chat/ws", (socket: WebSocket, req: Request) => {
    if (getTransportMode() !== "websocket") {
      emitEvent({
        source: "stream",
        direction: "error",
        message: "WebSocket stream request rejected because transport is sse.",
      });
      socket.send(
        JSON.stringify({
          error:
            "WebSocket endpoint is disabled because localAI.transport is set to sse.",
          done: true,
        })
      );
      socket.close();
      return;
    }

    const url = new URL(req.url ?? "/chat/ws", "http://localhost");
    const clientId = parseClientId(url.searchParams.get("clientId"));

    disposeSession(clientId);

    const session: ClientSession = {
      transport: new WebSocketTransport(socket),
    };
    sessions.set(clientId, session);
    emitEvent({
      source: "connection",
      direction: "event",
      message: `WebSocket client connected (${clientId}).`,
    });
    log(`WebSocket client connected (${clientId}).`);

    socket.on("message", (raw) => {
      emitEvent({
        source: "stream",
        direction: "in",
        message: `WebSocket message received from ${clientId}.`,
        data: parseJsonLike(String(raw)),
      });
      try {
        const payload = JSON.parse(String(raw));
        if (payload?.type === "stop" && session.cancellation) {
          session.cancellation.cancel();
          session.cancellation.dispose();
          session.cancellation = undefined;
        }
      } catch {
        // Ignore non-JSON messages.
      }
    });

    socket.on("close", () => {
      disposeSession(clientId, session);
      emitEvent({
        source: "connection",
        direction: "event",
        message: `WebSocket client disconnected (${clientId}).`,
      });
      log(`WebSocket client disconnected (${clientId}).`);
    });
  });

  return () => {
    for (const [clientId] of sessions) {
      disposeSession(clientId);
    }
  };
}
