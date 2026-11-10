/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Menu de l'application, en français.
 */
const { app, Menu, dialog } = require("electron");
const fs = require("fs");
const path = require("path");

const GUIDE_URL = "https://www.ign.fr/publications-de-l-ign/institut/Publications/Autres_publications/livret-appli-cartes-ign.pdf";
const REPO_URL = "https://github.com/IGNF/cartes-ign-app";

function webBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "build-info.json"), "utf-8"));
  } catch {
    return {};
  }
}

function buildMenu({ getWindow, openExternally }) {
  const isMac = process.platform === "darwin";

  const showAbout = () => {
    const info = webBuildInfo();
    dialog.showMessageBox(getWindow() ?? undefined, {
      type: "info",
      title: "À propos de Cartes IGN",
      message: "Cartes IGN — version desktop",
      detail: [
        `Version de l'appli : ${info.version ?? app.getVersion()}`,
        info.builtAt ? `Build web : ${new Date(info.builtAt).toLocaleString("fr-FR")}` : null,
        `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
        "",
        "Application de l'IGN, sous licence GNU GPLv3.",
      ].filter((l) => l !== null).join("\n"),
      buttons: ["OK"],
    });
  };

  const template = [
    ...(isMac ? [{
      label: "Cartes IGN",
      submenu: [
        { label: "À propos de Cartes IGN", click: showAbout },
        { type: "separator" },
        { role: "services", label: "Services" },
        { type: "separator" },
        { role: "hide", label: "Masquer Cartes IGN" },
        { role: "hideOthers", label: "Masquer les autres" },
        { role: "unhide", label: "Tout afficher" },
        { type: "separator" },
        { role: "quit", label: "Quitter Cartes IGN" },
      ],
    }] : []),
    {
      label: "Fichier",
      submenu: [
        isMac ? { role: "close", label: "Fermer la fenêtre" } : { role: "quit", label: "Quitter" },
      ],
    },
    {
      label: "Édition",
      submenu: [
        { role: "undo", label: "Annuler" },
        { role: "redo", label: "Rétablir" },
        { type: "separator" },
        { role: "cut", label: "Couper" },
        { role: "copy", label: "Copier" },
        { role: "paste", label: "Coller" },
        { role: "selectAll", label: "Tout sélectionner" },
      ],
    },
    {
      label: "Affichage",
      submenu: [
        { role: "reload", label: "Recharger" },
        { role: "forceReload", label: "Forcer le rechargement" },
        { type: "separator" },
        { role: "resetZoom", label: "Taille réelle" },
        { role: "zoomIn", label: "Agrandir le texte" },
        { role: "zoomOut", label: "Réduire le texte" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Plein écran" },
        { type: "separator" },
        { role: "toggleDevTools", label: "Outils de développement" },
      ],
    },
    {
      label: "Fenêtre",
      submenu: [
        { role: "minimize", label: "Réduire" },
        ...(isMac ? [{ role: "zoom", label: "Zoom" }, { role: "front", label: "Tout ramener au premier plan" }] : []),
      ],
    },
    {
      label: "Aide",
      role: "help",
      submenu: [
        { label: "Guide utilisateur", click: () => openExternally(GUIDE_URL) },
        { label: "Code source et signalement de problèmes", click: () => openExternally(REPO_URL) },
        ...(isMac ? [] : [{ type: "separator" }, { label: "À propos de Cartes IGN", click: showAbout }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
