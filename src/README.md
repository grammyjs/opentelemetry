# grammY OpenTelemetry

Integrates OpenTelemetry into grammY.

Development is in progress.

## Description

After a lot of thought and research, we came to the conclusion that it would be bad to integrate with a particular
technology, especially if it is possible to support many at once. Fortunately, there is the OpenTelemetry project, which
defines a single approach to collecting and managing telemetry that integrates perfectly with many existing services.
However, there are some problems with it:

1. The JS toolkit is quite young, so many things are experimental or just under development, which makes it difficult to
   use.
2. They split the Web and Node.js tools into separate packages, which will cause support issues in the future.
3. They are very fond of autoinstrumentation, which intercepts `require/import` calls and patches the requested package,
   which we think is a very, very bad pattern that we don't want to impose on grammY users.

This plugin allows you to use OpenTelemetry without those caveats.

## Setup

```ts
import { Bot, type Context } from "https://deno.land/x/grammy/mod.ts";
import { openTelemetry, type OpenTelemetryContext, traced } from "https://deno.land/x/grammyjs_opentelemetry/mod.ts";

const bot = new Bot<Context & OpenTelemetryContext>("token");
bot.use(openTelemetry("my-bot"));
```

To use a custom tracer:

```ts
bot.use(openTelemetry("my-bot", { tracer: customTracer }));
```

## Events

`event()` emits an OpenTelemetry Log Event with the given name and attributes through the OTel Logs signal:

```ts
bot.command("start", (ctx) => {
  ctx.telemetry.event("command.start", { "user.id": ctx.from?.id });
});
```

## Traces

Run work inside a child span of the current update:

```ts
bot.command("start", async (ctx) => {
  await ctx.telemetry.trace(
    "command.start",
    { command: "start" },
    async (span) => {
      span.addEvent("command.start.handle");
      await ctx.reply("Hello! I'm a bot!");
    },
  );
});
```

`traced()` provides the same lifecycle as grammY middleware:

```ts
bot.command(
  "start",
  traced(
    "command.start",
    { command: "start" },
    async (ctx, span) => {
      span.addEvent("command.start.handle");
      await ctx.reply("Hello! I'm a bot!");
    },
  ),
);
```

## Manual spans

Custom spans can be added manually:

```ts
bot.command("finish", async (ctx) => {
  const span = ctx.telemetry.start("command.finish", { success: true });
  try {
    span.setAttribute("telegram.chat.id", ctx.chat.id);
    await ctx.reply("Finished!");
  } finally {
    span.end();
  }
});
```

> [!NOTE]
> `start()` returns a `DisposableSpan`. It supports `using`, which ends the span automatically when execution leaves its
> scope:
>
> ```ts
> using span = ctx.telemetry.start("command.finish", { success: true });
> ```
