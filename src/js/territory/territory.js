/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Volet « Mon territoire » : informations sur le lieu où l'on se trouve
 * (commune, espaces protégés, forêts, évolution du territoire, météo),
 * lieux remarquables, sorties à proximité et cartes thématiques de l'IGN.
 *
 * Maquette : prototype Lovable « Cartes IGN — Prototype iPhone » (volet Territory, version V2).
 */
import * as maplibregl from "maplibre-gl";
import { Share } from "@capacitor/share";
import { Toast } from "@capacitor/toast";
import { Clipboard } from "@capacitor/clipboard";

import Globals from "../globals";
import DOM from "../dom";
import ImmersivePosion from "../immersive-position";
import NewsFeed from "../newsfeed";
import ImageCarousel from "../utils/image-carousel";
import ElevationLineControl from "../elevation-line-control/elevation-line-control";
import { config } from "../utils/config-utils";

import icon from "./territory-icons";
import TerritoryData, {
  PLACE_THEMES,
  distanceMeters,
  formatDistance,
  htmlToText,
  tileImageUrl,
  toList,
} from "./territory-data";
import Biodiversity, {
  CONTRIBUTE_LINKS,
  SPECIES_GROUPS,
  SPECIES_GROUP_ORDER,
  bamUrl,
  commonsThumb,
  interleaveGroups,
  seasonLabel,
  seasonMonths,
  speciesTilesUrl,
} from "./biodiversity-data";

const HIGHLIGHT_SOURCE = "territory-highlight";
const SPECIES_MAP_SOURCE = "territory-species-density";
const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const BIO_YEARS_TEXT = "dix dernières années";
const MONTH_NAMES = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
/** Couches de l'appli correspondant aux sorties : « Idées rando » (Geotrek) et « Animations locales » (DATAtourisme) */
const OUTING_LAYERS = {
  trek: "HIKING.GEOTREK$TMS",
  event: "DATATOURISME.FMA$TMS",
};
const PLACE_THEME_ORDER = ["monument", "unesco", "illustres", "musee", "jardin"];
const PROTECTED_LABELS = {
  "Parc national": "Parc national",
  "Parc naturel régional": "Parc naturel régional",
  "Réserve naturelle": "Réserve naturelle",
  "Site Natura 2000": "Zone Natura 2000",
};

