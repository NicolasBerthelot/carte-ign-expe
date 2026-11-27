/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Territoire survolé : volet replié en bas de la carte qui affiche en continu le territoire au centre
 * de la carte (commune, ou forêt domaniale / parc national / parc naturel régional quand on s'y trouve).
 * Un appui ou un glissement vers le haut ouvre le volet « Mon territoire » (espace de découverte).
 *
 * Maquette : prototype Lovable « Cartes IGN — Prototype iPhone » (volet replié de l'Explorer).
 *
 * Latence et requêtes (voir aussi territory-zones.js) :
 * - pendant le déplacement, le territoire est recalculé sur l'appareil (au plus toutes les 100 ms) ;
 *   aucune requête tant que la carte reste dans des dalles déjà chargées ;
 * - une dalle inconnue n'est demandée que si la carte s'y arrête (ou y ralentit 250 ms) : un survol
 *   rapide de la France ne déclenche pas une requête par commune traversée ;
 * - une seule dalle en cours de chargement à la fois ; si la carte est partie ailleurs entre-temps,
 *   seule la dernière dalle demandée est chargée ensuite ;
 * - pendant le chargement, le territoire précédent reste affiché (grisé) plutôt qu'un volet vide ;
 * - la météo n'est demandée qu'une fois la carte immobile depuis 600 ms, et gardée 15 min pour une
 *   maille de 0,1° (≈ 10 km) : passer d'une commune à sa voisine ne la redemande pas ;
 * - rien du contenu de l'espace de découverte n'est préchargé pendant le survol : son chargement
 *   démarre au premier contact avec le volet (pointerdown), avant même l'ouverture, et le volet
 *   s'ouvre avec le nom, la commune et la météo déjà connus.
 */
import Globals from "../globals";
import Location from "../services/location";
import TerritoryData, { distanceMeters } from "./territory-data";
import ZoneIndex, { departementLabel, tileKey } from "./territory-zones";
import icon from "./territory-icons";

/** Zoom minimal pour afficher un territoire (comme la maquette) */
export const MIN_ZOOM = 8;
/** En dessous : « IGN couvre la France » */
const FRANCE_ZOOM = 5;
/** Délai avant de charger une dalle survolée pendant un déplacement */
const SETTLE_DELAY = 250;
/** Délai d'attente des forêts domaniales avant d'afficher la commune seule */
const HEAVY_GRACE = 300;
/** Délai avant de griser l'affichage pendant un chargement (évite un clignotement) */
const STALE_DELAY = 150;
const WEATHER_DELAY = 600;
const WEATHER_TTL = 15 * 60 * 1000;
const MOVE_INTERVAL = 100;

/** Emprises grossières de la France (métropole et outre-mer) : [ouest, sud, est, nord] */
const FRANCE_BOXES = [
  [-5.6, 41.2, 9.8, 51.2],
  [-61.9, 15.8, -61, 16.6], [-63.2, 17.8, -62.7, 18.2], [-61.3, 14.3, -60.7, 14.95],
  [-54.7, 2, -51.5, 5.9], [55.1, -21.5, 55.9, -20.8], [45, -13.1, 45.4, -12.5], [-56.6, 46.7, -56, 47.2],
];

const MESSAGES = {
  far: "Vous êtes trop éloigné, IGN couvre la France",
  zoom: "Vous êtes trop éloigné, zoomez pour découvrir",
  none: "Pas de territoire à découvrir ici",
  error: "Les informations de cette zone sont indisponibles",
};

export function inFranceBoxes(lng, lat) {
  return FRANCE_BOXES.some(([w, s, e, n]) => lng >= w && lng <= e && lat >= s && lat <= n);
}

/** Texte affiché pour un territoire */
export function peekTexts({ commune, zone }) {
  if (!commune && !zone) {
    return null;
  }
  const dep = departementLabel(commune?.codeDepartement);
  if (!zone) {
    return { title: commune.name, subtitle: dep, kicker: "" };
  }
  // précision utile seulement si le nom ne la contient pas déjà (« Forêt domaniale de … »)
  const kickers = { "parc-national": "Cœur du parc", "parc-national-adhesion": "Aire d'adhésion" };
  const kicker = kickers[zone.type] || "";
  const place = commune ? `${commune.name}${commune.codeDepartement ? ` (${commune.codeDepartement})` : ""}` : "";
  const subtitle = kicker ? [kicker, place].filter(Boolean).join(" · ") : [commune?.name, dep].filter(Boolean).join(" · ");
  return { title: zone.name, subtitle, kicker: zone.kicker || "" };
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class TerritoryPeek {
  /**
   * @param {maplibregl.Map} map
   * @param {Object} [options]
   * @param {ZoneIndex} [options.index]
   */
  constructor(map, { index = new ZoneIndex() } = {}) {
    this.map = map;
    this.index = index;
    this.el = document.getElementById("territoryPeek");
    this.openBtn = document.getElementById("territoryPeekOpen");
    this.closeBtn = document.getElementById("territoryPeekClose");
    this.body = this.el.querySelector(".territoryPeekBody");

    this.enabled = true;
    this.mode = null; // "zone" | "loading" | "far" | "zoom" | "none" | "error"
    this.result = null; // { commune, zone, communeId, lat, lng }
    this.renderedKey = "";
    this.weather = new Map(); // maille de 0,1° → { value, at }
    this.weatherInFlight = null;
    this.loadingKey = null; // dalle en cours (communes et parcs)
    this.queuedKey = null;
    this.settleKey = null;
    this.settleTimer = null;
    this.staleTimer = null;
    this.graceTimer = null;
    this.weatherTimer = null;
    this.lastMove = 0;
    this.moveFrame = null;

    this.#listeners();
    // getCenter() est disponible dès la création de la carte (map.loaded() reste faux tant que des tuiles chargent)
    this.#evaluate(false);
  }

  /** Réaffiche le volet (après fermeture par l'utilisateur) */
  enable() {
    this.enabled = true;
    this.#evaluate(false);
  }

  disable() {
    this.enabled = false;
    this.#setVisible(false);
  }

  /* ------------------------------------------------------------------------ */

  #listeners() {
    this.map.on("move", () => {
      if (this.moveFrame) {
        return;
      }
      this.moveFrame = requestAnimationFrame(() => {
        this.moveFrame = null;
        const now = performance.now();
        if (now - this.lastMove >= MOVE_INTERVAL) {
          this.lastMove = now;
          this.#evaluate(true);
        }
      });
    });
    this.map.on("moveend", () => {
      this.#evaluate(false);
      this.#scheduleWeather();
    });
    window.addEventListener("backbuttonstatechange", () => this.#evaluate(false));

    // intention d'ouvrir : on lance le chargement de l'espace de découverte sans attendre le clic
    let startY = null;
    let dragged = false;
    this.openBtn.addEventListener("pointerdown", (e) => {
      startY = e.clientY;
      dragged = false;
      this.#prepareTerritory();
    });
    this.openBtn.addEventListener("pointermove", (e) => {
      if (startY !== null && !dragged && startY - e.clientY > 30) {
        dragged = true;
        startY = null;
        this.#openTerritory();
      }
    });
    const end = () => { startY = null; };
    this.openBtn.addEventListener("pointerup", end);
    this.openBtn.addEventListener("pointercancel", end);
    this.openBtn.addEventListener("click", () => {
      if (dragged) {
        dragged = false;
        return;
      }
      this.#openTerritory();
    });
    this.closeBtn.addEventListener("click", () => this.disable());
  }

  #canShow() {
    return this.enabled && Globals.backButtonState === "default";
  }

  /**
   * Recalcule le territoire au centre de la carte
   * @param {boolean} moving appel pendant un déplacement
   */
  #evaluate(moving) {
    if (!this.#canShow()) {
      this.#setVisible(false);
      return;
    }
    const { lat, lng } = this.map.getCenter();
    const zoom = this.map.getZoom();
    if (zoom < FRANCE_ZOOM || !inFranceBoxes(lng, lat)) {
      this.#showMessage("far");
      return;
    }
    if (zoom < MIN_ZOOM) {
      this.#showMessage("zoom");
      return;
    }
    const key = tileKey(lat, lng);
    const state = this.index.tileState(key);
    if (state === "ready" || state === "partial") {
      const result = this.index.lookup(lat, lng);
      if (state === "partial" && !result.zone) {
        // forêts domaniales encore en chemin : on les attend un court instant
        const wait = this.index.lightArrival(key) + HEAVY_GRACE - Date.now();
        if (wait > 0) {
          this.#markStale();
          clearTimeout(this.graceTimer);
          this.graceTimer = setTimeout(() => this.#evaluate(false), wait);
          return;
        }
      }
      if (result.commune || result.zone) {
        this.#showZone({ ...result, lat, lng });
      } else {
        this.#showMessage("none");
      }
      return;
    }
    if (state === "error") {
      if (this.mode === "zone") {
        this.#markStale();
      } else {
        this.#showMessage("error");
      }
      return;
    }
    if (this.mode === "zone") {
      this.#markStale();
    } else if (this.mode !== null) {
      // on quitte un message (« zoomez… ») : squelette plutôt qu'un message devenu faux
      this.#showLoading();
    }
    if (state === "pending") {
      return;
    }
    // dalle inconnue
    if (!moving) {
      this.#load(key);
    } else if (key !== this.settleKey) {
      this.settleKey = key;
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        const c = this.map.getCenter();
        if (tileKey(c.lat, c.lng) === key) {
          this.#load(key);
        }
      }, SETTLE_DELAY);
    }
  }

  #load(key) {
    if (this.loadingKey) {
      if (key !== this.loadingKey) {
        this.queuedKey = key;
      }
      return;
    }
    this.loadingKey = key;
    const { light, done } = this.index.loadTile(key);
    light.then(() => {
      this.loadingKey = null;
      this.#evaluate(this.map.isMoving());
      const queued = this.queuedKey;
      this.queuedKey = null;
      const c = this.map.getCenter();
      if (queued && queued !== key && tileKey(c.lat, c.lng) === queued) {
        this.#load(queued);
      }
    });
    done.then(() => this.#evaluate(this.map.isMoving()));
  }

  /* ------------------------------------------------------------------------ */
  /* Affichage                                                                 */
  /* ------------------------------------------------------------------------ */

  #setVisible(visible) {
    this.el.classList.toggle("d-none", !visible);
    document.body.classList.toggle("territoryPeekVisible", visible);
  }

  #markStale() {
    if (this.el.classList.contains("isStale") || this.staleTimer) {
      return;
    }
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      this.el.classList.add("isStale");
      this.el.setAttribute("aria-busy", "true");
    }, STALE_DELAY);
  }

  #clearStale() {
    clearTimeout(this.staleTimer);
    this.staleTimer = null;
    clearTimeout(this.graceTimer);
    this.el.classList.remove("isStale");
    this.el.removeAttribute("aria-busy");
  }

  #showMessage(mode) {
    this.#clearStale();
    this.mode = mode;
    this.result = null;
    this.el.classList.add("isMessage");
    this.openBtn.disabled = true;
    const renderKey = `message:${mode}`;
    if (this.renderedKey !== renderKey) {
      this.renderedKey = renderKey;
      this.body.innerHTML = `<span class="territoryPeekGuidance">${esc(MESSAGES[mode])}</span>`;
    }
    this.openBtn.setAttribute("aria-label", MESSAGES[mode]);
    this.#setVisible(true);
  }

  #showLoading() {
    this.#clearStale();
    this.mode = "loading";
    this.result = null;
    this.el.classList.remove("isMessage");
    this.openBtn.disabled = true;
    if (this.renderedKey !== "loading") {
      this.renderedKey = "loading";
      this.body.innerHTML = `<span class="territoryPeekSkeleton" style="width:65%"></span>
        <span class="territoryPeekSkeleton territoryPeekSkeletonSmall" style="width:40%"></span>`;
    }
    this.openBtn.setAttribute("aria-label", "Recherche du territoire…");
    this.el.setAttribute("aria-busy", "true");
    this.#setVisible(true);
  }

  #showZone(result) {
    this.#clearStale();
    const texts = peekTexts(result);
    const id = this.#territoryId(result);
    const weather = this.#cachedWeather(result);
    const renderKey = `zone:${id}:${weather ? weather.temperature : ""}`;
    const changed = this.mode !== "zone" || this.#territoryId(this.result) !== id;
    this.mode = "zone";
    this.result = result;
    this.el.classList.remove("isMessage");
    this.openBtn.disabled = false;
    if (this.renderedKey !== renderKey) {
      this.renderedKey = renderKey;
      const weatherHtml = weather
        ? `<span class="territoryPeekWeather" title="${esc(weather.label)}">${icon(weather.icon, 20, "territorySun")}<span>${esc(weather.temperature)}°</span></span>`
        : "";
      this.body.innerHTML = `
        <div class="territoryPeekTitleRow">
          <span class="territoryPeekTitle">${esc(texts.title)}</span>
          ${weatherHtml}
          <span class="territoryPeekDots" aria-hidden="true"><span></span><span></span><span></span></span>
        </div>
        ${texts.subtitle ? `<span class="territoryPeekSubtitle">${esc(texts.subtitle)}</span>` : ""}`;
      if (changed) {
        this.body.classList.remove("isFresh");
        // relance l'animation d'apparition
        void this.body.offsetWidth;
        this.body.classList.add("isFresh");
      }
    }
    if (!weather && !this.map.isMoving()) {
      this.#scheduleWeather();
    }
    const label = [texts.kicker, texts.title, texts.subtitle].filter(Boolean).join(", ");
    this.openBtn.setAttribute("aria-label", `${label}. Ouvrir l'espace de découverte`);
    this.#setVisible(true);
  }

  #territoryId(result) {
    if (!result) {
      return "";
    }
    return result.zone?.id || result.communeId || result.commune?.codeInsee || "";
  }

  /* ------------------------------------------------------------------------ */
  /* Météo                                                                     */
  /* ------------------------------------------------------------------------ */

  #weatherKey({ lat, lng }) {
    return `${Math.round(lat * 10)}/${Math.round(lng * 10)}`;
  }

  #cachedWeather(result) {
    const entry = this.weather.get(this.#weatherKey(result));
    return entry && Date.now() - entry.at < WEATHER_TTL ? entry.value : null;
  }

  #scheduleWeather() {
    clearTimeout(this.weatherTimer);
    this.weatherTimer = setTimeout(() => {
      if (this.mode !== "zone" || !this.result || this.map.isMoving() || this.weatherInFlight) {
        return;
      }
      const result = this.result;
      if (this.#cachedWeather(result)) {
        return;
      }
      const key = this.#weatherKey(result);
      this.weatherInFlight = TerritoryData.getWeather(result.lat, result.lng)
        .then((value) => {
          this.weather.set(key, { value, at: Date.now() });
          if (this.mode === "zone" && this.result && this.#weatherKey(this.result) === key) {
            this.renderedKey = "";
            this.#showZone(this.result);
          }
        })
        .catch((err) => console.warn("[territoire survolé] météo :", err))
        .finally(() => { this.weatherInFlight = null; });
    }, WEATHER_DELAY);
  }

  /* ------------------------------------------------------------------------ */
  /* Ouverture de l'espace de découverte                                       */
  /* ------------------------------------------------------------------------ */

  #territoryOptions() {
    const result = this.result;
    if (this.mode !== "zone" || !result) {
      return null;
    }
    const position = Location.getCurrentPosition?.();
    const isUserPosition = !!position
      && distanceMeters(position.coords.latitude, position.coords.longitude, result.lat, result.lng) < 50;
    return {
      lat: result.lat,
      lng: result.lng,
      isUserPosition,
      commune: result.commune,
      zone: result.zone,
      weather: this.#cachedWeather(result),
    };
  }

  #prepareTerritory() {
    const options = this.#territoryOptions();
    if (options) {
      Globals.territory.prepare(options);
    }
  }

  #openTerritory() {
    const options = this.#territoryOptions();
    if (options) {
      Globals.territory.open(options);
    }
  }
}

export default TerritoryPeek;
