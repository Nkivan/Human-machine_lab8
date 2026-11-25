import { el } from "./dom.ts";
import type { Lobby } from "./lobby.ts";

// DOM rendering only: listens to a Lobby, never fetches.
export function createLobbyView(lobby: Lobby, parent: HTMLElement = document.body): { destroy(): void } {
  const root = el("div", "lobby");
  const name = el("input");
  name.placeholder = "Your callsign";
  name.maxLength = 16;
  const list = el("ul");
  const status = el("p", "status", "Loading rooms...");
  const roomName = el("input");
  roomName.placeholder = "New room name";
  roomName.maxLength = 24;
  const create = el("button", "", "Create room");
  create.addEventListener("click", () => {
    const value = roomName.value.trim();
    if (!value) return;
    lobby
      .create(value)
      .then(() => {
        roomName.value = "";
      })
      .catch((err: unknown) => {
        status.textContent = `Could not create room: ${err instanceof Error ? err.message : String(err)}`;
      });
  });
  const createRow = el("div");
  createRow.style.cssText = "display:flex;gap:8px";
  createRow.append(roomName, create);
  root.append(el("h1", "", "DOGFIGHT"), name, list, createRow, status);
  parent.append(root);

  lobby.events.on("roomsChanged", (rooms) => {
    list.replaceChildren(
      ...rooms.map((room) => {
        const li = el("li");
        const full = room.players >= room.max;
        const join = el("button", "", full ? "Full" : "Join");
        join.disabled = full;
        join.addEventListener("click", () => lobby.join(room.id, name.value.trim() || "Pilot"));
        const bots = room.bots > 0 ? `  +${room.bots} bots` : "";
        li.append(el("span", "", `${room.name}  ${room.players}/${room.max}${bots}`), join);
        return li;
      }),
    );
    status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  });
  lobby.events.on("refreshFailed", (err) => {
    status.textContent = `Could not refresh: ${err.message}`;
  });

  return { destroy: () => root.remove() };
}
