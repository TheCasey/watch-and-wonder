const { app, BrowserWindow, dialog, shell, Menu } = require("electron");
const path = require("node:path");
const os = require("node:os");
let window,
  service,
  shuttingDown = false;
app.setName("Watch & Wonder");
app.setPath("userData", path.join(app.getPath("appData"), "Watch & Wonder"));
const allowedExternal = (value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["auth.openai.com", "chatgpt.com", "github.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
};
function external(value) {
  if (allowedExternal(value)) shell.openExternal(value);
}
async function launch() {
  process.env.PATH = [
    ...new Set(
      [
        process.env.PATH,
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ].filter(Boolean),
    ),
  ].join(path.delimiter);
  if (!app.isPackaged) {
    try {
      process.loadEnvFile(path.join(__dirname, "..", ".env"));
    } catch {}
  }
  const { startService } = await import("../server/app.js");
  const { createWhisper } = await import("../server/whisper.js");
  const modelPath = app.isPackaged
    ? path.join(process.resourcesPath, "models", "ggml-base.en.bin")
    : path.join(__dirname, "..", "models", "ggml-base.en.bin");
  service = await startService({
    port: 0,
    dataDir:
      process.env.WATCH_WONDER_DATA_DIR ||
      path.join(app.getPath("userData"), "data"),
    whisper: createWhisper({
      modelPath: process.env.WHISPER_MODEL_PATH || modelPath,
    }),
  });
  window = new BrowserWindow({
    width: 1380,
    height: 940,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: "#f6f6ee",
    title: "Watch & Wonder",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(service.url + "/")) {
      event.preventDefault();
      external(url);
    }
  });
  window.on("close", (event) => {
    if (service?.library.busy() && !shuttingDown) {
      const response = dialog.showMessageBoxSync(window, {
        type: "question",
        buttons: ["Keep working", "Quit and resume later"],
        defaultId: 0,
        cancelId: 0,
        message: "A lesson is still processing.",
        detail:
          "Saved progress will be kept. An interrupted download or transcription will need to restart.",
      });
      if (response === 0) event.preventDefault();
    }
  });
  await window.loadURL(service.url);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Watch & Wonder",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(launch)
    .catch((error) => {
      dialog.showErrorBox("Watch & Wonder could not start", error.message);
      app.quit();
    });
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (shuttingDown || !service) return;
  event.preventDefault();
  if (service.library.busy() && window && !window.isDestroyed()) {
    window.close();
    if (!window.isDestroyed()) return;
  }
  shuttingDown = true;
  service.close().finally(() => app.quit());
});
