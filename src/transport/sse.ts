import type { Response } from "express";
import type { StreamTransport } from "./interface";

export class SseTransport implements StreamTransport {
  private closed = false;

  constructor(private readonly response: Response) {
    this.response.setHeader("Content-Type", "text/event-stream");
    this.response.setHeader("Cache-Control", "no-cache, no-transform");
    this.response.setHeader("Connection", "keep-alive");
    this.response.setHeader("X-Accel-Buffering", "no");
    this.response.flushHeaders?.();
  }

  send(chunk: string): void {
    if (this.closed || this.response.writableEnded) {
      return;
    }

    this.response.write(`data: ${chunk}\n\n`);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (!this.response.writableEnded) {
      this.response.end();
    }
  }
}
