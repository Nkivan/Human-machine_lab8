// npm run hash -w shared  -> compare with the browser: open the game with ?hash=1 and read the console.
import { simHash } from "../src/sim/selftest.ts";

console.log(`simHash(1000) = ${simHash(1000)}`);
