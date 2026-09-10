// Declared rather than imported: `Bun` has no types in this app's tsconfig, and
// the fixture is run with `bun`, never bundled by Next.
import { page } from "./serve";
declare const Bun: { serve(options: { port: number; hostname: string; fetch: () => Response }): { port: number } };

/** Serves the fixture on an ephemeral loopback port. Ctrl-C to stop. */
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } }) });
console.log(`http://127.0.0.1:${server.port}`);
