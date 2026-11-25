import assert from "node:assert/strict";
import { test } from "vitest";
import { connect, createRoom, join, sleep, start, waitJson } from "./helpers.ts";

test("a room with pickupEvery set spawns pickups, and they travel in the snapshots to the client", async () => {
  const h = await start({ DEBUG_ROUTES: "1", SEED_ROOMS: "0" });
  try {
    const roomId = await createRoom(h.base, { name: "pickups", arena: { asteroids: 0, pickupEvery: 2, seed: 3 } });
    const c = await connect(h.base);
    join(c, roomId, "Pilot");
    await waitJson(c, "welcome");
    let found = false;
    for (let i = 0; i < 80 && !found; i++) {
      found = c.bin.some((f) => f.type === "snapshot" && f.snapshot.entities.some((e) => e.kind === "pickup"));
      if (!found) await sleep(100);
    }
    assert.ok(found, "no pickup appeared within 8 s");
    c.ws.close();
  } finally {
    await h.cleanup();
  }
});
