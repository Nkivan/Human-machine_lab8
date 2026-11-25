import { fetchJson, loadAll, Manifest, withRetry, type LoadedAssets } from "./assets/loader.ts";
import { loadWithScreen, type LoadHandle } from "./assets/loadingScreen.ts";
import { applyTestMode } from "./assets/testmodes.ts";
import { createAudio } from "./audio.ts";
import { startNetGame } from "./game.ts";
import { Lobby } from "./lobby.ts";
import { createLobbyView } from "./lobbyView.ts";
import { setupCanvas } from "./render/canvas.ts";
import { simHashNote } from "./simcheck.ts";
import { parseRoomsResponse, type RoomInfo } from "@dogfight/shared/protocol/messages";

const canvas = document.getElementById("game");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("#game canvas is missing from index.html"); // narrowing instead of a cast
const { ctx, view } = setupCanvas(canvas);
const params = new URLSearchParams(location.search); // ?lat=100&jitter=30&drop=0.02  ?codec=json  ?noise=1  ?hash=1  ?test=slow ...
if (params.has("hash")) console.log(simHashNote());
const audio = createAudio();
let abortedOnce = false;

async function load({ signal, onProgress, abort }: LoadHandle): Promise<LoadedAssets> {
  const raw = await withRetry(() => fetchJson("/assets/manifest.json", { signal }), { signal });
  const parsed = Manifest.safeParse(raw); // the manifest is a boundary: validated, not trusted
  if (!parsed.success) throw new Error(`manifest.json is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  const manifest = applyTestMode(parsed.data, params.get("test"));
  if (params.get("test") === "abort" && !abortedOnce) {
    abortedOnce = true;
    setTimeout(abort, 600);
  }
  return loadAll(manifest, { ctx: audio.ctx, signal, onProgress, sequential: params.has("seq") });
}

function enterLobby(): Promise<{ room: RoomInfo; name: string }> {
  return new Promise((resolve) => {
    // an event that fires ONCE -> a promise
    const lobby = new Lobby();
    const lobbyView = createLobbyView(lobby);
    const off = lobby.events.on("joined", (joined) => {
      off();
      lobbyView.destroy();
      resolve(joined);
    });
    lobby.start();
  });
}

// ?room=<id>&name=<callsign> skips the lobby (Playwright tests and perf runs use it).
async function directJoin(roomId: string, name: string): Promise<{ room: RoomInfo; name: string }> {
  const parsed = parseRoomsResponse(await fetchJson("/api/rooms"));
  if (!parsed.ok) throw new Error(`bad /api/rooms response: ${parsed.error}`);
  const room = parsed.value.rooms.find((r) => r.id === roomId);
  if (!room) throw new Error(`no such room: ${roomId}`);
  return { room, name };
}

const assets = await loadWithScreen({ canvas, ctx, view, start: load });
audio.setBuffers(assets.sounds);
const direct = params.get("room");
const { room, name } = direct ? await directJoin(direct, params.get("name") ?? "Pilot") : await enterLobby();
startNetGame({ ctx, view, room, name, assets, audio, params });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