/** Échappe une valeur pour l'insérer dans du HTML */
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Nombre au format français, avec une espace insécable classique (les polices de l'appli n'ont pas l'espace fine) */
function formatNumber(n) {
  return Number(n).toLocaleString("fr-FR").replace(/\u202f/g, "\u00a0");
}

function safeUrl(url) {
  if (!url) {
    return null;
  }
  let value = String(url).trim();
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value.replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Image avec repli : si src ne se charge pas, essaie fallbackSrc (ex. orthophoto), sinon masque l'image
 */
function img(src, cls, fallbackSrc = "") {
  if (!src) {
    return "";
  }
  const fallback = fallbackSrc && fallbackSrc !== src ? ` data-fallback="${esc(fallbackSrc)}"` : "";
  return `<img alt="" loading="lazy" class="${cls}" src="${esc(src)}"${fallback} onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;delete this.dataset.fallback;this.classList.add('territoryImgFallback');}else{this.onerror=null;this.classList.add('territoryImgError');}">`;
}

class Territory {
  /**
   * @param {maplibregl.Map} map carte principale
   */
  constructor(map) {
    this.map = map;
    this.target = DOM.$territoryWindow;
    this.content = this.target.querySelector(".territoryContent");
    this.views = [];
    this.forceClose = false;
    this.marker = null;
    this.reset();
    this.#listeners();
  }

  reset() {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    this.position = null;
    this.isUserPosition = false;
    this.commune = undefined;
    this.weather = undefined;
    this.places = undefined;
    this.placesErrors = [];
    this.outings = undefined;
    this.outingsErrors = [];
    this.bio = undefined;
    this.bioHome = [];
    this.bioSeason = undefined;
    this.immersive = null;
    this.views = [{ name: "home" }];
  }

  /**
   * Ouvre le volet pour un point
   * @param {Object} options
   * @param {number} options.lat
   * @param {number} options.lng
   * @param {boolean} options.isUserPosition le point est la position de l'utilisateur
   * @param {ImmersivePosion} options.immersive calcul « position immersive » déjà lancé pour ce point
   */
  open({ lat, lng, isUserPosition = false, immersive = null }) {
    const samePoint = this.position && Math.abs(this.position.lat - lat) < 1e-5 && Math.abs(this.position.lng - lng) < 1e-5;
    if (!samePoint) {
      this.reset();
      this.position = { lat, lng };
      this.isUserPosition = isUserPosition;
      this.#load(immersive);
    } else {
      this.views = [{ name: "home" }];
    }
    this.#render();
    Globals.menu.open("territory");
  }

  /** Revient à la vue précédente. @returns {boolean} false s'il n'y a pas de vue précédente */
  back() {
    if (this.forceClose) {
      this.forceClose = false;
      return false;
    }
    if (this.views.length <= 1) {
      return false;
    }
    this.views.pop();
    this.#render();
    return true;
  }

  /** Nettoie la carte (surbrillance, marqueur) */
  clearMap() {
    if (this.marker) {
      this.marker.remove();
      this.marker = null;
    }
    const source = this.map.getSource(HIGHLIGHT_SOURCE);
    if (source) {
      source.setData({ type: "FeatureCollection", features: [] });
    }
    if (this.map.getLayer(SPECIES_MAP_SOURCE)) {
      this.map.removeLayer(SPECIES_MAP_SOURCE);
    }
    if (this.map.getSource(SPECIES_MAP_SOURCE)) {
      this.map.removeSource(SPECIES_MAP_SOURCE);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Chargement                                                                */
  /* ------------------------------------------------------------------------ */

  #load(immersive) {
    const { lat, lng } = this.position;
    const signal = this.abortController.signal;
    const isCurrent = () => !signal.aborted;

    // Commune, espaces protégés, forêts : calculs « position immersive » existants
    this.immersive = immersive || new ImmersivePosion({ lat, lng });
    this.immersive.addEventListener("dataLoaded", () => {
      if (isCurrent()) {
        this.#renderIfHome();
      }
    });
    if (!immersive) {
      this.immersive.computeAll();
    }

    TerritoryData.getCommune(lat, lng)
      .then((commune) => { this.commune = commune; })
      .catch((err) => { console.warn("[territoire] commune :", err); this.commune = null; })
      .finally(() => isCurrent() && this.#renderIfHome());

    TerritoryData.getWeather(lat, lng, signal)
      .then((weather) => { this.weather = weather; })
      .catch((err) => { if (err.name !== "AbortError") { console.warn("[territoire] météo :", err); } this.weather = null; })
      .finally(() => isCurrent() && this.#renderIfHome());

    TerritoryData.getPlaces(lat, lng, signal)
      .then(({ places, errors }) => { this.places = places; this.placesErrors = errors; })
      .catch((err) => { console.warn("[territoire] lieux :", err); this.places = []; this.placesErrors = ["Lieux remarquables"]; })
      .finally(() => isCurrent() && this.#render());

    TerritoryData.getOutings(lat, lng, 15)
      .then(({ outings, errors }) => { this.outings = outings; this.outingsErrors = errors; })
      .catch((err) => { console.warn("[territoire] sorties :", err); this.outings = []; this.outingsErrors = ["Sorties"]; })
      .finally(() => isCurrent() && this.#render());

    // Biodiversité : observations partagées sur le GBIF (même principe que BAM)
    Biodiversity.getBiodiversity(lat, lng, signal)
      .then(async (bio) => {
        const home = interleaveGroups(bio.groups, 10);
        await Biodiversity.enrichSpecies(home, signal);
        this.bioHome = home;
        this.bio = bio;
      })
      .catch((err) => { if (err.name !== "AbortError") { console.warn("[territoire] biodiversité :", err); } this.bio = null; })
      .finally(() => isCurrent() && this.#renderIfBio());
  }

  /** Rend à nouveau si la vue courante affiche la biodiversité */
  #renderIfBio() {
    if (["home", "species", "bioAbout"].includes(this.#currentView().name)) {
      this.#render();
    }
  }

  #renderIfHome() {
    if (this.#currentView().name === "home") {
      this.#render();
    }
  }

  #currentView() {
    return this.views[this.views.length - 1];
  }

  #push(view) {
    this.views.push(view);
    this.#render();
    Globals.currentScrollIndex = 2;
    Globals.menu.updateScrollAnchors();
  }

  /* ------------------------------------------------------------------------ */
  /* Rendu                                                                     */
  /* ------------------------------------------------------------------------ */

  #render() {
    const view = this.#currentView();
    let html;
    switch (view.name) {
    case "places":
      html = this.#placesListHtml(view.filter || "all");
      break;
    case "outings":
      html = this.#outingsListHtml(view.filter || "all");
      break;
    case "place":
      html = this.#placeDetailHtml(view.item);
      break;
    case "outing":
      html = view.item.kind === "event" ? this.#eventDetailHtml(view.item) : this.#trekDetailHtml(view.item);
      break;
    case "species":
      html = this.#speciesListHtml(view);
      break;
    case "speciesDetail":
      html = this.#speciesDetailHtml(view);
      break;
    case "bioAbout":
      html = this.#bioAboutHtml();
      break;
    default:
      html = this.#homeHtml();
    }
    this.content.innerHTML = html;
    this.target.classList.toggle("territorySubview", view.name !== "home");
    if (view.name === "place" || view.name === "outing") {
      this.#mountDetailWidgets(view.item);
    }
    if (view.name === "species") {
      if (view.season) {
        this.#loadSeason(view);
      }
      this.#enrichVisible(view);
    }
  }

  #distanceText(item) {
    if (!Number.isFinite(item.distance)) {
      return "";
    }
    return `à ${formatDistance(item.distance)}${this.isUserPosition ? " de vous" : ""}`;
  }

  #sectionHeader(iconName, title, { subtitle = "", action = "", label = "" } = {}) {
    const button = action
      ? `<button type="button" class="territoryAllBtn" data-action="${action}" aria-label="Tout afficher : ${esc(label || title)}">Tout${icon("chevronRight", 14)}</button>`
      : "";
    return `
      <div class="territorySectionHeader">
        <div class="territorySectionTitleRow">
          ${iconName ? `<span class="territoryAccent">${icon(iconName, 22)}</span>` : ""}
          <h3 class="territorySectionTitle">${esc(title)}</h3>
          ${subtitle ? "" : button}
        </div>
        ${subtitle ? `<div class="territorySectionSubtitleRow"><p class="territoryMuted">${esc(subtitle)}</p>${button}</div>` : ""}
      </div>`;
  }

  #loadingCards(count = 2, width = 220) {
    return `<div class="territoryCarousel" aria-busy="true">${
      Array.from({ length: count }, () => `<div class="territoryCard territorySkeleton" style="width:${width}px"></div>`).join("")
    }</div>`;
  }

  #homeHtml() {
    const commune = this.commune;
    const data = this.immersive?.data || {};

    // En-tête
    let title = "Mon territoire";
    let subtitle = "";
    if (commune) {
      title = commune.name;
      subtitle = [commune.departement, commune.postcodes[0]].filter(Boolean).join(" · ");
    } else if (commune === undefined) {
      title = "Chargement du territoire…";
    }
    let weatherHtml = "";
    if (this.weather) {
      weatherHtml = `<span class="territoryWeather" title="${esc(this.weather.label)}${this.weather.max !== null ? ` · max ${this.weather.max}° min ${this.weather.min}°` : ""}">
        ${icon(this.weather.icon, 20, "territorySun")}<span>${esc(this.weather.temperature)}°</span></span>`;
    }

    // Caractéristiques
    const cards = [];
    if (commune?.population) {
      cards.push(`<div class="territoryCard territoryFactCard">
        <span class="territoryAccent">${icon("users", 20)}</span>
        <span class="territoryFactNumber">${formatNumber(commune.population)}</span>
        <span class="territoryMuted territorySmall">habitants</span>
      </div>`);
    }
    (data["BDTOPO_V3:parc_ou_reserve"] || []).slice(0, 2).forEach(([nature, toponyme]) => {
      cards.push(`<div class="territoryCard territoryFactCard">
        <span class="territoryAccent">${icon("shield", 20)}</span>
        <span class="territoryFactTitle">${esc(PROTECTED_LABELS[nature] || nature || "Espace protégé")}</span>
        <span class="territoryMuted territorySmall">${esc(toponyme || "Espace protégé")}</span>
      </div>`);
    });
    const rlt = this.#nearestComparePoi();
    if (rlt) {
      const [rLng, rLat] = rlt.geometry.coordinates.map(Number);
      cards.push(`<button type="button" class="territoryCard territoryEvolutionCard" data-action="compare" aria-label="Évolution du territoire : ${esc(rlt.properties.accroche)}">
        <span class="territoryKicker">Évolution du territoire</span>
        <span class="territoryEvolutionBody">
          ${img(tileImageUrl(rLat, rLng, 15), "territoryEvolutionImg")}
          <span class="territoryEvolutionText">${esc(rlt.properties.accroche)}</span>
        </span>
        <span class="territoryRoundBtn" aria-hidden="true">${icon("chevronRight", 16)}</span>
      </button>`);
    }
    const essences = data["LANDCOVER.FORESTINVENTORY.V2:formation_vegetale"] || [];
    const forests = data["BDTOPO_V3:foret_publique"] || [];
    if (essences.length || forests.length) {
      const essenceText = essences.length
        ? `Les bois alentour sont principalement composés de ${essences.slice(0, 4).join(", ").toLowerCase()}.`
        : "";
      cards.push(`<div class="territoryCard territoryTextCard">
        <span class="territoryCardTitleRow">${icon("tree", 20)}<span class="territoryFactTitle">${forests.length ? esc(forests[0]) : "Essence des forêts"}</span></span>
        <p class="territoryMuted territoryText">${esc(essenceText || "Vous êtes dans une forêt publique.")}</p>
      </div>`);
    }
    const rivers = (data["BDTOPO_V3:cours_d_eau"] || []).map((r) => r[0]).filter(Boolean).slice(0, 3);
    if (rivers.length) {
      cards.push(`<div class="territoryCard territoryTextCard">
        <span class="territoryCardTitleRow">${icon("mountain", 20)}<span class="territoryFactTitle">Cours d'eau</span></span>
        <p class="territoryMuted territoryText">${esc(rivers.join(", "))}</p>
      </div>`);
    }
    const factsHtml = cards.length
      ? `<div class="territoryCarousel">${cards.join("")}</div>`
      : (commune === undefined ? this.#loadingCards(3, 150) : "<p class=\"territoryMuted territoryEmpty\">Aucune information disponible pour ce lieu.</p>");

    // Lieux remarquables
    let placesHtml;
    if (this.places === undefined) {
      placesHtml = this.#loadingCards(2, 220);
    } else if (!this.places.length) {
      const message = this.placesErrors.length >= 5 ? "Lieux remarquables indisponibles pour le moment." : "Aucun lieu remarquable recensé à proximité.";
      placesHtml = `<p class="territoryMuted territoryEmpty">${message}</p>`;
    } else {
      placesHtml = `<div class="territoryCarousel">${this.places.slice(0, 8).map((p) => this.#placeCardHtml(p)).join("")}</div>`;
    }

    // Sorties
    let outingsHtml;
    if (this.outings === undefined) {
      outingsHtml = this.#loadingCards(2, 240);
    } else if (!this.outings.length) {
      const message = this.outingsErrors.length >= 2 ? "Sorties indisponibles pour le moment." : "Aucune sortie trouvée à proximité.";
      outingsHtml = `<p class="territoryMuted territoryEmpty">${message}</p>`;
    } else {
      outingsHtml = `<div class="territoryCarousel">${this.#homeOutings().map((o) => this.#outingCardHtml(o)).join("")}</div>`;
    }

    // Cartes thématiques
    const news = (config.newsfeed || []).slice(-1)[0];
    let newsHtml = "";
    if (news) {
      const newsId = config.newsfeed.length - 1;
      const image = news.images?.[0]?.url || news.images?.[0]?.src || news.images?.[0];
      newsHtml = `
        ${this.#sectionHeader("layers", "Les cartes thématiques de l'IGN", { action: "all-news", label: "cartes thématiques de l'IGN" })}
        <button type="button" class="territoryCard territoryNewsCard" data-action="news" data-id="${newsId}">
          ${typeof image === "string" ? img(image, "territoryNewsImg") : ""}
          <span class="territoryNewsBody">
            <span class="territoryCardTitle">${esc(news.title)}</span>
            ${news.date ? `<span class="territoryMuted territorySmall">${esc(news.date)}</span>` : ""}
            <span class="territoryLink">+ Voir la carte</span>
          </span>
        </button>`;
    }

    const errors = [...this.placesErrors, ...this.outingsErrors, ...(this.bio === null ? ["Biodiversité"] : [])];
    return `
      <div class="territoryHome">
        <div class="territoryHeader">
          <span class="territoryAccent territoryHeaderPin">${icon("mapPin", 22)}</span>
          <h2 class="territoryTitle">${esc(title)}</h2>
          ${weatherHtml}
        </div>
        ${subtitle ? `<p class="territoryMuted territorySubtitle">${esc(subtitle)}</p>` : ""}

        ${this.#sectionHeader("", "Caractéristiques du territoire")}
        ${factsHtml}

        ${this.#sectionHeader("landmark", "Lieux remarquables", { subtitle: "Monuments, musées, UNESCO… découvrir tous les lieux", action: "list-places", label: "lieux remarquables" })}
        ${placesHtml}

        ${this.#sectionHeader("leaf", "Biodiversité observée", { subtitle: "Espèces signalées ici par des naturalistes et des citoyens", action: this.bio?.total ? "list-species" : "", label: "espèces observées" })}
        ${this.#bioHomeHtml()}

        ${this.#sectionHeader("footprints", "Sorties à proximité", { action: "list-outings", label: "sorties à proximité" })}
        ${outingsHtml}

        ${newsHtml}

        ${errors.length ? `<p class="territoryMuted territorySmall territoryWarning">${icon("info", 14)} Données indisponibles pour le moment : ${esc(errors.join(", "))}.</p>` : ""}
        <p class="territoryMuted territorySmall territorySources">Sources : IGN, INSEE, ministère de la Culture, UNESCO, DATAtourisme, Geotrek, Open-Meteo (Météo-France), GBIF (observations partagées par les contributeurs), Wikidata et Wikimedia Commons.</p>
      </div>`;
  }

  /** Mélange événements et randonnées pour le carrousel de l'accueil */
  #homeOutings() {
    const events = this.outings.filter((o) => o.kind === "event").slice(0, 4);
    const treks = this.outings.filter((o) => o.kind === "trek").slice(0, 4);
    const mixed = [];
    for (let i = 0; i < 4; i++) {
      if (events[i]) mixed.push(events[i]);
      if (treks[i]) mixed.push(treks[i]);
    }
    return mixed;
  }

  #nearestComparePoi() {
    const features = config.comparePoiData?.features || [];
    const { lat, lng } = this.position;
    let best = null;
    features.forEach((f) => {
      const [fLng, fLat] = (f.geometry?.coordinates || []).map(Number);
      if (!Number.isFinite(fLat) || !Number.isFinite(fLng)) {
        return;
      }
      const d = distanceMeters(lat, lng, fLat, fLng);
      if (d < 40000 && (!best || d < best.d)) {
        best = { d, f };
      }
    });
    return best?.f || null;
  }

  #placeImage(place, zoom = 17) {
    return place.image || tileImageUrl(place.lat, place.lng, zoom);
  }

  /** Orthophoto du lieu, en repli d'une photo absente */
  #placeFallback(place, zoom = 17) {
    return place.image ? tileImageUrl(place.lat, place.lng, zoom) : "";
  }

  #placeCardHtml(place) {
    return `
      <button type="button" class="territoryCard territoryPlaceCard" data-action="open-place" data-id="${esc(place.id)}"
        aria-label="${esc(place.name)}, ${esc(PLACE_THEMES[place.theme].label)}. Ouvrir la fiche">
        <span class="territoryPlaceBody">
          <span class="territoryCardTitle">${esc(place.name)}</span>
          <span class="territoryBadge">${esc(PLACE_THEMES[place.theme].label)}</span>
          ${place.commune ? `<span class="territoryMuted territorySmall">${esc(place.commune)}</span>` : ""}
          <span class="territoryMuted territorySmall territoryDistance">${icon("navigation", 12)}${esc(this.#distanceText(place))}</span>
        </span>
        ${img(this.#placeImage(place), "territoryPlaceImg", this.#placeFallback(place))}
      </button>`;
  }

  #dateBadge(outing) {
    if (outing.ongoing || !outing.start) {
      return "<span class=\"territoryDateBadge territoryDateBadgeText\">En cours</span>";
    }
    const day = outing.start.getDate();
    const month = outing.start.toLocaleDateString("fr-FR", { month: "short" }).replace(".", "");
    return `<span class="territoryDateBadge"><span class="territoryDateDay">${day}</span><span class="territoryDateMonth">${esc(month)}</span></span>`;
  }

  #difficultyPill(outing) {
    if (!outing.difficulty) {
      return "";
    }
    const level = /facile/i.test(outing.difficulty) ? "easy" : /difficile/i.test(outing.difficulty) ? "hard" : "medium";
    return `<span class="territoryPill"><span class="territoryDot territoryDot-${level}"></span>${esc(outing.difficulty)}</span>`;
  }

  #outingCardHtml(outing) {
    if (outing.kind === "event") {
      return `
        <button type="button" class="territoryCard territoryOutingCard" data-action="open-outing" data-id="${esc(outing.id)}" aria-label="${esc(outing.name)}. Ouvrir la fiche">
          <span class="territoryOutingMedia">
            ${img(outing.image || tileImageUrl(outing.lat, outing.lng, 16), "territoryOutingImg")}
            ${this.#dateBadge(outing)}
          </span>
          <span class="territoryOutingBody">
            <span class="territoryCardTitle">${esc(outing.name)}</span>
            ${outing.commune ? `<span class="territoryMuted territorySmall">${esc(outing.commune)}</span>` : ""}
            <span class="territoryMuted territorySmall territoryDistance">${icon("navigation", 12)}${esc(this.#distanceText(outing))}</span>
            <span class="territoryBadgeRow"><span class="territoryBadge">Événement</span></span>
          </span>
        </button>`;
    }
    const stats = [outing.duration, outing.length, outing.ascent].filter(Boolean).join(" · ");
    return `
      <button type="button" class="territoryCard territoryOutingCard" data-action="open-outing" data-id="${esc(outing.id)}" aria-label="${esc(outing.name)}. Ouvrir la fiche">
        <span class="territoryOutingMedia territoryOutingMediaShort">
          ${img(outing.image || tileImageUrl(outing.lat, outing.lng, 14, "GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2"), "territoryOutingImg")}
          <span class="territoryPills">${this.#difficultyPill(outing)}${outing.practice ? `<span class="territoryPill">${esc(outing.practice)}</span>` : ""}</span>
        </span>
        <span class="territoryOutingBody">
          <span class="territoryCardTitle">${esc(outing.name)}</span>
          ${stats ? `<span class="territoryMuted territorySmall">${esc(stats)}</span>` : ""}
          ${outing.commune ? `<span class="territoryMuted territorySmall">${esc(outing.commune)}</span>` : ""}
          <span class="territoryMuted territorySmall territoryDistance">${icon("navigation", 12)}${esc(this.#distanceText(outing))}</span>
        </span>
      </button>`;
  }

  #subHeader(title) {
    return `
      <div class="territorySubHeader">
        <button type="button" class="territoryBackBtn" data-action="back" aria-label="Retour">${icon("arrowLeft", 20)}</button>
        <h2 class="territorySubTitle">${esc(title)}</h2>
      </div>`;
  }

  #chips(options, current) {
    return `<div class="territoryChips" role="tablist">${options.map(([value, label]) => `
      <button type="button" role="tab" aria-selected="${value === current}" class="territoryChip${value === current ? " active" : ""}" data-action="filter" data-value="${value}">${esc(label)}</button>`).join("")}
    </div>`;
  }

  #placesListHtml(filter) {
    const places = this.places || [];
    const view = this.#currentView();
    view.expanded = view.expanded || {};
    const PAGE = 10;
    const shown = (theme) => (filter === "all" ? 5 : PAGE) + (view.expanded[theme] || 0);
    const themes = PLACE_THEME_ORDER.filter((t) => places.some((p) => p.theme === t));
    const chips = this.#chips([["all", "Tout"], ...themes.map((t) => [t, PLACE_THEMES[t].group])], filter);
    const sections = (filter === "all" ? themes : [filter]).map((theme) => {
      const items = places.filter((p) => p.theme === theme);
      if (!items.length) {
        return "";
      }
      return `
        <section class="territoryListSection" aria-label="${esc(PLACE_THEMES[theme].group)}">
          <div class="territoryListSectionHeader">
            <h3 class="territoryListTitle">${esc(PLACE_THEMES[theme].group)} <span class="territoryMuted">(${items.length})</span></h3>
            <button type="button" class="territoryAllBtn" data-action="show-group" data-value="${theme}" aria-label="Voir les lieux sur la carte — ${esc(PLACE_THEMES[theme].group)}">Carte${icon("map", 14)}</button>
          </div>
          <div class="territoryRows">
            ${items.slice(0, shown(theme)).map((p) => `
              <button type="button" class="territoryCard territoryRow" data-action="open-place" data-id="${esc(p.id)}" aria-label="${esc(p.name)}, ${esc(PLACE_THEMES[p.theme].label)}. Ouvrir la fiche">
                ${img(this.#placeImage(p, 17), "territoryRowImg", this.#placeFallback(p, 17))}
                <span class="territoryRowBody">
                  <span class="territoryCardTitle">${esc(p.name)}</span>
                  ${p.category && p.category !== PLACE_THEMES[p.theme].label ? `<span class="territoryMuted territorySmall">${esc(p.category)}</span>` : ""}
                  <span class="territoryMuted territorySmall">${p.commune ? `${esc(p.commune)}, ` : ""}<span class="territoryWarm">${esc(this.#distanceText(p))}</span></span>
                </span>
                <span class="territoryRowArrow" aria-hidden="true">${icon("chevronRight", 18)}</span>
              </button>`).join("")}
          </div>
          ${items.length > shown(theme) ? `<button type="button" class="territoryMoreBtn" data-action="more" data-value="${theme}">Afficher ${Math.min(PAGE, items.length - shown(theme))} lieux de plus (${items.length - shown(theme)} restants)</button>` : ""}
        </section>`;
    }).join("");
    return `
      ${this.#subHeader("Lieux remarquables")}
      ${places.length ? chips : ""}
      ${sections || `<p class="territoryMuted territoryEmpty">${this.places === undefined ? "Chargement…" : "Aucun lieu pour ce type."}</p>`}
      <p class="territoryMuted territorySmall territorySources">Sources : ministère de la Culture (Mérimée, Muséofile, Maisons des illustres, Jardins remarquables), UNESCO, IGN.</p>`;
  }

  #outingsListHtml(filter) {
    const outings = (this.outings || []).filter((o) => filter === "all" || o.kind === filter);
    const chips = this.#chips([["all", "Tout"], ["event", "Événements"], ["trek", "Randonnées"]], filter);
    return `
      ${this.#subHeader("Sorties à proximité")}
      ${chips}
      <div class="territoryList">
        ${outings.length ? outings.slice(0, 40).map((o) => this.#outingCardHtml(o)).join("") : `<p class="territoryMuted territoryEmpty">${this.outings === undefined ? "Chargement…" : "Aucune sortie pour ce type sur la période."}</p>`}
      </div>
      <p class="territoryMuted territorySmall territorySources">Sources : DATAtourisme, ADN Tourisme (événements à venir dans les 60 jours) ; Geotrek (randonnées).</p>`;
  }

  #actionsHtml(item) {
    return `
      <div class="territoryActions">
        <button type="button" class="territoryActionPill" data-action="directions">${icon("route", 18)}Itinéraire</button>
        <button type="button" class="territoryActionPill" data-action="share">${icon("share", 18)}Partager</button>
        <button type="button" class="territoryActionPill" data-action="show-on-map">${icon("map", 18)}Carte</button>
      </div>
      ${item.address ? `
      <div class="territoryAddress">
        <span class="territoryAddressIcon">${icon("mapPin", 16)}</span>
        <span class="territoryAddressText"><span class="territoryAddressMain">${esc(item.address)}</span><span class="territoryWarm">${esc(this.#distanceText(item))}</span></span>
        <button type="button" class="territoryCopyBtn" data-action="copy-address">Copier${icon("copy", 14)}</button>
      </div>` : ""}`;
  }

  #foldable(title, text, max = 280) {
    if (!text) {
      return "";
    }
    const long = text.length > max;
    return `
      ${title ? `<h3 class="territoryDetailH3">${esc(title)}</h3>` : ""}
      <p class="territoryMuted territoryParagraph${long ? " territoryFolded" : ""}">${esc(text)}</p>
      ${long ? "<button type=\"button\" class=\"territoryLink\" data-action=\"read-more\">Lire plus</button>" : ""}`;
  }

  #infoRows(rows) {
    const filled = rows.filter(([, value]) => value);
    if (!filled.length) {
      return "";
    }
    return `<div class="territoryInfoCard">${filled.map(([label, value]) => `
      <div class="territoryInfoRow"><p class="territoryInfoLabel">${esc(label)}</p><p class="territoryMuted">${esc(value)}</p></div>`).join("")}</div>`;
  }

  #linksHtml(links) {
    const filled = links.filter(([, url]) => safeUrl(url));
    if (!filled.length) {
      return "";
    }
    return `<div class="territoryLinks">${filled.map(([label, url, iconName]) => `
      <a class="territoryExtLink" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${icon(iconName || "external", 16)}${esc(label)}</a>`).join("")}</div>`;
  }

  /** Photos à afficher en galerie : Mémoire (monuments), médias Geotrek (randonnées) */
  #photosOf(item) {
    if (item.photos?.length) {
      return item.photos;
    }
    if (item.kind === "trek" && item.raw?.medias) {
      try {
        return JSON.parse(item.raw.medias)
          .filter((m) => m.url && (!m.type_media || m.type_media === "image"))
          .slice(0, 8)
          .map((m) => ({ url: m.url, credit: m.auteur || "" }));
      } catch {
        return [];
      }
    }
    return [];
  }

  #galleryHtml(item) {
    const photos = this.#photosOf(item);
    if (photos.length < 2) {
      return img(photos[0]?.thumb || photos[0]?.url || this.#placeImage(item, 18), "territoryHeroImg", tileImageUrl(item.lat, item.lng, 18));
    }
    const source = item.theme === "monument" ? "base Mémoire, ministère de la Culture" : esc(item.source);
    // (galerie : 2 photos ou plus ; une photo seule s'affiche en en-tête)
    return `
      <div class="territoryGallery" data-gallery></div>
      <p class="territoryMuted territorySmall territoryGalleryCaption">${photos.length} photos · ${source} · touchez une photo pour l'agrandir et voir son crédit</p>`;
  }

  #mountDetailWidgets(item) {
    const gallery = this.content.querySelector("[data-gallery]");
    if (gallery) {
      const photos = this.#photosOf(item);
      new ImageCarousel(gallery, photos.map((p) => p.url), {
        imageTitle: item.name,
        imageCredits: photos.map((p) => p.credit),
        fixedHeight: 200,
        squareWidth: 180,
        backButtonState: Globals.backButtonState,
        shareActivated: false,
        noMargins: true,
      });
    }
    const profile = this.content.querySelector("[data-profile]");
    if (profile && item.raw?.geometry) {
      try {
        const geometry = JSON.parse(item.raw.geometry);
        const coords = geometry.type === "MultiLineString" ? geometry.coordinates.flat() : geometry.coordinates;
        const control = new ElevationLineControl({ target: profile });
        control.setCoordinates(coords);
        control.compute(item.raw.longueur).catch((err) => console.warn("[territoire] profil :", err));
      } catch (err) {
        console.warn("[territoire] profil :", err);
      }
    }
  }

  #detailTop(item, kicker) {
    return `
      ${this.#subHeader(PLACE_THEMES[item.theme]?.group || "Sortie")}
      <div class="territoryDetail">
        ${this.#galleryHtml(item)}
        <h2 class="territoryDetailTitle">${esc(item.name)}</h2>
        <p class="territoryMuted territorySmall territoryDetailKicker">${kicker}</p>
        ${this.#actionsHtml(item)}`;
  }

  #placeDetailHtml(place) {
    const r = place.raw || {};
    const kicker = `<strong>${esc(place.category || PLACE_THEMES[place.theme].label)}</strong> – Source : ${esc(place.source)}`;
    let body = "";
    switch (place.theme) {
    case "monument": {
      const ref = r.Reference;
      body = `
        ${this.#foldable("Description", htmlToText(r.Historique || r.Description_de_l_edifice))}
        ${this.#infoRows([["Type", place.category || r.Domaine], ["Propriété", r.Statut_juridique_de_l_edifice]])}
        ${r.Siecle_de_la_campagne_principale_de_construction || r.Datation_de_l_edifice ? `
          <h3 class="territoryDetailH3">Historique de l'édifice</h3>
          <div class="territoryTimeline"><span class="territoryTimelineDot"></span><div>
            <p class="territoryInfoLabel">${esc(r.Siecle_de_la_campagne_principale_de_construction || r.Datation_de_l_edifice)}</p>
            <p class="territoryMuted">Siècle de campagne principale de construction</p></div></div>` : ""}
        ${r.Typologie_de_la_protection || r.Date_et_typologie_de_la_protection ? `
          <h3 class="territoryDetailH3">Protection et label</h3>
          <div class="territoryInfoCard territoryProtection">${icon("shield", 20)}<span>${esc(r.Date_et_typologie_de_la_protection || r.Typologie_de_la_protection)}</span></div>` : ""}
        ${r.Precision_de_la_protection ? this.#infoRows([["Précision sur la protection", r.Precision_de_la_protection]]) : ""}
        <h3 class="territoryDetailH3">Ressources documentaires</h3>
        <ul class="territoryRefs">
          <li><strong>Référence de la notice :</strong> ${esc(ref)}</li>
          <li><strong>Nom de la base :</strong> Patrimoine architectural (Mérimée)</li>
          <li><strong>Producteur :</strong> Monuments historiques</li>
          ${r.Cadre_de_l_etude ? `<li><strong>Cadre de l'étude :</strong> ${esc(r.Cadre_de_l_etude)}</li>` : ""}
        </ul>
        ${this.#linksHtml([
    ["Voir la fiche officielle (POP)", `https://pop.culture.gouv.fr/notice/merimee/${encodeURIComponent(ref)}`],
    ["Archives des monuments historiques (Archiv'MH)", r.Lien_vers_la_base_Archiv_MH],
  ])}`;
      break;
    }
    case "musee":
      body = `
        ${this.#foldable("Histoire", htmlToText(r.Histoire))}
        ${this.#infoRows([
    ["Thématiques principales", toList(r.Domaine_thematique).join(", ")],
    ["Atouts majeurs", htmlToText(r.Atout)],
    ["Artistes phares", toList(r.Artiste).join(", ")],
    ["Personnages phares", toList(r.Personnage_phare).join(", ")],
    ["Appellation « Musée de France »", r.Date_arrete_attribution_appellation ? `depuis le ${new Date(r.Date_arrete_attribution_appellation).toLocaleDateString("fr-FR")}` : ""],
  ])}
        ${this.#infoRows([["Caractéristiques architecturales", htmlToText(r.Protection_batiment)], ["Intérêt du bâtiment", htmlToText(r.Interet)]])}
        <h3 class="territoryDetailH3">Infos pratiques</h3>
        ${this.#linksHtml([
    [r.Telephone ? `Appeler le ${r.Telephone}` : "", r.Telephone ? `tel:${String(r.Telephone).replace(/\s/g, "")}` : null, "phone"],
    ["Visiter le site web", r.URL, "globe"],
    ["Fiche Muséofile (POP)", `https://pop.culture.gouv.fr/notice/museo/${encodeURIComponent(r.Identifiant)}`],
  ])}`;
      break;
    case "illustres":
    case "jardin":
      body = `
        ${this.#foldable("Description", htmlToText(r.description))}
        ${this.#infoRows([
    [place.theme === "illustres" ? "Illustre" : "Type de jardin", place.theme === "illustres" ? r.auteur_nom_illustre : toList(r.types).join(", ")],
    ["Label obtenu en", r.annee_obtention ? String(r.annee_obtention) : ""],
  ])}
        <h3 class="territoryDetailH3">Infos pratiques</h3>
        ${this.#linksHtml([
    ...toList(r.telephones).slice(0, 1).map((t) => [`Appeler le ${t}`, `tel:${t.replace(/\s/g, "")}`, "phone"]),
    ...toList(r.site_internet_et_autres_liens).slice(0, 2).map((u, i) => [i === 0 ? "Visiter le site web" : "Autre lien", u, "globe"]),
  ])}`;
      break;
    case "unesco":
      body = `
        ${this.#foldable("Description", htmlToText(r.description))}
        ${this.#infoRows([["Année d'inscription", r.date_inscription]])}
        ${this.#linksHtml([["Accéder à la fiche UNESCO", r.lien_unesco]])}`;
      break;
    default:
      break;
    }
    const photoCredit = place.photos?.length === 1 && place.photos[0].credit ? ` <span class="territoryPhotoCredit">Photo : ${esc(place.photos[0].credit)}.</span>` : "";
    return `${this.#detailTop(place, kicker)}${body}
      <p class="territoryMuted territorySmall territorySources">Source : ${esc(place.source)}.${photoCredit}</p>
      </div>`;
  }

  #eventDetailHtml(event) {
    const r = event.raw || {};
    const kicker = `<strong>${esc(event.dateRange || "Événement")}</strong> – Source : DATAtourisme`;
    const telLink = r.registrationPhone ? [`Appeler le ${r.registrationPhone}`, `tel:${String(r.registrationPhone).replace(/\s/g, "")}`, "phone"] : ["", null];
    return `${this.#detailTop(event, kicker)}
        ${this.#foldable("Description", htmlToText(r.description))}
        ${this.#infoRows([["Organisation", htmlToText(r.creatorHtml).replace(/^Évènement proposé par\s*:\s*/i, "")]])}
        <h3 class="territoryDetailH3">Infos pratiques</h3>
        ${this.#linksHtml([telLink, ["Site web", r.registrationWeb, "globe"], ["Contacter l'organisateur", r.registrationEmail, "mail"]])}
        <p class="territoryMuted territorySmall territorySources">Source : DATAtourisme, ADN Tourisme.</p>
      </div>`;
  }

  #trekDetailHtml(trek) {
    const r = trek.raw || {};
    const kicker = `${this.#difficultyPill(trek)} ${trek.practice ? `<span class="territoryPill">${esc(trek.practice)}</span>` : ""} – Source : ${esc(trek.source)}`;
    return `${this.#detailTop({ ...trek, address: r.depart || trek.commune }, kicker)}
        <div class="territoryStats">
          ${trek.duration ? `<div><span class="territoryInfoLabel">${esc(trek.duration)}</span><span class="territoryMuted territorySmall">Durée</span></div>` : ""}
          ${trek.length ? `<div><span class="territoryInfoLabel">${esc(trek.length)}</span><span class="territoryMuted territorySmall">Distance</span></div>` : ""}
          ${Number(r.denivele_positif) > 0 ? `<div><span class="territoryInfoLabel">+${Math.round(r.denivele_positif)} m</span><span class="territoryMuted territorySmall">Dénivelé positif</span></div>` : ""}
          ${Number(r.denivele_negatif) < 0 ? `<div><span class="territoryInfoLabel">${Math.round(r.denivele_negatif)} m</span><span class="territoryMuted territorySmall">Dénivelé négatif</span></div>` : ""}
        </div>
        <h3 class="territoryDetailH3">Profil altimétrique</h3>
        <div class="territoryProfile" data-profile></div>
        ${this.#foldable("", htmlToText(r.presentation_courte))}
        ${this.#infoRows([["Lieu de départ", r.depart], ["Lieu d'arrivée", r.arrivee], ["Type d'itinéraire", r.type_itineraire], ["Thèmes", r.themes]])}
        ${this.#foldable("Présentation", htmlToText(r.presentation))}
        ${this.#foldable("Instructions", htmlToText(r.instructions))}
        ${this.#foldable("Recommandations", htmlToText(r.recommandations))}
        ${this.#linksHtml([["Télécharger la trace GPX", r.gpx, "route"]])}
        <p class="territoryMuted territorySmall territorySources">Source : ${esc(trek.source)}.</p>
      </div>`;
  }

  /* ------------------------------------------------------------------------ */
  /* Biodiversité                                                              */
  /* ------------------------------------------------------------------------ */

  #speciesName(s) {
    return s.frName || s.scientificName || "Espèce";
  }

  /** Nom scientifique, s'il n'est pas déjà le nom affiché */
  #speciesSci(s) {
    return s.frName && s.scientificName ? s.scientificName : "";
  }

  /** Photo : Wikimedia Commons (via Wikidata), sinon photo partagée avec une observation */
  #speciesImageUrl(s, width) {
    if (s.image) {
      return commonsThumb(s.image, width);
    }
    if (s.photo) {
      return width > 240 ? s.photo.url : s.photo.thumb;
    }
    return "";
  }

  /** Photo de l'espèce (Wikimedia Commons), sur un pictogramme du groupe qui reste visible si elle manque */
  #speciesMedia(s, cls, width = 400, iconSize = 32) {
    return `<span class="territorySpeciesMedia ${cls}">
      ${icon(SPECIES_GROUPS[s.group]?.icon || "leaf", iconSize)}
      ${this.#speciesImageUrl(s, width) ? img(this.#speciesImageUrl(s, width), "territorySpeciesImg") : ""}
    </span>`;
  }

  #iucnPill(s, onlyThreatened = false) {
    if (!s.iucn || (onlyThreatened && !["NT", "VU", "EN", "CR", "EW"].includes(s.iucn.code))) {
      return "";
    }
    return `<span class="territoryIucn territoryIucn-${esc(s.iucn.code)}" title="Liste rouge mondiale de l'UICN : ${esc(s.iucn.label)}">${esc(s.iucn.code)}</span>`;
  }

  #radiusText() {
    return `à moins de ${formatDistance(this.bio?.radius)}`;
  }

  /** Titre court d'un jeu de données (« iNaturalist Research-grade Observations » → « iNaturalist ») */
  #datasetShort(title) {
    const t = String(title || "").split(/\s[-–—:(]\s?/)[0].replace(/\s+Research-grade Observations$/i, "").trim();
    return t.length > 60 ? `${t.slice(0, 58)}…` : t;
  }

  #datasetCountText() {
    const n = this.bio.datasetCount;
    return `${n >= 50 ? "plus de 50" : n} source${n > 1 ? "s" : ""}`;
  }

  /** Mention de la source, toujours visible sous les espèces : données collaboratives, GBIF */
  #bioSourceNote() {
    const b = this.bio;
    const names = b.datasets.slice(0, 2).map((d) => this.#datasetShort(d.title));
    return `
      <button type="button" class="territoryBioNote" data-action="bio-about">
        <span class="territoryAccent">${icon("users2", 18)}</span>
        <span>
          <strong>${formatNumber(b.total)} observations</strong> partagées ${esc(this.#radiusText())} depuis ${b.since}
          par les contributeurs de ${esc(this.#datasetCountText())}${names.length ? ` (${esc(names.join(", "))}…)` : ""}, via le GBIF.
          <span class="territoryLink">D'où viennent ces données ?</span>
        </span>
      </button>`;
  }

  #speciesCardHtml(s) {
    return `
      <button type="button" class="territoryCard territorySpeciesCard" data-action="open-species" data-id="${esc(s.key)}"
        aria-label="${esc(this.#speciesName(s))}, ${esc(SPECIES_GROUPS[s.group].one)}. Ouvrir la fiche">
        ${this.#speciesMedia(s, "territorySpeciesCardMedia")}
        <span class="territoryPlaceBody">
          <span class="territoryCardTitle">${esc(this.#speciesName(s))}</span>
          ${this.#speciesSci(s) ? `<span class="territoryMuted territorySmall territorySci">${esc(this.#speciesSci(s))}</span>` : ""}
          <span class="territoryBadgeRow"><span class="territoryBadge">${esc(SPECIES_GROUPS[s.group].one)}</span>${this.#iucnPill(s, true)}</span>
          <span class="territoryMuted territorySmall territoryDistance">${formatNumber(s.count)} observation${s.count > 1 ? "s" : ""}</span>
        </span>
      </button>`;
  }

  #bioHomeHtml() {
    if (this.bio === undefined) {
      return this.#loadingCards(2, 160);
    }
    if (this.bio === null) {
      return "<p class=\"territoryMuted territoryEmpty\">Biodiversité indisponible pour le moment.</p>";
    }
    if (!this.bio.total || !this.bioHome.length) {
      return `
        <p class="territoryMuted territoryEmpty">Aucune observation partagée ${esc(this.#radiusText())}. Les espèces sont pourtant bien là : vous pouvez être parmi les premiers à les signaler.</p>
        <button type="button" class="territoryLink territoryBioEmptyLink" data-action="bio-about">Comment partager une observation ?</button>`;
    }
    return `
      <div class="territoryCarousel">${this.bioHome.map((s) => this.#speciesCardHtml(s)).join("")}</div>
      ${this.#bioSourceNote()}`;
  }

  #speciesRowHtml(s) {
    return `
      <button type="button" class="territoryCard territoryRow" data-action="open-species" data-id="${esc(s.key)}" aria-label="${esc(this.#speciesName(s))}. Ouvrir la fiche">
        ${this.#speciesMedia(s, "territoryRowImg", 200, 24)}
        <span class="territoryRowBody">
          <span class="territoryCardTitle">${s.enriched ? esc(this.#speciesName(s)) : "<span class=\"territoryMuted\">Chargement…</span>"}</span>
          ${this.#speciesSci(s) ? `<span class="territoryMuted territorySmall territorySci">${esc(this.#speciesSci(s))}</span>` : ""}
          <span class="territoryMuted territorySmall">${formatNumber(s.count)} observation${s.count > 1 ? "s" : ""} ${this.#iucnPill(s, true)}</span>
        </span>
        <span class="territoryRowArrow" aria-hidden="true">${icon("chevronRight", 18)}</span>
      </button>`;
  }

  /** Groupes affichés dans la liste : toute l'année, ou « en ce moment » (saison) */
  #listGroups(view) {
    if (!view.season) {
      return this.bio?.groups || {};
    }
    return this.bioSeason && this.bioSeason !== "loading" ? this.bioSeason : null;
  }

  #speciesListHtml(view) {
    const months = seasonMonths();
    const filter = view.filter || "all";
    view.expanded = view.expanded || {};
    const groups = this.#listGroups(view);
    const PAGE = 15;
    const shown = (g) => (filter === "all" ? 5 : PAGE) + (view.expanded[g] || 0);
    const present = groups ? SPECIES_GROUP_ORDER.filter((g) => groups[g]?.species.length) : [];

    const about = `
      <button type="button" class="territoryCard territoryAboutCard" data-action="bio-about">
        <span class="territoryAccent">${icon("users2", 22)}</span>
        <span>
          <span class="territoryInfoLabel">Des données collaboratives</span>
          <span class="territoryMuted territorySmall territoryAboutText">Ces espèces ont été observées et partagées par des naturalistes, des associations, des scientifiques et des citoyens. Ce n'est pas un inventaire complet : une espèce peut être présente sans avoir été signalée.</span>
          <span class="territoryLink territorySmall">En savoir plus et contribuer</span>
        </span>
      </button>`;

    const season = this.#chips([["year", "Toute l'année"], ["season", "En ce moment"]], view.season ? "season" : "year")
      .replace(/data-action="filter"/g, "data-action=\"season\"")
      + (view.season ? `<p class="territoryMuted territorySmall territorySeasonCaption">Espèces observées ${/^[aeiou]/.test(seasonLabel(months)) ? "d'" : "de "}${seasonLabel(months)}, ces ${BIO_YEARS_TEXT}.</p>` : "");
    const chips = present.length > 1 ? this.#chips([["all", "Tout"], ...present.map((g) => [g, SPECIES_GROUPS[g].label])], filter) : "";

    let sections;
    if (!groups) {
      sections = `<p class="territoryMuted territoryEmpty">${this.bioSeason === null ? "Données de saison indisponibles pour le moment." : "Chargement…"}</p>`;
    } else {
      sections = (filter === "all" ? present : [filter].filter((g) => present.includes(g))).map((g) => {
        const { species, count, truncated } = groups[g];
        const visible = species.slice(0, shown(g));
        return `
          <section class="territoryListSection" aria-label="${esc(SPECIES_GROUPS[g].label)}">
            <div class="territoryListSectionHeader">
              <h3 class="territoryListTitle">${esc(SPECIES_GROUPS[g].label)}
                <span class="territoryMuted territorySmall">${truncated ? "plus de " : ""}${species.length} espèce${species.length > 1 ? "s" : ""} · ${formatNumber(count)} obs.</span></h3>
            </div>
            <div class="territoryRows">${visible.map((s) => this.#speciesRowHtml(s)).join("")}</div>
            ${species.length > shown(g) ? `<button type="button" class="territoryMoreBtn" data-action="more" data-value="${g}">${(() => { const n = Math.min(10, species.length - shown(g)); return n > 1 ? `Afficher ${n} espèces de plus` : "Afficher une espèce de plus"; })()}</button>` : ""}
          </section>`;
      }).join("") || `<p class="territoryMuted territoryEmpty">Aucune observation partagée ${view.season ? "à cette saison" : ""} ${esc(this.#radiusText())}.</p>`;
    }

    return `
      ${this.#subHeader("Biodiversité observée")}
      ${about}
      ${season}
      ${chips}
      ${sections}
      <p class="territoryMuted territorySmall territorySources">Observations : GBIF.org, partagées par les contributeurs de ${this.bio ? esc(this.#datasetCountText()) : "nombreuses sources"},
        ${esc(this.#radiusText())}, depuis ${this.bio?.since || ""}. Noms et photos : Wikidata, Wikimedia Commons.
        Même principe que <a class="territoryInlineLink" href="${esc(bamUrl(this.position.lat, this.position.lng, this.bio?.radius || 1000))}" target="_blank" rel="noopener">BAM — Biodiversité autour de moi</a> (parcs nationaux des Écrins et des Cévennes).</p>`;
  }

  /** Complète (noms, photos) les espèces visibles dans la liste, puis rend à nouveau */
  #enrichVisible(view) {
    const groups = this.#listGroups(view);
    if (!groups) {
      return;
    }
    const filter = view.filter || "all";
    const pending = SPECIES_GROUP_ORDER
      .filter((g) => filter === "all" || g === filter)
      .flatMap((g) => (groups[g]?.species || []).slice(0, (filter === "all" ? 5 : 15) + (view.expanded?.[g] || 0)))
      .filter((s) => !s.enriched && !s.enriching);
    if (!pending.length) {
      return;
    }
    pending.forEach((s) => { s.enriching = true; });
    Biodiversity.enrichSpecies(pending, this.abortController.signal)
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.warn("[territoire] espèces :", err);
          pending.forEach((s) => { s.enriched = true; });
        }
      })
      .finally(() => {
        pending.forEach((s) => { delete s.enriching; });
        if (this.#currentView() === view) {
          this.#render();
        }
      });
  }

  #loadSeason(view) {
    if (this.bioSeason !== undefined || !this.bio?.geometry) {
      return;
    }
    this.bioSeason = "loading";
    const signal = this.abortController.signal;
    Biodiversity.getSpeciesByGroup(this.bio.geometry, { months: seasonMonths(), signal })
      .then((groups) => { this.bioSeason = groups; })
      .catch((err) => { if (err.name !== "AbortError") { console.warn("[territoire] saison :", err); } this.bioSeason = null; })
      .finally(() => {
        if (!signal.aborted && this.#currentView() === view) {
          this.#render();
        }
      });
  }

  #openSpecies(key) {
    const view = this.#currentView();
    const lists = [this.bioHome, ...Object.values(this.bio?.groups || {}).map((g) => g.species)];
    if (this.bioSeason && this.bioSeason !== "loading") {
      lists.push(...Object.values(this.bioSeason).map((g) => g.species));
    }
    const pool = view.name === "species" && view.season ? lists.reverse() : lists;
    const item = pool.flat().find((s) => s.key === key);
    if (!item) {
      return;
    }
    const detailView = { name: "speciesDetail", item, detail: undefined };
    this.#push(detailView);
    const signal = this.abortController.signal;
    const enriched = item.enriched ? Promise.resolve() : Biodiversity.enrichSpecies([item], signal);
    enriched
      .then(() => Biodiversity.getSpeciesDetail(item, this.bio.geometry, signal))
      .then((detail) => { detailView.detail = detail; })
      .catch((err) => { if (err.name !== "AbortError") { console.warn("[territoire] fiche espèce :", err); } detailView.detail = null; })
      .finally(() => {
        if (!signal.aborted && this.#currentView() === detailView) {
          this.#render();
        }
      });
  }

  #monthsChartHtml(d) {
    const max = Math.max(...d.months);
    if (!max) {
      return "<p class=\"territoryMuted territoryText\">Pas assez d'observations datées pour le moment.</p>";
    }
    const current = new Date().getMonth();
    const peak = d.months.indexOf(max);
    const bars = d.months.map((v, i) => `
      <span class="territoryMonth${i === current ? " territoryMonthCurrent" : ""}">
        <span class="territoryMonthBar"><span style="height:${Math.max(v ? 6 : 0, Math.round(v / max * 100))}%"></span></span>
        <span class="territoryMonthLabel">${MONTH_INITIALS[i]}</span>
      </span>`).join("");
    const scope = d.seasonScope === "france" ? "en France (trop peu d'observations datées ici)" : esc(this.#radiusText());
    return `
      <div class="territoryMonths" role="img" aria-label="Observations par mois, ${scope}. Le plus souvent en ${MONTH_NAMES[peak]}.">${bars}</div>
      <p class="territoryMuted territorySmall">Le plus souvent observée en <strong>${MONTH_NAMES[peak]}</strong> · observations par mois, ${scope}.</p>`;
  }

  #speciesDetailHtml(view) {
    const s = view.item;
    const d = view.detail;
    const group = SPECIES_GROUPS[s.group];
    const sci = this.#speciesSci(s);
    const loading = d === undefined ? "<p class=\"territoryMuted territoryText\" aria-busy=\"true\">Chargement…</p>" : "";

    const credit = d?.photoCredit
      ? `<p class="territoryMuted territorySmall territoryGalleryCaption">${d.photoCredit.shared ? "Photo partagée avec une observation : " : "Photo : "}<a class="territoryInlineLink" href="${esc(safeUrl(d.photoCredit.url))}" target="_blank" rel="noopener">${esc(d.photoCredit.text)}</a></p>`
      : "";

    const stats = `
      <div class="territoryStats">
        <div><span class="territoryInfoLabel">${d ? formatNumber(d.localCount) : "…"}</span><span class="territoryMuted territorySmall">observations partagées ${esc(this.#radiusText())} depuis ${this.bio.since}</span></div>
        ${s.iucn ? `<div><span class="territoryInfoLabel territoryIucnLabel">${this.#iucnPill(s)} ${esc(s.iucn.label)}</span><span class="territoryMuted territorySmall">Liste rouge mondiale de l'UICN</span></div>` : ""}
      </div>`;

    const contributors = d?.datasets?.length ? `
      <h3 class="territoryDetailH3">Observée ici grâce à</h3>
      <p class="territoryMuted territoryText">Chaque observation a été faite sur le terrain puis partagée par une personne : naturaliste, bénévole d'association, agent d'espace naturel ou simple promeneur.</p>
      <div class="territoryInfoCard">${d.datasets.map((ds) => `
        <div class="territoryInfoRow territoryDatasetRow">
          <a class="territoryExtLink" href="https://www.gbif.org/dataset/${encodeURIComponent(ds.key)}" target="_blank" rel="noopener">${esc(this.#datasetShort(ds.title))}</a>
          <span class="territoryMuted territorySmall">${formatNumber(ds.count)} obs.</span>
        </div>`).join("")}
      </div>` : "";

    const summary = d?.summary ? `
      ${this.#foldable("Description", d.summary.text)}
      <p class="territoryMuted territorySmall">Extrait de <a class="territoryInlineLink" href="${esc(safeUrl(d.summary.url))}" target="_blank" rel="noopener">Wikipédia</a> (licence CC BY-SA).</p>` : "";

    return `
      ${this.#subHeader(group.label)}
      <div class="territoryDetail">
        ${this.#speciesMedia(s, "territorySpeciesHero", 800, 48)}
        ${credit}
        <h2 class="territoryDetailTitle">${esc(this.#speciesName(s))}</h2>
        <p class="territoryMuted territorySmall territoryDetailKicker">${sci ? `<em class="territorySci">${esc(sci)}</em> · ` : ""}<strong>${esc(group.one)}</strong></p>
        <div class="territoryActions">
          <button type="button" class="territoryActionPill" data-action="species-map">${icon("map", 18)}Où l'observer ?</button>
        </div>
        ${stats}
        ${loading}
        ${d === null ? "<p class=\"territoryMuted territoryText\">Détails indisponibles pour le moment.</p>" : ""}
        ${d ? `<h3 class="territoryDetailH3">Quand l'observer ?</h3>${this.#monthsChartHtml(d)}` : ""}
        ${contributors}
        ${summary}
        <h3 class="territoryDetailH3">En savoir plus</h3>
        ${this.#linksHtml([
    s.taxref ? ["Fiche de l'espèce sur l'INPN", `https://inpn.mnhn.fr/espece/cd_nom/${encodeURIComponent(s.taxref)}`] : ["", null],
    ["Toutes les observations sur le GBIF", `https://www.gbif.org/species/${encodeURIComponent(s.key)}`],
  ])}
        <h3 class="territoryDetailH3">Vous l'avez vue ?</h3>
        <p class="territoryMuted territoryText">Partagez votre observation : elle enrichira la connaissance de la biodiversité d'ici et, une fois publiée sur le GBIF, pourra à son tour apparaître dans Cartes IGN.</p>
        ${this.#linksHtml(CONTRIBUTE_LINKS.slice(0, 2).map(([label, url]) => [label, url, "users2"]))}
        <p class="territoryMuted territorySmall territorySources">Observations : GBIF.org, données partagées par leurs contributeurs. Noms, statut et photo : Wikidata, Wikimedia Commons.</p>
      </div>`;
  }

  #bioAboutHtml() {
    const b = this.bio;
    const datasets = b?.datasets?.length ? `
      <h3 class="territoryDetailH3">Ici, les principales sources</h3>
      <div class="territoryInfoCard">${b.datasets.map((ds) => `
        <div class="territoryInfoRow territoryDatasetRow">
          <a class="territoryExtLink" href="https://www.gbif.org/dataset/${encodeURIComponent(ds.key)}" target="_blank" rel="noopener">${esc(this.#datasetShort(ds.title))}</a>
          <span class="territoryMuted territorySmall">${formatNumber(ds.count)} obs.</span>
        </div>`).join("")}
      </div>
      ${b.datasetCount > b.datasets.length ? `<p class="territoryMuted territorySmall">… sur ${esc(this.#datasetCountText())} au total, ${esc(this.#radiusText())}.</p>` : ""}` : "";
    return `
      ${this.#subHeader("D'où viennent ces données ?")}
      <div class="territoryDetail">
        <div class="territoryInfoCard territoryProtection">${icon("users2", 22)}<span><strong>Des observations collaboratives.</strong> Chaque espèce affichée a été observée sur le terrain, puis signalée volontairement par des naturalistes, des associations, des scientifiques, des agents d'espaces naturels et des citoyens.</span></div>
        <p class="territoryMuted territoryParagraph">Ces observations sont rassemblées par le <strong>GBIF</strong> (Système mondial d'information sur la biodiversité), une infrastructure internationale de données ouvertes soutenue par les pays participants, dont la France. Les plateformes de sciences participatives et les organismes naturalistes ou de recherche y publient leurs données.</p>
        ${datasets}
        <h3 class="territoryDetailH3">À garder en tête</h3>
        <ul class="territoryRefs">
          <li>Ce n'est pas un inventaire complet : une espèce peut vivre ici sans avoir jamais été signalée.</li>
          <li>Les espèces faciles à voir ou très suivies, comme les oiseaux, sont plus souvent signalées que les autres.</li>
          <li>La localisation des espèces sensibles peut être volontairement imprécise, pour les protéger.</li>
          <li>Sont retenues les observations des ${new Date().getFullYear() - (b?.since || 0)} dernières années, ${esc(this.#radiusText())} du point.</li>
        </ul>
        <h3 class="territoryDetailH3">Vous aussi, contribuez</h3>
        <p class="territoryMuted territoryParagraph">Une photo, un lieu, une date : chaque observation partagée enrichit la connaissance de la biodiversité de votre territoire et profite à tous.</p>
        ${this.#linksHtml(CONTRIBUTE_LINKS.map(([label, url]) => [label, url, "users2"]))}
        <h3 class="territoryDetailH3">Aller plus loin</h3>
        ${this.#linksHtml([
    ["Explorer avec BAM — Biodiversité autour de moi", bamUrl(this.position.lat, this.position.lng, b?.radius || 1000), "leaf"],
    ["Le GBIF", "https://www.gbif.org/fr/what-is-gbif", "globe"],
  ])}
        <p class="territoryMuted territorySmall territorySources">BAM est un outil libre des parcs nationaux des Écrins et des Cévennes ; Cartes IGN s'appuie sur les mêmes données ouvertes.</p>
      </div>`;
  }

  #showSpeciesMap(s) {
    this.clearMap();
    this.map.addSource(SPECIES_MAP_SOURCE, {
      type: "raster",
      tiles: [speciesTilesUrl(s.key)],
      tileSize: 512,
      attribution: "Observations : <a href=\"https://www.gbif.org\" target=\"_blank\">GBIF.org</a>",
    });
    this.map.addLayer({ id: SPECIES_MAP_SOURCE, type: "raster", source: SPECIES_MAP_SOURCE, paint: { "raster-opacity": 0.8 } });
    this.marker = new maplibregl.Marker({ color: "#26A581" }).setLngLat([this.position.lng, this.position.lat]).addTo(this.map);
    this.#reduceMenu();
    const zoom = { 1000: 12.5, 3000: 11, 10000: 9.5 }[this.bio?.radius] || 11;
    this.map.flyTo({ center: [this.position.lng, this.position.lat], zoom });
    Toast.show({ text: `${this.#speciesName(s)} : zones où l'espèce a été observée (GBIF)`, duration: "long", position: "bottom" }).catch(() => {});
  }

  /* ------------------------------------------------------------------------ */
  /* Actions                                                                   */
  /* ------------------------------------------------------------------------ */

  #listeners() {
    this.target.addEventListener("click", (evt) => {
      const el = evt.target.closest("[data-action]");
      if (!el || !this.target.contains(el)) {
        return;
      }
      this.#onAction(el.dataset.action, el);
    });
    // Bouton « Découvrir le territoire » du panneau position (Où suis-je ? / clic long)
    DOM.$positionWindow.addEventListener("click", (evt) => {
      const teaser = evt.target.closest(".territoryTeaser");
      if (!teaser) {
        return;
      }
      this.open({
        lat: Number(teaser.dataset.lat),
        lng: Number(teaser.dataset.lng),
        isUserPosition: teaser.dataset.user === "1",
        immersive: Globals.position?.immersivePosition || null,
      });
    });
    // La croix ferme le volet en entier (et non la sous-vue)
    DOM.$tabClose.addEventListener("click", () => {
      if (Globals.backButtonState.split("-")[0].split("%")[0] === "territory") {
        this.forceClose = true;
      }
    }, true);
  }

  #findItem(id) {
    return (this.places || []).find((p) => p.id === id) || (this.outings || []).find((o) => o.id === id);
  }

  #onAction(action, el) {
    const view = this.#currentView();
    switch (action) {
    case "back":
      if (!this.back()) {
        DOM.$tabClose.click();
      }
      break;
    case "list-places":
      this.#push({ name: "places", filter: "all" });
      break;
    case "list-outings":
      this.#push({ name: "outings", filter: "all" });
      break;
    case "list-species":
      this.#push({ name: "species", filter: "all", season: false });
      break;
    case "season":
      view.season = el.dataset.value === "season";
      view.expanded = {};
      this.#render();
      break;
    case "open-species":
      this.#openSpecies(el.dataset.id);
      break;
    case "bio-about":
      this.#push({ name: "bioAbout" });
      break;
    case "species-map":
      this.#showSpeciesMap(view.item);
      break;
    case "filter":
      view.filter = el.dataset.value;
      view.expanded = {};
      this.#render();
      break;
    case "more":
      view.expanded = view.expanded || {};
      view.expanded[el.dataset.value] = (view.expanded[el.dataset.value] || 0) + 10;
      this.#render();
      break;
    case "open-place":
    case "open-outing": {
      const item = this.#findItem(el.dataset.id);
      if (item) {
        this.#push({ name: action === "open-place" ? "place" : "outing", item });
      }
      break;
    }
    case "read-more": {
      const paragraph = el.previousElementSibling;
      paragraph.classList.toggle("territoryFolded");
      el.textContent = paragraph.classList.contains("territoryFolded") ? "Lire plus" : "Lire moins";
      break;
    }
    case "show-on-map":
      this.#showOnMap(view.item);
      break;
    case "show-group":
      this.#showGroup(el.dataset.value);
      break;
    case "directions":
      this.#directions(view.item);
      break;
    case "share":
      this.#share(view.item);
      break;
    case "copy-address":
      Clipboard.write({ string: view.item.address }).then(() => {
        Toast.show({ text: "Adresse copiée", duration: "short", position: "bottom" });
      }).catch(() => {});
      break;
    case "compare":
      this.#openCompare();
      break;
    case "news":
    case "all-news":
      this.#openNews(action === "news" ? Number(el.dataset.id) : null);
      break;
    default:
      break;
    }
  }

  #ensureHighlightLayers() {
    if (this.map.getSource(HIGHLIGHT_SOURCE)) {
      return;
    }
    this.map.addSource(HIGHLIGHT_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    this.map.addLayer({
      id: `${HIGHLIGHT_SOURCE}-line`,
      type: "line",
      source: HIGHLIGHT_SOURCE,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": "#26A581", "line-width": 5, "line-opacity": 0.9 },
      layout: { "line-cap": "round", "line-join": "round" },
    });
    this.map.addLayer({
      id: `${HIGHLIGHT_SOURCE}-points`,
      type: "circle",
      source: HIGHLIGHT_SOURCE,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 7,
        "circle-color": "#26A581",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
  }

  #reduceMenu() {
    Globals.currentScrollIndex = 1;
    Globals.menu.updateScrollAnchors();
  }

  #showOnMap(item) {
    this.clearMap();
    this.#ensureHighlightLayers();
    const features = [];
    let bounds = null;
    if (item.kind === "trek" && item.raw?.geometry) {
      try {
        const geometry = JSON.parse(item.raw.geometry);
        const coords = geometry.type === "MultiLineString" ? geometry.coordinates.flat() : geometry.coordinates;
        features.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords.map((c) => [c[0], c[1]]) }, properties: {} });
        bounds = coords.reduce((b, c) => b.extend([c[0], c[1]]), new maplibregl.LngLatBounds([coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]));
      } catch {
        bounds = null;
      }
    }
    this.map.getSource(HIGHLIGHT_SOURCE).setData({ type: "FeatureCollection", features });
    this.marker = new maplibregl.Marker({ color: "#26A581" }).setLngLat([item.lng, item.lat]).addTo(this.map);
    this.#showOutingLayer(item);
    this.#reduceMenu();
    if (bounds) {
      this.map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
    } else {
      this.map.flyTo({ center: [item.lng, item.lat], zoom: Math.max(this.map.getZoom(), 16) });
    }
  }

  /**
   * Affiche la couche de l'appli correspondant à la sortie (« Idées rando » pour une randonnée,
   * « Animations locales » pour un événement), comme si on l'ajoutait depuis le catalogue
   */
  #showOutingLayer(item) {
    const layerId = OUTING_LAYERS[item.kind];
    const catalogue = Globals.manager?.layerCatalogue;
    const element = layerId && document.getElementById(layerId);
    if (!catalogue || !element) {
      return;
    }
    if (!element.classList.contains("selectedLayer")) {
      catalogue.addLayer(layerId);
    }
    // garde le tracé sélectionné au-dessus de la couche ajoutée
    const raiseHighlight = () => {
      [`${HIGHLIGHT_SOURCE}-line`, `${HIGHLIGHT_SOURCE}-points`].forEach((id) => {
        if (this.map.getLayer(id)) {
          this.map.moveLayer(id);
        }
      });
    };
    this.map.once("idle", raiseHighlight);
    setTimeout(raiseHighlight, 1500);
  }

  #showGroup(theme) {
    this.clearMap();
    this.#ensureHighlightLayers();
    const items = (this.places || []).filter((p) => p.theme === theme);
    if (!items.length) {
      return;
    }
    this.map.getSource(HIGHLIGHT_SOURCE).setData({
      type: "FeatureCollection",
      features: items.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] }, properties: { name: p.name } })),
    });
    const bounds = items.reduce((b, p) => b.extend([p.lng, p.lat]), new maplibregl.LngLatBounds([items[0].lng, items[0].lat], [items[0].lng, items[0].lat]));
    bounds.extend([this.position.lng, this.position.lat]);
    this.#reduceMenu();
    this.map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
  }

  #directions(item) {
    Globals.menu.open("directions");
    const target = Globals.directions.dom.inputArrival;
    target.dataset.coordinates = `[${item.lng},${item.lat}]`;
    target.value = item.name;
    if (Globals.directions.dom.inputArrival.value && Globals.directions.dom.inputDeparture.value) {
      Globals.directions.dom.buttonCompute.classList.remove("disabled");
    }
  }

  #share(item) {
    const url = `https://cartes-ign.ign.fr?lng=${item.lng.toFixed(6)}&lat=${item.lat.toFixed(6)}&z=16&titre=${encodeURIComponent(item.name)}`;
    Share.share({
      title: item.name,
      text: `${item.name}${item.address ? `\n${item.address}` : ""}\nÀ découvrir dans l'application Cartes IGN :`,
      url,
      dialogTitle: "Partager",
    }).catch(() => {});
  }

  #openCompare() {
    const rlt = this.#nearestComparePoi();
    if (!rlt || !Globals.comparePoi) {
      return;
    }
    Globals.comparePoi.setData({ ...rlt, id: rlt.id ?? -1 });
    Globals.comparePoi.showWindow();
  }

  #openNews(newsId) {
    Globals.menu.open("newsfeed");
    if (newsId === null || Number.isNaN(newsId)) {
      return;
    }
    if (!NewsFeed.generated) {
      NewsFeed.generate();
    }
    setTimeout(() => {
      const elem = document.getElementById(`newsfeedItem-${newsId}`);
      if (elem) {
        elem.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 300);
  }
}

export default Territory;
