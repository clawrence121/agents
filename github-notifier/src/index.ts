import type { Env } from "./types";
import { runAgent } from "./agent";

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ) {
    ctx.waitUntil(
      runAgent(env).then((result) => {
        console.log("Agent completed:", JSON.stringify(result));
      }).catch((err) => {
        console.error("Agent failed:", err);
      })
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/trigger") {
      ctx.waitUntil(
        runAgent(env).then((result) => {
          console.log("Manual trigger completed:", JSON.stringify(result));
        }).catch((err) => {
          console.error("Manual trigger failed:", err);
        })
      );
      return new Response("Agent triggered. Check logs and #chris-alerts.\n");
    }

    return new Response("GitHub Notifier Worker\nPOST /trigger to run manually\n");
  },
} satisfies ExportedHandler<Env>;
