// deno-lint-ignore-file no-console
import { Bot, type Context } from "grammy";
import { DiagLogLevel } from "@opentelemetry/api";
import { openTelemetry, type OpenTelemetryContext, traced } from "./src/mod.ts";

type AppContext = Context & OpenTelemetryContext;

const bot = new Bot<AppContext>("298746736:AAFCUMzjfYa0TWFtRdD7GwkPWtsrNX59pZA");

bot.use(openTelemetry("telegram-bot", { logLevel: DiagLogLevel.ERROR }));

bot.command("start", (ctx) => {
  return ctx.telemetry.trace(
    "command.start",
    { ["user.id"]: ctx.from?.id },
    async (span) => {
      span.addEvent("command.start.handle");
      await ctx.reply("Hello! I'm a bot!");
      await ctx.reply("I can help you with a lot of things!");
    },
  );
});

bot.command(
  "ping",
  traced("command.ping", async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await ctx.reply("Pong!");
  }),
);

bot.start({
  onStart: ({ username }) => {
    console.log(`Listening as @${username}`);
  },
});
