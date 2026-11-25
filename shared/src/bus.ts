type Handlers<E> = { [K in keyof E]?: Set<(payload: E[K]) => void> };

// Typed event bus: the event NAME decides the payload type (K extends keyof E links `name` to E[K]).
// Replaces EventTarget + CustomEvent (whose `detail` is untyped) in the sim, the audio module and the HUD.
export class Bus<E extends { [K in keyof E]: unknown }> {
  readonly #handlers: Handlers<E> = {};

  // Returns an unsubscribe function.
  on<K extends keyof E>(name: K, fn: (payload: E[K]) => void): () => void {
    const set = this.#handlers[name] ?? new Set<(payload: E[K]) => void>();
    this.#handlers[name] = set;
    set.add(fn);
    return () => set.delete(fn);
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    for (const fn of this.#handlers[name] ?? []) fn(payload);
  }
}
