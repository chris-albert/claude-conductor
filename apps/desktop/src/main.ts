import { app, BrowserWindow, dialog } from "electron";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { createConductorServer } from "@claude-conductor/server";

let mainWindow: BrowserWindow | null = null;
let serverPort: number | null = null;

function getWebDistPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "web");
  }
  // Development: use the built web app
  return join(import.meta.dirname, "../../web/dist");
}

function checkClaudeCli(): { available: boolean; authenticated: boolean } {
  try {
    execSync("claude --version", { stdio: "pipe" });
  } catch {
    return { available: false, authenticated: false };
  }
  try {
    const output = execSync("claude auth status", {
      encoding: "utf-8",
      stdio: "pipe",
    });
    const loggedIn =
      output.includes('"loggedIn": true') ||
      output.includes("Logged in");
    return { available: true, authenticated: loggedIn };
  } catch (e) {
    // auth status exits non-zero when not logged in, but still outputs JSON
    const stderr = (e as { stderr?: string }).stderr ?? "";
    return {
      available: true,
      authenticated: stderr.includes('"loggedIn": true'),
    };
  }
}

async function createWindow(port: number) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Claude Conductor",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: "#12121a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(import.meta.dirname, "preload.js"),
    },
  });

  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Check if Claude CLI is available
  const cli = checkClaudeCli();

  if (!cli.available) {
    const result = await dialog.showMessageBox({
      type: "warning",
      title: "Claude Code Not Found",
      message: "Claude Code CLI is required but was not found on your PATH.",
      detail:
        "Install it with:\n\n  npm install -g @anthropic-ai/claude-code\n\nThen restart the app.",
      buttons: ["Quit", "Continue Anyway"],
      defaultId: 0,
    });
    if (result.response === 0) {
      app.quit();
      return;
    }
  } else if (!cli.authenticated) {
    await dialog.showMessageBox({
      type: "info",
      title: "Not Logged In",
      message: "Claude Code is installed but not authenticated.",
      detail:
        "You can log in via the app's API key screen, or run this in your terminal:\n\n  claude auth login",
      buttons: ["OK"],
    });
  }

  // Start the embedded server
  const webDist = getWebDistPath();
  const projectRoot = process.argv[2] || homedir();
  const { start } = createConductorServer({
    projectRoot,
    staticDir: webDist,
    port: 0, // OS-assigned ephemeral port
  });

  const { port } = await start();
  serverPort = port;
  console.log(`Electron: server running on port ${port}`);

  await createWindow(port);
});

// macOS: re-create window when dock icon is clicked
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort !== null) {
    createWindow(serverPort);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
