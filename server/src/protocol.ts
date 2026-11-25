// Builders for server -> client JSON messages. The return type ServerMessage (inferred from the zod schema in shared)
// means a typo in a field name or a wrong payload shape is a compile error.
import { PROTOCOL_VERSION } from "@dogfight/shared/protocol/constants";
import type { EntityId, Tick } from "@dogfight/shared/protocol/ids";
import type { NetsimSettings, ServerMessage, WireEvent } from "@dogfight/shared/protocol/messages";

const v = PROTOCOL_VERSION;

export const serverMsg = {
  roster: (players: string[]): ServerMessage => ({ v, type: "roster", players }),
  chat: (from: string, text: string, t: number): ServerMessage => ({ v, type: "chat", from, text, t }),
  system: (text: string): ServerMessage => ({ v, type: "system", text }),
  error: (code: string, message: string): ServerMessage => ({ v, type: "error", code, message }),
  welcome: (info: { you: EntityId; tick: Tick; tickRate: number; seed: number }): ServerMessage => ({
    v,
    type: "welcome",
    ...info,
  }),
  events: (list: WireEvent[]): ServerMessage => ({ v, type: "events", list }),
  scores: (list: [string, number][]): ServerMessage => ({ v, type: "scores", list }),
  netsim: (s: NetsimSettings): ServerMessage => ({ v, type: "netsim", ...s }),
};
