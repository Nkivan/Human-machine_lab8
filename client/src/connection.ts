import {
  messageIs,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@dogfight/shared/protocol/messages";

// WebSocket wrapper: typed dispatch by message type, send queue while connecting, reconnect with backoff + jitter.
// Text frames are JSON control messages (validated by the shared schema); binary frames go to onBinary as ArrayBuffers.
export type Traffic = "in" | "out";
export interface ConnectionOptions {
  readonly url: string;
  readonly onOpen?: () => void;
  readonly onStatus?: (status: string) => void;
  readonly onTraffic?: (dir: Traffic, bytes: number) => void;
  readonly onBinary?: (buf: ArrayBuffer) => void;
  readonly maxQueue?: number;
}
export interface Connection {
  on<T extends ServerMessage["type"]>(type: T, fn: (msg: Extract<ServerMessage, { type: T }>) => void): void;
  send(msg: ClientMessage): void;
  sendBinary(buf: ArrayBuffer): boolean;
  close(): void;
}

export function createConnection({
  url,
  onOpen = () => {},
  onStatus = () => {},
  onTraffic = () => {},
  onBinary = () => {},
  maxQueue = 50,
}: ConnectionOptions): Connection {
  const handlers: ((msg: ServerMessage) => void)[] = [];
  const queue: ClientMessage[] = [];
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closedByUser = false;

  function sendText(socket: WebSocket, msg: ClientMessage): void {
    const text = JSON.stringify(msg);
    onTraffic("out", text.length);
    socket.send(text);
  }

  function open(): void {
    onStatus("connecting");
    const socket = new WebSocket(url);
    ws = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      attempt = 0;
      onStatus("connected");
      onOpen(); // e.g. (re)send "join" FIRST, before any queued messages
      for (let msg = queue.shift(); msg; msg = queue.shift()) sendText(socket, msg);
    });
    socket.addEventListener("message", (e: MessageEvent) => {
      const data: unknown = e.data; // `any` in the DOM typings: treat it as unknown and narrow
      if (data instanceof ArrayBuffer) {
        onTraffic("in", data.byteLength);
        onBinary(data);
        return;
      }
      if (typeof data !== "string") return;
      onTraffic("in", data.length);
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        return;
      } // never trust the wire
      const msg = parseServerMessage(raw); // ...and validate it
      if (msg.ok) for (const fn of handlers) fn(msg.value);
    });
    socket.addEventListener("close", (e) => {
      if (closedByUser) return onStatus("closed");
      if (e.code >= 4000 && e.code < 5000) return onStatus(`rejected: ${e.reason || e.code}`); // the server said no: do not retry
      onStatus("reconnecting...");
      const wait = Math.min(10_000, 500 * 2 ** attempt++) * (0.5 + Math.random() / 2); // exponential backoff + jitter
      timer = setTimeout(open, wait);
    });
  }
  open();

  return {
    on(type, fn) {
      const is = messageIs(type);
      handlers.push((msg) => {
        if (is(msg)) fn(msg);
      }); // the guard narrows msg to the right member: no cast
    },
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) sendText(ws, msg);
      else if (queue.length < maxQueue) queue.push(msg);
    },
    // Binary frames are never queued: an input from 2 seconds ago is worthless after a reconnect.
    sendBinary(buf) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      onTraffic("out", buf.byteLength);
      ws.send(buf);
      return true;
    },
    close() {
      closedByUser = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
