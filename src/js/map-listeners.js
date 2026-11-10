/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

import * as maplibregl from "maplibre-gl";

import DOM from "./dom";
import Globals from "./globals";
import Location from "./services/location";

/**
 * Ecouteurs sur la carte
 */
const addListeners = () => {
  const map = Globals.map;

  // Rotation ou tilt de la carte avec le mutlitouch
  const compassListener = () => {
    DOM.$compassBtn.style.transform = "rotate(" + (map.getBearing() * -1) + "deg)";
    if (map.getBearing() !== 0 || map.getPitch() !== 0) {
      DOM.$compassBtn.classList.remove("d-none");
    } else {
      DOM.$compassBtn.classList.add("d-none");
    }
  };
  map.on("rotate", compassListener);
  map.on("pitch", compassListener);

  // Désactivation du tracking au déplacement non programmatique de la carte
  map.on("dragstart", () => {
    Location.disableTracking();
  });

  /*
   * Clic long (ou clic droit à la souris) : ouvre le panneau d'exploration du lieu ("contexte")
   * - écran tactile : appui long (l'event contextmenu n'est pas enclenché par clic long sur la carte...
   *   https://github.com/maplibre/maplibre-gl-js/issues/373 — HACK https://stackoverflow.com/questions/43459539/mapbox-gl-js-long-tap-press)
   * - souris : bouton gauche maintenu, ou clic droit
   * Le clic qui suit un appui long à la souris est neutralisé, pour ne pas déclencher en plus l'action du clic court.
   */
  const LONG_PRESS_DELAY = 500;
  const MOUSE_MOVE_TOLERANCE = 6; // px
  let contextMenuTimeout = null;
  let lastTouchTime = 0;
  let suppressNextClick = false;
  const clearContextMenuTimeout = () => { clearTimeout(contextMenuTimeout); };

  // Repère placé uniquement en mode défaut, position, informations, couches ou filtres POI, hors plein écran
  const canOpenContextMenu = () => {
    if (DOM.$fullScreenBtn.querySelector("button").classList.contains("maplibregl-ctrl-shrink")) {
      return false;
    }
    return Globals.backButtonState === "default" ||
      Globals.backButtonState.split("-")[0].split("%")[0] === "position" ||
      Globals.backButtonState === "informations" ||
      Globals.backButtonState === "layerManager" ||
      Globals.backButtonState === "poi";
  };

  const openContextMenu = (lngLat) => {
    if (Globals.backButtonState.split("-")[0].split("%")[0] === "position") {
      Globals.menu.close("position");
    }
    Globals.position.compute({ lngLat: lngLat, type: "context" }).then(() => {
      Globals.menu.open("position%contexte");
    });
    if (Globals.searchResultMarker) {
      Globals.searchResultMarker.remove();
    }
    Globals.searchResultMarker = new maplibregl.Marker({element: Globals.searchResultIcon, anchor: "bottom"})
      .setLngLat(lngLat)
      .addTo(Globals.map);
  };

  // Écran tactile
  map.on("touchstart", (evt) => {
    lastTouchTime = Date.now();
    if (evt.originalEvent.touches.length > 1) {
      return;
    }
    if (!canOpenContextMenu()) {
      return;
    }
    contextMenuTimeout = setTimeout(() => openContextMenu(evt.lngLat), LONG_PRESS_DELAY);
  });
  map.on("touchend", clearContextMenuTimeout);
  map.on("touchcancel", clearContextMenuTimeout);
  map.on("touchmove", clearContextMenuTimeout);
  map.on("moveend", clearContextMenuTimeout);
  map.on("gesturestart", clearContextMenuTimeout);
  map.on("gesturechange", clearContextMenuTimeout);
  map.on("gestureend", clearContextMenuTimeout);

  // Souris : bouton gauche maintenu
  let mouseDownPoint = null;
  map.on("mousedown", (evt) => {
    // les events souris émulés après un toucher sont ignorés
    if (evt.originalEvent.button !== 0 || Date.now() - lastTouchTime < 1000) {
      return;
    }
    clearContextMenuTimeout();
    if (!canOpenContextMenu()) {
      return;
    }
    mouseDownPoint = evt.point;
    contextMenuTimeout = setTimeout(() => {
      mouseDownPoint = null;
      suppressNextClick = true;
      openContextMenu(evt.lngLat);
    }, LONG_PRESS_DELAY);
  });
  map.on("mousemove", (evt) => {
    if (mouseDownPoint && mouseDownPoint.dist(evt.point) > MOUSE_MOVE_TOLERANCE) {
      mouseDownPoint = null;
      clearContextMenuTimeout();
    }
  });
  map.on("mouseup", () => {
    mouseDownPoint = null;
    clearContextMenuTimeout();
  });
  map.on("dragstart", () => {
    mouseDownPoint = null;
    clearContextMenuTimeout();
  });
  // Neutralise le clic qui termine un appui long (phase de capture, avant les écouteurs de MapLibre)
  map.getContainer().addEventListener("click", (evt) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      evt.stopPropagation();
      evt.preventDefault();
    }
  }, true);
  // Un nouvel appui annule une neutralisation restée en attente (ex. : bouton relâché hors de la carte)
  let rightDownPoint = null;
  map.getContainer().addEventListener("mousedown", (evt) => {
    suppressNextClick = false;
    if (evt.button === 2) {
      rightDownPoint = { x: evt.clientX, y: evt.clientY };
    }
  }, true);

  // Souris : clic droit (sans glisser, le glisser-droit sert à faire pivoter la carte)
  map.on("contextmenu", (evt) => {
    evt.preventDefault();
    if (Date.now() - lastTouchTime < 1000) {
      return;
    }
    const e = evt.originalEvent;
    if (rightDownPoint && Math.hypot(e.clientX - rightDownPoint.x, e.clientY - rightDownPoint.y) > MOUSE_MOVE_TOLERANCE) {
      return;
    }
    clearContextMenuTimeout();
    if (!canOpenContextMenu()) {
      return;
    }
    openContextMenu(evt.lngLat);
  });

  // map.on("data", (e) => {
  //   if (!e.isSourceLoaded)  {
  //     return;
  //   }
  //   if (!e.tile) {
  //     return;
  //   }
  //   console.debug("data", e);
  // });
};

export default {
  addListeners
};
