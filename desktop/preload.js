/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Preload :
 * - expose un objet minimal `window.cartesIgnDesktop` pour que le code web puisse
 *   détecter la version desktop (Capacitor.getPlatform() y vaut "web"). C'est le
 *   point d'accroche prévu pour les fonctionnalités propres au desktop ;
 * - fournit un `navigator.share` de repli (Electron n'en a pas) : le contenu
 *   partagé est copié dans le presse-papiers, avec un message de confirmation.
 */
const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("cartesIgnDesktop", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  share: (data) => ipcRenderer.invoke("cartes-ign:share", {
    title: typeof data?.title === "string" ? data.title : undefined,
    text: typeof data?.text === "string" ? data.text : undefined,
    url: typeof data?.url === "string" ? data.url : undefined,
  }),
});

// Exécuté dans le monde de la page, avant les scripts de l'appli
webFrame.executeJavaScript(`(() => {
  if (typeof navigator.share === "function") return;
  const toast = (message) => {
    const el = document.createElement("div");
    el.textContent = message;
    el.setAttribute("role", "status");
    el.style.cssText = "position:fixed;left:50%;bottom:32px;transform:translateX(-50%);" +
      "background:#3F4A55;color:#fff;padding:10px 18px;border-radius:8px;font:13px 'Open Sans Semibold',sans-serif;" +
      "z-index:2147483647;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none;transition:opacity .3s";
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; }, 2200);
    setTimeout(() => el.remove(), 2600);
  };
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async (data) => {
      await window.cartesIgnDesktop.share(data || {});
      toast("Copié dans le presse-papiers");
    },
  });
  Object.defineProperty(navigator, "canShare", {
    configurable: true,
    value: (data) => !data || !data.files || data.files.length === 0,
  });
})();`);
