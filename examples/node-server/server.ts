/**
 * A server that evaluates flags locally with @latch/node, and hands the browser what it needs:
 * the first flag values (bootstrap) and a signed context for the user.
 *
 *   LATCH_SERVER_KEY=srv-… LATCH_SIGNING_SECRET=lsig_… node --experimental-strip-types server.ts
 */
import { createServer } from "node:http";
import { createClient } from "@latch/node";

const latch = createClient({
  serverKey: process.env["LATCH_SERVER_KEY"] ?? "",
  baseUrl: process.env["LATCH_EDGE_URL"] ?? "https://latch-edge-dev.inkress.com",
  onError: (error) => {
    console.warn("latch:", error.message);
  },
});
latch.onChange((event) => {
  console.log(`ruleset ${String(event.previousVersion)} -> ${String(event.version)}`);
});
await latch.waitForReady();

createServer((request, response) => {
  void (async () => {
    const user = { targetingKey: "user-42", plan: "pro", country: "JM" };
    // Evaluated here, in-process: no network call per check.
    const newCheckout = await latch.boolVariation("new-checkout", user, false);
    const signed = latch.signContext(process.env["LATCH_SIGNING_SECRET"] ?? "", user, { ttlSeconds: 3600 });
    const bootstrap = await latch.bootstrap(user);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ path: request.url, newCheckout, signedContext: signed, bootstrap }));
  })();
}).listen(3000);
