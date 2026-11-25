declare const brand: unique symbol;

// A branded type: a number the compiler will not confuse with another kind of number, at ZERO runtime cost.
// `declare` is erased, so the brand exists only in the type system.
export type Brand<T, B extends string> = T & { readonly [brand]: B };
export type EntityId = Brand<number, "EntityId">;
export type Tick = Brand<number, "Tick">;
export type Seq = Brand<number, "Seq">;

// These three casts are the ONLY place a plain number is promised to be an id/tick/seq.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- cast #1: a brand is type-only, there is nothing to check at runtime
export const asEntityId = (n: number): EntityId => n as EntityId;
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- cast #2: same reason
export const asTick = (n: number): Tick => n as Tick;
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- cast #3: same reason
export const asSeq = (n: number): Seq => n as Seq;

// On the wire an entity id is 16 bits (the low bits of the server's counter).
export const toWireId = (id: EntityId): EntityId => asEntityId(id & 0xffff);
