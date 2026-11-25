// tsx tools/gen-log.ts 200 logs/big.ndjson  -> synthetic NDJSON log of ~200 MB (stream-based, honors backpressure)
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const mb = Number(process.argv[2] ?? 200);
const file = process.argv[3] ?? "logs/big.ndjson";
mkdirSync(path.dirname(file), { recursive: true });

function* lines(): Generator<string> {
  let bytes = 0;
  for (let i = 0; bytes < mb * 1024 * 1024; i++) {
    const line = JSON.stringify({ t: i, type: "chat", name: `p${i % 4}`, text: "x".repeat(80 + (i % 40)) }) + "\n";
    bytes += line.length;
    yield line;
  }
}
await pipeline(Readable.from(lines()), createWriteStream(file));
console.log(`wrote ${file}`);
