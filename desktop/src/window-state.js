/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Mémorise la taille et la position de la fenêtre entre deux lancements.
 */
const { app, screen } = require("electron");
const fs = require("fs");
const path = require("path");

const DEFAULTS = { width: 1280, height: 800, isMaximized: false };

function stateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function isVisibleOnSomeDisplay(bounds) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width && bounds.x + bounds.width > a.x &&
    bounds.y < a.y + a.height && bounds.y + bounds.height > a.y
  );
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), "utf-8"));
    const state = { ...DEFAULTS, ...saved };
    if (typeof state.x === "number" && typeof state.y === "number" && !isVisibleOnSomeDisplay(state)) {
      delete state.x;
      delete state.y;
    }
    return state;
  } catch {
    return { ...DEFAULTS };
  }
}

function track(win) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const state = { ...win.getNormalBounds(), isMaximized: win.isMaximized() };
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify(state));
    } catch {
      // non bloquant
    }
  };
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on("resize", debounced);
  win.on("move", debounced);
  win.on("close", save);
}

module.exports = { load, track };
