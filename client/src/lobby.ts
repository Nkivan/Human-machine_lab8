import { Bus } from "@dogfight/shared/bus";
import { parseRoomsResponse, type RoomInfo } from "@dogfight/shared/protocol/messages";
import { fetchJson } from "./assets/loader.ts";

export interface LobbyEvents {
  roomsChanged: readonly RoomInfo[];
  refreshFailed: Error;
  joined: { room: RoomInfo; name: string };
}

export interface LobbyOptions {
  readonly url?: string;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

// Data layer only. lobbyView.ts renders and listens to `events`; typed: the event name decides the payload.
export class Lobby {
  readonly events = new Bus<LobbyEvents>();
  #rooms: readonly RoomInfo[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #ctrl: AbortController | null = null;
  readonly #url: string;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;

  constructor({ url = "/api/rooms", intervalMs = 5000, timeoutMs = 3000 }: LobbyOptions = {}) {
    this.#url = url;
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
  }

  async refresh(): Promise<void> {
    this.#ctrl?.abort(); // a newer refresh supersedes an in-flight one
    const ctrl = new AbortController();
    this.#ctrl = ctrl;
    const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(this.#timeoutMs)]); // timeout on EVERY request
    try {
      const parsed = parseRoomsResponse(await fetchJson(this.#url, { signal })); // `unknown` in, validated rooms out
      if (!parsed.ok) throw new Error(`bad /api/rooms response: ${parsed.error}`);
      this.#rooms = parsed.value.rooms;
      this.events.emit("roomsChanged", this.#rooms);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return; // cancelled on purpose: not an error
      this.events.emit("refreshFailed", err instanceof Error ? err : new Error(String(err)));
    }
  }

  async create(name: string): Promise<void> {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const message =
        typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
          ? body.error
          : `HTTP ${res.status}`;
      throw new Error(message);
    }
    await this.refresh();
  }

  start(): void {
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.#intervalMs);
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#ctrl?.abort();
  } // no orphaned requests after leaving

  join(roomId: string, name: string): void {
    const room = this.#rooms.find((r) => r.id === roomId);
    if (!room || room.players >= room.max) throw new Error(`cannot join ${roomId}`);
    this.stop();
    this.events.emit("joined", { room, name });
  }
}
