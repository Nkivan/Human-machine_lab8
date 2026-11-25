import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { PROTOCOL_VERSION } from "@dogfight/shared/protocol/constants";
import { RoomLogEvent } from "../src/log/events.ts";
import { connect, join, sendMsg, start, waitFor, waitJson } from "./helpers.ts";

test("two clients join a room, see each other, chat; the match log is written and valid", async () => {
  const h = await start();
  try {
    const a = await connect(h.base);
    const b = await connect(h.base);
    join(a, "alpha", "Ann");
    await waitFor(a, (m) => m.type === "roster" && m.players.join() === "Ann");
    join(b, "alpha", "Bob");
    await waitFor(a, (m) => m.type === "roster" && m.players.join() === "Ann,Bob");
    sendMsg(b, { v: PROTOCOL_VERSION, type: "chat", text: "hello there" });
    const chat = await waitJson(a, "chat");
    assert.equal(chat.from, "Bob");
    assert.equal(chat.text, "hello there");
    a.ws.close();
    b.ws.close();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    await h.app.close();
  }
  const file = (await readdir(h.dir)).find((f) => f.startsWith("alpha-"));
  assert.ok(file);
  const events = (await readFile(path.join(h.dir, file), "utf8"))
    .trim()
    .split("\n")
    .map((l) => RoomLogEvent.parse(JSON.parse(l))); // every line is valid
  assert.deepEqual(
    events.map((e) => e.type).filter((t) => ["created", "join", "chat", "closed"].includes(t)),
    ["created", "join", "join", "chat", "closed"],
  );
  await h.cleanup();
});

test("protocol violations close the socket with specific codes", async () => {
  const h = await start();
  try {
    const bad = await connect(h.base);
    bad.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "nope" }));
    assert.equal(await bad.closed, 4003);

    const noRoom = await connect(h.base);
    join(noRoom, "does-not-exist", "X");
    assert.equal(await noRoom.closed, 4006);

    const early = await connect(h.base);
    sendMsg(early, { v: PROTOCOL_VERSION, type: "chat", text: "hi" });
    assert.equal(await early.closed, 4004);

    const garbage = await connect(h.base);
    garbage.ws.send("{not json");
    assert.equal(await garbage.closed, 4002);
  } finally {
    await h.cleanup();
  }
});

test("oversize payload -> 1009; rate limit -> 4008", async () => {
  const h = await start({ MSG_PER_SEC: "1", MSG_BURST: "3" });
  try {
    const big = await connect(h.base);
    big.ws.on("error", () => {});
    big.ws.send("x".repeat(3000));
    assert.equal(await big.closed, 1009);

    const fast = await connect(h.base);
    join(fast, "alpha", "Fast");
    for (let i = 0; i < 6; i++) sendMsg(fast, { v: PROTOCOL_VERSION, type: "chat", text: `m${i}` });
    assert.equal(await fast.closed, 4008);
  } finally {
    await h.cleanup();
  }
});

test("HTTP: health, rooms API validated by schema, body cap, traversal guards", async () => {
  const h = await start();
  try {
    assert.equal((await fetch(`http://${h.base}/health`)).status, 200);
    const list: unknown = await (await fetch(`http://${h.base}/api/rooms`)).json();
    assert.ok(typeof list === "object" && list !== null && "rooms" in list && Array.isArray(list.rooms));

    const post = (body: string): Promise<Response> =>
      fetch(`http://${h.base}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal((await post(JSON.stringify({ name: "My room", arena: { asteroids: 3 } }))).status, 201);
    assert.equal((await post(JSON.stringify({ name: "" }))).status, 400);
    assert.equal(
      (await post(JSON.stringify({ name: "ok", arena: { asteroids: 999 } }))).status,
      400,
      "the arena range is enforced by the schema",
    );
    assert.equal((await post("{broken")).status, 400);
    assert.equal((await post(JSON.stringify({ name: "x", pad: "y".repeat(10000) }))).status, 413);

    assert.equal((await fetch(`http://${h.base}/..%2f..%2fetc/passwd`)).status, 403);
    assert.equal((await fetch(`http://${h.base}/api/replays/..%2f..%2fetc%2fpasswd`)).status, 400);
    assert.equal((await fetch(`http://${h.base}/api/nope`)).status, 404);
  } finally {
    await h.cleanup();
  }
});

test("replay endpoint lists logs and 404s on a missing one", async () => {
  const h = await start();
  try {
    const data: unknown = await (await fetch(`http://${h.base}/api/replays`)).json();
    assert.ok(typeof data === "object" && data !== null && "replays" in data && Array.isArray(data.replays));
    assert.equal((await fetch(`http://${h.base}/api/replays/missing.ndjson`)).status, 404);
  } finally {
    await h.cleanup();
  }
});

test("the JSON snapshot codec is selectable (?codec=json) and its messages pass the same schema", async () => {
  const h = await start({ DEBUG_ROUTES: "1" });
  try {
    const c = await connect(h.base, "?codec=json");
    join(c, "alpha", "Json");
    const snap = await waitJson(c, "snapshot");
    assert.ok(snap.entities.length >= 1);
    assert.equal(c.bin.filter((f) => f.type === "snapshot").length, 0, "no binary snapshots on this connection");
    const ship = snap.entities.find((e) => e.kind === "ship");
    assert.ok(ship && ship.kind === "ship" && ship.hp === 100);
  } finally {
    await h.cleanup();
  }
});
