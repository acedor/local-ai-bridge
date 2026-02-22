export interface StreamTransport {
  send(chunk: string): void;
  close(): void;
}
