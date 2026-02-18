# @resonatehq/supabase

# Example
Setup your Supabse Edge Functions: [docs](https://supabase.com/docs/guides/functions)


```ts
import { type Context, Resonate } from "jsr:@resonatehq/supabase@0.2.2";

const resonate = new Resonate();

resonate.register("foo", function* (ctx, count: number, delay: number) {
  yield* ctx.run(() => console.log("hello world", count, delay));
  let i = 0;
  while (i < count) {
    i = yield* ctx.rpc(bar, "say hi", i, delay);
    yield* ctx.sleep(delay * 60 * 1000);
  }
  return "done";
});

function bar(_ctx: Context, msg: string, count: number, delay: number) {
  console.log("running bar");
  console.log({ msg, count, delay });
  return count + 1;
}

resonate.register("bar", bar);

resonate.httpHandler();
```
