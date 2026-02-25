# @resonatehq/supabase

`@resonatehq/supabase` is the official binding to run [Resonate](https://github.com/resonatehq/resonate) durable execution workers on [Supabase Edge Functions](https://supabase.com/docs/guides/functions). Write long-running, stateful applications on short-lived, stateless serverless infrastructure.

## Installation

This package is published to JSR. Import it in your Supabase Edge Function:

```ts
import { type Context, Resonate } from "jsr:@resonatehq/supabase@0.2.2";
```

No `npm install` needed — Supabase Edge Functions use Deno and resolve JSR imports automatically.

## Usage

Register your functions and call `resonate.httpHandler()` to wire up the Supabase Edge Function request handler:

```ts
import { type Context, Resonate } from "jsr:@resonatehq/supabase@0.2.2";

const resonate = new Resonate();

resonate.register("countdown", function* countdown(ctx: Context, n: number): Generator {
  if (n <= 0) {
    console.log("done");
    return;
  }
  console.log(n);
  yield* ctx.sleep(1000);
  yield* ctx.rpc(countdown, n - 1);
});

// Wire up the Supabase Edge Function handler
resonate.httpHandler();
```

Deploy this as a Supabase Edge Function. The Resonate Server will invoke your function to run and resume durable workflows.

See the [Supabase Edge Functions documentation](https://supabase.com/docs/guides/functions) to learn how to develop and deploy Edge Functions.

## Examples

- [Durable Countdown on Supabase Edge Functions](https://github.com/resonatehq-examples/example-countdown-supabase-ts)
- [Durable Research Agent on Supabase Edge Functions](https://github.com/resonatehq-examples/example-openai-deep-research-agent-supabase-ts)

## Documentation

Full documentation: [docs.resonatehq.io](https://docs.resonatehq.io)
