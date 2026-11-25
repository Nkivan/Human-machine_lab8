import assert from "node:assert/strict";
import { test } from "vitest";
import { parseClientMessage, parseServerMessage } from "../src/protocol/messages.ts";

test("parseClientMessage accepts valid messages and normalizes them (trim)", () => {
  const join = parseClientMessage({ v: 2, type: "join", room: "alpha", name: "  Ann " });
  assert.ok(join.ok && join.value.type === "join");
  assert.equal(join.value.name, "Ann");
  const chat = parseClientMessage({ v: 2, type: "chat", text: " hi " });
  assert.ok(chat.ok && chat.value.type === "chat");
  assert.equal(chat.value.text, "hi");
});

test("parseClientMessage rejects bad shapes with a message, and never throws", () => {
  const bad: unknown[] = [
    null,
    [],
    "x",
    42,
    { v: 99, type: "chat", text: "a" },
    { v: 2, type: "nope" },
    { v: 2, type: "chat", text: "" },
    { v: 2, type: "chat", text: "a".repeat(201) },
    { v: 2, type: "join", room: "../x", name: "A" },
    { v: 2, type: "join", room: "a", name: "bad\nname" },
    { v: 2, type: "netsim", latency: 1e9, jitter: 0, drop: 0 },
    { v: 2, type: "netsim", latency: Number.NaN, jitter: 0, drop: 0 },
  ];
  for (const input of bad) {
    const r = parseClientMessage(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    if (!r.ok) assert.ok(r.error.length > 0 && r.error.length <= 100);
  }
});

test("parseServerMessage validates what the server sends (events are a discriminated union)", () => {
  const ok = parseServerMessage({
    v: 2,
    type: "events",
    list: [
      { k: "hit", x: 1, y: 2 },
      { k: "exploded", x: 1, y: 2, kind: "ship" },
    ],
  });
  assert.ok(ok.ok);
  assert.equal(
    parseServerMessage({ v: 2, type: "events", list: [{ k: "exploded", x: 1, y: 2, kind: "planet" }] }).ok,
    false,
  );
  assert.equal(parseServerMessage({ v: 2, type: "welcome", you: 70000, tick: 1, tickRate: 30, seed: 1 }).ok, false); // id > 16 bits
});
