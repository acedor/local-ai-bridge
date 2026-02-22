export type BridgeEventDirection = "in" | "out" | "event" | "error";

export interface BridgeEvent {
  ts: string;
  direction: BridgeEventDirection;
  source: string;
  message: string;
  data?: unknown;
}
