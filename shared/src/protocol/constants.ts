// Protocol v2. Control messages are JSON text frames; the hot path (inputs, snapshots, ping/pong) is binary.
export const PROTOCOL_VERSION = 2;
export const TICK_RATE = 30; // server ticks AND client simulation steps per second
export const STEP = 1 / TICK_RATE; // fixed dt, identical on both sides: this is what makes prediction exact
export const TICK_MS = 1000 / TICK_RATE;

export const MSG = { INPUT: 1, SNAPSHOT: 2, PING: 3, PONG: 4 } as const; // low nibble of the first byte of a binary frame
export type MsgType = (typeof MSG)[keyof typeof MSG];
export const MAX_INPUTS_PER_PACKET = 5;
