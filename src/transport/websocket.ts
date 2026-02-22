import WebSocket from "ws";
import type { StreamTransport } from "./interface";

export class WebSocketTransport implements StreamTransport {
  constructor(private readonly socket: WebSocket) {}

  send(chunk: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(chunk);
    }
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }
}
