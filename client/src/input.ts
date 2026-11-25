export interface Keyboard {
  isDown(code: string): boolean;
  justPressed(code: string): boolean; // edge-triggered
  endStep(): void; // call after EVERY simulation step, so one press is seen by exactly one step
}

// Closure-based keyboard: `down` and `pressed` are private, the returned object is the API.
export function createKeyboard(target: Window): Keyboard {
  const down = new Set<string>();
  const pressed = new Set<string>();

  target.addEventListener("keydown", (e) => {
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
    if (!e.repeat && !down.has(e.code)) pressed.add(e.code);
    down.add(e.code);
  });
  target.addEventListener("keyup", (e) => down.delete(e.code));
  target.addEventListener("blur", () => down.clear()); // don't get stuck keys

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    endStep: () => pressed.clear(),
  };
}
