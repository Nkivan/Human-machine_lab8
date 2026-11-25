import { defineConfig } from "vite";

// Dev-only endpoints to test failures (they do not exist in `vite preview` / production):
//   /test/slow?ms=3000     -> JSON after a delay
//   /test/flaky?run=ID     -> 503 twice, then 200 (per run id)
//   /test/corrupt          -> invalid JSON
//   /test/status/404       -> a REAL 404 (Vite's SPA fallback would otherwise return index.html)
const flakyCalls = new Map<string, number>();

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? "v1.0.0") },
  build: { target: "es2022" }, // main.ts uses top-level await; Vite 6 defaults to older browsers
  // Dev: the Vite server proxies the API and the WebSocket to the Node server (prod: Node serves dist/ itself).
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/ws": { target: "http://127.0.0.1:3000", ws: true },
    },
  },
  plugins: [
    {
      name: "dev-test-endpoints",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://localhost");
          const send = (status: number, body: string): void => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(body);
          };
          if (url.pathname === "/test/slow") {
            setTimeout(() => send(200, '{"ok":true}'), Number(url.searchParams.get("ms") ?? 3000));
          } else if (url.pathname === "/test/flaky") {
            const id = url.searchParams.get("run") ?? "default";
            const n = (flakyCalls.get(id) ?? 0) + 1;
            flakyCalls.set(id, n);
            if (n < 3) send(503, '{"error":"busy"}');
            else send(200, '{"ok":true}');
          } else if (url.pathname === "/test/corrupt") {
            send(200, "{not valid json");
          } else if (url.pathname.startsWith("/test/status/")) {
            send(Number(url.pathname.split("/").pop()), '{"error":"test"}');
          } else next();
        });
      },
    },
  ],
});
