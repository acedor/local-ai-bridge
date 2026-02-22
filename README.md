# Local AI Bridge (VS Code Extension)

`local-ai-bridge` starts a localhost server inside VS Code and exposes:

- a browser chat UI at `http://127.0.0.1:<port>/`
- HTTP/WebSocket endpoints for external web clients
- streamed responses from providers available through `vscode.lm`

The bridge is provider-agnostic: it uses `vscode.lm.selectChatModels()` and does not hardcode model vendors.

## Features

- Binds to `127.0.0.1` only (never `0.0.0.0`)
- Start/stop from Command Palette:
  - `Local AI: Start Server`
  - `Local AI: Stop Server`
- Configurable port, transport, and auto-start
- Streaming via:
  - SSE (`EventSource`)
  - WebSocket
- Built-in UI plus standalone external demo client

## Requirements

- VS Code `^1.95.0`
- Node.js 18+ recommended
- At least one VS Code extension that exposes chat models via `vscode.lm`

## Settings

```json
{
  "localAI.transport": "sse",
  "localAI.port": 3000,
  "localAI.autoStart": true
}
```

- `localAI.transport`: `"sse"` or `"websocket"` (default: `"sse"`)
- `localAI.port`: `1024-65535` (default: `3000`)
- `localAI.autoStart`: start on VS Code launch

Changing `localAI.port` or `localAI.transport` restarts the running server automatically.

## Quick Start

1. Open `local-ai-bridge` in VS Code.
2. Run:
   ```bash
   npm install
   npm run compile
   ```
3. Press `F5` to open an Extension Development Host.
4. In that window, run `Local AI: Start Server`.
5. Open `http://127.0.0.1:<port>/` (replace `<port>` with `localAI.port`).

## UI Options

Use either client depending on your goal:

- Built-in UI (`webview/index.html`)
  - URL: `http://127.0.0.1:<port>/`
  - Best for quick validation of the extension itself
  - Event Logs panel shows bridge-wide activity via `/events` (including traffic from `demo-web` and other clients)
- External demo web (`demo-web/index.html`)
  - Run: `npm run demo:web`
  - URL: `http://127.0.0.1:3001`
  - Best for testing a real external browser app against the bridge API

## Testing Connection (Demo Web)

Use this section to verify that an external browser app can connect to the Local AI Bridge and stream responses.

1. Start the extension server.
   - Open this project in VS Code.
   - Press `F5` (Extension Development Host).
   - In the new window, run `Local AI: Start Server`.
2. Start demo web.
   - In this project folder, run:
     ```bash
     npm run demo:web
     ```
   - Open `http://127.0.0.1:3001`.
3. Configure connection in demo web.
   - Set `Bridge URL` to `http://127.0.0.1:<port>` (`<port>` = your `localAI.port`).
   - Set `Transport` to `Auto` (or explicitly choose `SSE` / `WebSocket`).
   - Click `Connect`.
4. Validate model + chat stream.
   - Click `Refresh Models` and confirm at least one model appears.
   - Send a prompt and confirm the assistant response arrives incrementally (streaming).
   - Click `Stop` during a long response and confirm generation ends.

Pass criteria:

- Demo web status shows connected.
- Model list loads successfully.
- Prompt returns streamed chunks.
- Stop action interrupts streaming.

If it fails:

- Check bridge URL/port match `localAI.port`.
- Ensure at least one `vscode.lm` provider is installed and signed in.
- Ensure transport setting matches available endpoint (`sse` vs `websocket`).

## API

Base URL: `http://127.0.0.1:<port>`

- `GET /health`
  - returns `{ "ok": true }`
- `GET /config`
  - returns `{ "transport": "sse|websocket", "port": <number> }`
- `GET /models`
  - returns `{ "models": [...] }`
- `POST /chat`
  - request: `{ "prompt": "...", "model": "...", "clientId": "..." }`
  - `prompt` required, `model` optional, `clientId` optional
  - requires an active stream connection for the same `clientId`
  - response: `202 { "accepted": true, "clientId": "..." }`
- `POST /chat/stop`
  - request: `{ "clientId": "..." }`
  - response: `{ "stopped": true|false, "clientId": "..." }`
- `GET /chat/stream` (SSE mode only)
  - URL: `/chat/stream?clientId=...`
- `WS /chat/ws` (WebSocket mode only)
  - URL: `ws://127.0.0.1:<port>/chat/ws?clientId=...`
  - optional client message: `{ "type": "stop" }`

## Streaming Payload Contract

The stream emits JSON chunks:

```json
{ "delta": "partial text", "done": false }
```

```json
{ "delta": "", "done": true }
```

```json
{ "error": "message", "done": true }
```

## Behavior Notes

- If no models are available:
  - `/models` returns an empty `models` array
  - `/chat` can be accepted, then the stream emits an error payload
- If no stream connection exists for `clientId`, `POST /chat` returns `409`

## Architecture

```text
vscode.lm stream
      |
      v
 StreamTransport (interface)
   |-- SseTransport       -> GET /chat/stream
   `-- WebSocketTransport -> WS  /chat/ws
```

Key files:

- `src/extension.ts` activation, commands, config lifecycle
- `src/server.ts` server bootstrap, localhost restriction, static/config routes
- `src/routes/chat.ts` chat/model/stream routing and client sessions
- `src/llm.ts` model lookup and token streaming from `vscode.lm`
- `src/transport/*` transport implementations
- `webview/index.html` built-in browser UI
- `demo-web/index.html` standalone external demo UI

## Security

- Server binds to localhost only
- Non-local remote addresses are rejected
- CORS is enabled for local web app interoperability
- No authentication is implemented (intended for trusted local use)

## Scripts

- `npm run compile` build TypeScript to `out/`
- `npm run watch` TypeScript watch mode
- `npm run demo:web` serve external demo client at `http://127.0.0.1:3001`
- `npm run vscode:prepublish` prepublish compile

## Troubleshooting

- No models listed:
  - install/sign in to a provider extension that supports `vscode.lm`
- `409` on `POST /chat`:
  - connect stream endpoint first (`/chat/stream` or `/chat/ws`) with same `clientId`
- Transport endpoint errors:
  - ensure endpoint matches `localAI.transport` setting
- Port conflict:
  - change `localAI.port` and restart
