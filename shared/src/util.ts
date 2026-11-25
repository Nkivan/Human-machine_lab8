// Put in the `default:` of every switch over a union: if a member is added and not handled, the call stops compiling.
export function assertNever(x: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}

export type Result<T, E = string> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E = string>(error: E): Result<never, E> => ({ ok: false, error });
