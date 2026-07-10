// Handler validation branches — no Postgres/env needed: these return before
// SupabaseNetwork is ever constructed.
import { assertEquals } from "@std/assert";
import { Resonate } from "../src/resonate/mod.ts";

const post = (body: unknown) =>
  new Request("http://fn.local/functions/v1/x", {
    method: "POST",
    body: JSON.stringify(body),
  });

Deno.test("rejects non-POST", async () => {
  const res = await new Resonate().handler(
    new Request("http://fn.local", { method: "GET" }),
  );
  assertEquals(res.status, 405);
});

Deno.test("rejects non-execute message", async () => {
  const res = await new Resonate().handler(post({ kind: "nope" }));
  assertEquals(res.status, 400);
});
