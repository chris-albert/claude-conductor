import { createConductorServer } from "./server.js";

// Keep the server alive when async code rejects without a catch handler.
// Node 22's default for unhandled rejections is to terminate the process,
// which makes a single bad command (e.g. an SDK error in the auto-fix loop)
// kill the whole conductor server. Log loudly instead.
process.on("unhandledRejection", (reason, promise) => {
  console.error("[conductor] unhandledRejection:", reason);
  void promise;
});
process.on("uncaughtException", (err) => {
  console.error("[conductor] uncaughtException:", err);
});

const { start } = createConductorServer({
  port: Number(process.env.PORT) || 3001,
});

start();
