// End-to-end: drive Resonate.handler against the SDK's in-memory LocalNetwork
// (no Postgres). Seed a root promise + acquired task, wrap its id/version in an
// execute message, POST it at the handler, and assert the workflow completes.
import { assertEquals } from "@std/assert";
import { Codec, LocalNetwork, type Send } from "@resonatehq/sdk";
import type { Info } from "@resonatehq/sdk/async";
import { Resonate } from "../src/resonate/mod.ts";

const PID = "test-pid";
const TTL = 60_000;
const VERSION = "1.0.0";
const codec = new Codec();

async function seedTask(send: Send, id: string, func: string, args: any[]) {
  const res = await send({
    kind: "task.create",
    head: { corrId: crypto.randomUUID(), version: VERSION },
    data: {
      pid: PID,
      ttl: TTL,
      action: {
        kind: "promise.create",
        head: { corrId: crypto.randomUUID(), version: VERSION },
        data: {
          id,
          param: codec.encode({ func, args, version: 1 }),
          tags: { "resonate:target": "default" },
          timeoutAt: Date.now() + TTL,
        },
      },
    },
  });
  const task = (res as any).data?.task;
  if (!task) throw new Error(`seed failed: ${(res as any).head?.status}`);
  // Release so the task is pending (the state the server pushes `execute` for);
  // the worker then claims it via onMessage. Bumps version to task.version + 1.
  await send({
    kind: "task.release",
    head: { corrId: crypto.randomUUID(), version: VERSION },
    data: { id: task.id, version: task.version },
  });
  return { id: task.id, version: task.version } as { id: string; version: number };
}

Deno.test("in-memory: handler runs a workflow to completion", async () => {
  const network = new LocalNetwork({ pid: PID, group: "default" });

  const resonate = new Resonate({ pid: PID, send: network.send });
  resonate.register("main", (_info: Info): Promise<number> => Promise.resolve(42));

  const task = await seedTask(network.send, "wf-1", "main", []);

  const res = await resonate.handler(
    new Request("http://fn.local/functions/v1/x", {
      method: "POST",
      body: JSON.stringify({
        kind: "execute",
        head: { corrId: crypto.randomUUID(), version: VERSION },
        data: { task },
      }),
    }),
  );

  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, "completed");
  await network.stop();
});
