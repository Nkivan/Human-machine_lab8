import { Bus } from "@dogfight/shared/bus";
import type { PickupType } from "@dogfight/shared/sim/pickup";

// Everything the game can announce on the client. Audio and the HUD subscribe; nobody imports them.
export interface GameEvents {
  fired: { x: number; y: number };
  hit: { x: number; y: number };
  exploded: { x: number; y: number; kind: "ship" | "asteroid" };
  score: { delta: number; x: number; y: number };
  pickup: { type: PickupType; x: number; y: number };
}
export type GameBus = Bus<GameEvents>;
export const createGameBus = (): GameBus => new Bus<GameEvents>();
