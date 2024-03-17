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

## Usage

```ts
import { Bot, Context } from "https://deno.land/x/grammy/mod.ts";
import { getHttpTracer, openTelemetryTransformer } from "https://deno.land/x/grammyjs_opentelemetry/mod.ts";

const bot = new Bot<Context>("token");

bot.api.config.use(openTelemetryTransformer(getHttpTracer("my-bot")));

bot.command("start", (ctx) => {
  // Creates a new span tied to the span of the current update.
  return ctx.openTelemetry.trace(
    // span name
    "command.start",
    // span attributes
    { ["user.id"]: ctx.from?.id },
    // span actions
    async (span) => {
      span.addEvent("command.start.handle");
      await ctx.reply("Hello! I'm a bot!");
      await ctx.reply("I can help you with a lot of things!");
    },
  );
});

bot.command(
  "ping",
  // Wraps the handler in a span with the given name, tied to the span of the current update.
  // Shortcut for `ctx.openTelemetry.trace("command.ping", ...)`.
  traced("command.ping", async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await ctx.reply("Pong!");
  }),
);

bot.start();
```
