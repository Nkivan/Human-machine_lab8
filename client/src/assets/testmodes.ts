import type { Manifest } from "./loader.ts";

// ?test=<mode> injects broken assets so you can screenshot the failure gallery. Needs the dev server (vite.config.ts).
export function applyTestMode(manifest: Manifest, mode: string | null): Manifest {
  const json = { ...manifest.json };
  const sounds = { ...manifest.sounds };
  switch (mode) {
    case "404-sound":
      sounds["ghost"] = { url: "/test/status/404", optional: true };
      break; // graceful
    case "404-required":
      json["ghost"] = { url: "/test/status/404" };
      break; // retry screen
    case "slow":
      for (let i = 1; i <= 3; i++) json[`slow${i}`] = { url: `/test/slow?ms=3000&n=${i}` };
      break;
    case "flaky":
      json["flaky"] = { url: `/test/flaky?run=${Date.now()}` };
      break; // 503, 503, 200
    case "corrupt":
      json["corrupt"] = { url: "/test/corrupt" };
      break; // SyntaxError
    case "timeout":
      json["hang"] = { url: "/test/slow?ms=60000" };
      break; // 5 s request timeout
    case "abort":
      json["slow"] = { url: "/test/slow?ms=3000" };
      break; // main.ts aborts at 600 ms
    default:
      break;
  }
  return { ...manifest, json, sounds };
}
