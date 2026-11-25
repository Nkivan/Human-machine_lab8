import { z } from "zod";
import { ArenaConfig } from "@dogfight/shared/protocol/messages";

// What a room writes into its match log (NDJSON). Schema = the boundary for reading a log file back.
export const RoomLogEvent = z.discriminatedUnion("type", [
  z.object({ t: z.number(), type: z.literal("created"), name: z.string(), arena: ArenaConfig }),
  z.object({ t: z.number(), type: z.literal("join"), name: z.string() }),
  z.object({ t: z.number(), type: z.literal("leave"), name: z.string() }),
  z.object({ t: z.number(), type: z.literal("chat"), name: z.string(), text: z.string() }),
  z.object({ t: z.number(), type: z.literal("closed") }),
]);
export type RoomLogEvent = z.infer<typeof RoomLogEvent>;

// Omit that works on EACH member of a union (plain Omit would flatten the union).
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RoomLogBody = DistributiveOmit<RoomLogEvent, "t">;
