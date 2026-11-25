import { simHash } from "@dogfight/shared/sim/selftest";

// Open the game with ?hash=1 and compare the console line with `npm run hash -w shared` in Node.
export const simHashNote = (): string => `simHash(1000) = ${simHash(1000)}  (must equal the Node value)`;
