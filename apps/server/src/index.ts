import { createConductorServer } from "./server.js";

const { start } = createConductorServer({
  port: Number(process.env.PORT) || 3001,
});

start();
