/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Processus principal Electron de Cartes IGN desktop.
 *
 * L'appli web (build webpack de ../www, copiée dans app/www) est servie via un
 * protocole privilégié `app://cartes-ign/`, ce qui lui donne une origine stable
 * et sécurisée : IndexedDB (cartes hors ligne), localStorage (préférences
 * Capacitor en mode web), fetch() des fichiers locaux et workers MapLibre
 * fonctionnent comme dans un navigateur.
 */
const { app, BrowserWindow, protocol, shell, session, nativeTheme, ipcMain, clipboard } = require("electron");
const path = require("path");

const { registerAppProtocol, APP_SCHEME, APP_HOST } = require("./src/app-protocol");
const { buildMenu } = require("./src/menu");
const windowState = require("./src/window-state");

const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const WEB_ROOT = path.join(__dirname, "app", "www");

// Doit être appelé avant `ready`
protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}]);

// Une seule instance : un second lancement remet la fenêtre existante au premier plan
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName("Cartes IGN");
if (process.platform === "win32") {
  app.setAppUserModelId("fr.ign.geoportail.desktop");
}

let mainWindow = null;

// Permissions accordées à l'appli (tout le reste est refusé)
const ALLOWED_PERMISSIONS = new Set([
  "geolocation",
  "notifications",
  "clipboard-sanitized-write",
  "clipboard-read",
  "fullscreen",
]);

function isAppUrl(url) {
  return url.startsWith(`${APP_ORIGIN}/`) || url === APP_ORIGIN;
}

function openExternally(url) {
  try {
    const { protocol: scheme } = new URL(url);
    if (["https:", "http:", "mailto:", "tel:"].includes(scheme)) {
      shell.openExternal(url);
    }
  } catch {
    // URL invalide : on ignore
  }
}

function setupSession() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl || APP_ORIGIN));
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && (!requestingOrigin || requestingOrigin.startsWith(APP_ORIGIN));
  });

  // Identifie l'appli auprès des services (sur le modèle de IGN-app-android / IGN-app-ios)
  ses.setUserAgent(`${ses.getUserAgent()} IGN-app-desktop/${app.getVersion()}`);
}

function createWindow() {
  const state = windowState.load();

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 360,
    minHeight: 560,
    title: "Cartes IGN",
    icon: path.join(__dirname, "build", "icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff",
    show: false,
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  if (state.isMaximized) {
    mainWindow.maximize();
  }
  windowState.track(mainWindow);

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Garder un titre de fenêtre court
  mainWindow.on("page-title-updated", (event) => event.preventDefault());

  // Liens externes (target=_blank, window.open) → navigateur par défaut
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) {
      openExternally(url);
    }
    return { action: "deny" };
  });

  // Toute navigation hors de l'appli part dans le navigateur par défaut
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      openExternally(url);
    }
  });

  mainWindow.webContents.session.setSpellCheckerLanguages(["fr"]);

  // Charger la racine (et non /index.html) : l'appli construit certaines URL
  // de styles (sprites) en concaténant document.URL, comme sous Capacitor.
  mainWindow.loadURL(`${APP_ORIGIN}/`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Repli de navigator.share (voir preload.js) : copie dans le presse-papiers
ipcMain.handle("cartes-ign:share", (event, { title, text, url } = {}) => {
  if (!isAppUrl(event.senderFrame?.url ?? "")) return false;
  const content = [text || title, url].filter(Boolean).join("\n");
  if (content) clipboard.writeText(content);
  return Boolean(content);
});

app.whenReady().then(() => {
  registerAppProtocol(protocol, WEB_ROOT);
  setupSession();
  buildMenu({ getWindow: () => mainWindow, openExternally });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
