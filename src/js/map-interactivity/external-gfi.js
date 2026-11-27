/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Interrogation (GetFeatureInfo) de couches WMS hébergées hors Géoplateforme.
 *
 * Une couche WMS devient interrogeable au clic si sa configuration
 * (config/layers-config.json) contient un bloc "gfi" :
 *   "gfi": {
 *     "layer": "all.hs.query",                     // couche WMS à interroger
 *     "infoFormat": "application/vnd.ogc.gml",     // format de réponse
 *     "days": 7,                                   // fenêtre TIME (jours, optionnel)
 *     "renderer": "effisHotspot"                   // mise en forme de la fiche
 *   }
 *
 * Testé avec le MapServer GWIS/EFFIS (https://maps.effis.emergency.copernicus.eu/gwis),
 * qui renvoie les attributs en GML (le JSON n'y est pas supporté).
 */

// Taille (en pixels écran) de la fenêtre autour du clic
const HALF_WINDOW_PX = 50;
// Taille de l'image demandée pour la GetFeatureInfo : plus elle est petite,
// plus la tolérance du serveur (en pixels image) couvre de pixels écran.
// 21 px image pour 101 px écran → ~5 px écran par pixel image.
const GFI_IMAGE_SIZE = 21;
// Rayon (en pixels écran) dans lequel on cherche un pixel non transparent :
// les points chauds sont petits, surtout au doigt sur mobile.
const PIXEL_SEARCH_RADIUS = 12;

/**
 * Emprise EPSG:3857 de la fenêtre autour du clic
 * @param {Array<number>} mercatorCoords [x, y] du clic en EPSG:3857
 * @param {number} lat latitude du clic
 * @param {number} zoom niveau de zoom
 * @returns {Array<number>} [minx, miny, maxx, maxy]
 */
const clickBbox = (mercatorCoords, lat, zoom) => {
  // https://wiki.openstreetmap.org/wiki/Zoom_levels
  const resolution = 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom + 8);
  return [
    mercatorCoords[0] - HALF_WINDOW_PX * resolution,
    mercatorCoords[1] - HALF_WINDOW_PX * resolution,
    mercatorCoords[0] + HALF_WINDOW_PX * resolution,
    mercatorCoords[1] + HALF_WINDOW_PX * resolution,
  ];
};

/**
 * Ajoute les paramètres à une URL de service qui se termine par "?" ou "&"
 * @param {string} serverUrl
 * @param {string} params
 * @returns {string}
 */
const withParams = (serverUrl, params) => {
  const last = serverUrl.slice(-1);
  const sep = (last === "?" || last === "&") ? "" : (serverUrl.includes("?") ? "&" : "?");
  return `${serverUrl}${sep}${params}`;
};

/**
 * Paramètre TIME couvrant les `days` derniers jours (dates UTC)
 * @param {number} days
 * @param {Date} now
 * @returns {string} ex. "2026-11-21/2026-11-27"
 */
const timeRange = (days, now = new Date()) => {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
  return `${start}/${end}`;
};

/**
 * URL GetMap utilisée pour vérifier qu'il y a bien quelque chose sous le clic
 * @param {string} serverUrl
 * @param {string} layerName couche affichée
 * @param {Array<number>} bbox
 * @returns {string}
 */
const getMapUrl = (serverUrl, layerName, bbox) => {
  const size = 2 * HALF_WINDOW_PX + 1;
  return withParams(serverUrl,
    "SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&" +
    `LAYERS=${layerName}&STYLES=&` +
    "CRS=EPSG:3857&" +
    `BBOX=${bbox.join(",")}&` +
    `WIDTH=${size}&HEIGHT=${size}&` +
    "FORMAT=image/png&TRANSPARENT=true"
  );
};

/**
 * URL GetFeatureInfo (WMS 1.1.1, la version vérifiée sur le MapServer EFFIS)
 * @param {string} serverUrl
 * @param {Object} gfiConfig bloc "gfi" de la configuration de la couche
 * @param {Array<number>} bbox
 * @param {Date} now
 * @returns {string}
 */
const getFeatureInfoUrl = (serverUrl, gfiConfig, bbox, now = new Date()) => {
  const center = Math.floor(GFI_IMAGE_SIZE / 2);
  let params = "SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo&" +
    `LAYERS=${gfiConfig.layer}&QUERY_LAYERS=${gfiConfig.layer}&STYLES=&` +
    "SRS=EPSG:3857&" +
    `BBOX=${bbox.join(",")}&` +
    `WIDTH=${GFI_IMAGE_SIZE}&HEIGHT=${GFI_IMAGE_SIZE}&` +
    `X=${center}&Y=${center}&` +
    `INFO_FORMAT=${gfiConfig.infoFormat || "application/vnd.ogc.gml"}&` +
    "FEATURE_COUNT=20";
  if (gfiConfig.days) {
    params += `&TIME=${timeRange(gfiConfig.days, now)}`;
  }
  return withParams(serverUrl, params);
};

/**
 * Y a-t-il un pixel non transparent près du centre de l'image ?
 * @param {Uint8ClampedArray} rgba données de l'image (getImageData().data)
 * @param {number} width largeur de l'image
 * @param {number} radius rayon de recherche en pixels
 * @returns {boolean}
 */
const hasOpaquePixelNearCenter = (rgba, width, radius = PIXEL_SEARCH_RADIUS) => {
  const c = Math.floor(width / 2);
  for (let y = c - radius; y <= c + radius; y++) {
    for (let x = c - radius; x <= c + radius; x++) {
      if (x < 0 || y < 0 || x >= width || y >= width) {
        continue;
      }
      if ((x - c) ** 2 + (y - c) ** 2 > radius ** 2) {
        continue;
      }
      if (rgba[(y * width + x) * 4 + 3] !== 0) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Lit une réponse GML MapServer (msGMLOutput) :
 * <msGMLOutput><X_layer><X_feature><attr>valeur</attr>...</X_feature></X_layer></msGMLOutput>
 * @param {string} text
 * @returns {Array<Object>} une entrée par entité : propriétés texte (hors géométrie)
 */
const parseMapServerGml = (text) => {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return [];
  }
  const features = [];
  const all = doc.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!el.localName.endsWith("_feature")) {
      continue;
    }
    const properties = {};
    for (let j = 0; j < el.children.length; j++) {
      const child = el.children[j];
      // On ignore gml:boundedBy, et les géométries (éléments avec des enfants)
      if (child.prefix === "gml" || child.namespaceURI === "http://www.opengis.net/gml" || child.children.length > 0) {
        continue;
      }
      properties[child.localName] = child.textContent.trim();
    }
    features.push(properties);
  }
  return features;
};

/**
 * Premier attribut présent parmi une liste de noms possibles (insensible à la casse)
 * @param {Object} props
 * @param {Array<string>} names
 * @returns {string|null}
 */
const pick = (props, names) => {
  const keys = Object.keys(props);
  for (const name of names) {
    const key = keys.find((k) => k.toLowerCase() === name);
    if (key && props[key] !== "") {
      return props[key];
    }
  }
  return null;
};

const escapeHtml = (str) => String(str)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/**
 * Niveau de confiance normalisé
 * - VIIRS : "l"/"n"/"h" ou "low"/"nominal"/"high"
 * - MODIS : 0 à 100 (seuils FIRMS : < 30 faible, ≥ 80 élevée)
 * @param {string|null} raw
 * @returns {"low"|"nominal"|"high"|null}
 */
const normalizeConfidence = (raw) => {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const str = String(raw).trim().toLowerCase();
  const num = Number(str);
  if (!Number.isNaN(num)) {
    if (num < 30) return "low";
    if (num < 80) return "nominal";
    return "high";
  }
  if (str.startsWith("l")) return "low";
  if (str.startsWith("n")) return "nominal";
  if (str.startsWith("h")) return "high";
  return null;
};

const CONFIDENCE_LABELS = {
  low: "faible",
  nominal: "moyenne",
  high: "élevée",
};

const SATELLITE_LABELS = {
  "n": "Suomi NPP (VIIRS)",
  "s-npp": "Suomi NPP (VIIRS)",
  "snpp": "Suomi NPP (VIIRS)",
  "suomi": "Suomi NPP (VIIRS)",
  "n20": "NOAA-20 (VIIRS)",
  "noaa-20": "NOAA-20 (VIIRS)",
  "n21": "NOAA-21 (VIIRS)",
  "noaa-21": "NOAA-21 (VIIRS)",
  "t": "Terra (MODIS)",
  "terra": "Terra (MODIS)",
  "a": "Aqua (MODIS)",
  "aqua": "Aqua (MODIS)",
};

/**
 * Date et heure de détection, en heure de Paris quand c'est possible
 * @param {Object} props
 * @returns {string|null}
 */
const formatDetectionDate = (props) => {
  const date = pick(props, ["acq_date", "firedate", "date"]);
  if (!date) {
    return null;
  }
  let iso = date.trim().replace(" ", "T");
  const time = pick(props, ["acq_time", "firetime", "time"]);
  if (!iso.includes("T") && time && /^\d{3,4}$/.test(time)) {
    const hhmm = time.padStart(4, "0");
    iso += `T${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
  }
  if (!iso.includes("T")) {
    return escapeHtml(date);
  }
  // Les heures d'acquisition sont en UTC
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    iso += "Z";
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return escapeHtml(date);
  }
  return parsed.toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * Entité la plus proche du clic (si les entités portent lon/lat)
 * @param {Array<Object>} features
 * @param {{lng: number, lat: number}} lngLat
 * @returns {Object}
 */
const nearestFeature = (features, lngLat) => {
  let best = features[0];
  let bestDist = Infinity;
  for (const props of features) {
    const lon = Number(pick(props, ["lon", "longitude", "x"]));
    const lat = Number(pick(props, ["lat", "latitude", "y"]));
    if (Number.isNaN(lon) || Number.isNaN(lat)) {
      continue;
    }
    const d = (lon - lngLat.lng) ** 2 + (lat - lngLat.lat) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = props;
    }
  }
  return best;
};

/**
 * Fiche « point chaud » EFFIS / FIRMS
 * @param {Array<Object>} features entités renvoyées par la GetFeatureInfo
 * @param {{lng: number, lat: number}} lngLat clic
 * @returns {{title: string, html: string, html2: string, lngLat: Array<number>, count: number}|null}
 */
const renderEffisHotspot = (features, lngLat) => {
  if (!features || features.length === 0) {
    return null;
  }
  const props = nearestFeature(features, lngLat);
  const confidence = normalizeConfidence(pick(props, ["confidence", "conf"]));
  const dateStr = formatDetectionDate(props);
  const satRaw = pick(props, ["satellite", "sensor", "instrument"]);
  const satellite = satRaw ? (SATELLITE_LABELS[satRaw.toLowerCase()] || escapeHtml(satRaw)) : null;
  const frp = Number(pick(props, ["frp"]));
  const place = [pick(props, ["name_2"]), pick(props, ["name_1"])].filter(Boolean).map(escapeHtml).join(", ");

  let title = "<p class=\"positionTitle\">Point chaud détecté par satellite</p>";
  if (dateStr) {
    title += `<p class="positionTitle2"><span class="positionTitleDateicon"></span>${dateStr}</p>`;
  }

  let html = "<div class='positionHtmlBefore'>";
  if (confidence) {
    html += `Confiance de la détection : <strong>${CONFIDENCE_LABELS[confidence]}</strong><br/>`;
  }
  if (confidence === "low") {
    html += "<em>Détection peu fiable : il peut s'agir d'un faux positif (reflet du soleil, source de chaleur fixe…).</em><br/>";
  }
  if (satellite) {
    html += `Satellite : ${satellite}<br/>`;
  }
  if (!Number.isNaN(frp) && frp > 0) {
    html += `Puissance radiative du feu : ${frp.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} MW<br/>`;
  }
  if (place) {
    html += `Secteur : ${place}<br/>`;
  }
  if (features.length > 1) {
    html += `${features.length} détections à cet endroit sur les 7 derniers jours<br/>`;
  }
  html += "</div>";

  const html2 = "<div class='positionHtmlAfter'>" +
    "Un point chaud est une anomalie thermique : ce n'est pas forcément un incendie de forêt " +
    "(brûlage agricole, écobuage, site industriel…). Un point représente un pixel de 375 m (VIIRS) à 1 km (MODIS), " +
    "pas la taille du feu. En cas d'incendie, suivez les consignes des pompiers et de la préfecture.<br/>" +
    "Source : EFFIS / GWIS – Copernicus Emergency Management Service, d'après NASA FIRMS" +
    "</div>";

  const lon = Number(pick(props, ["lon", "longitude"]));
  const lat = Number(pick(props, ["lat", "latitude"]));
  const position = (!Number.isNaN(lon) && !Number.isNaN(lat) && pick(props, ["lon", "longitude"]) !== null)
    ? [lon, lat]
    : [lngLat.lng, lngLat.lat];

  return { title, html, html2, lngLat: position, count: features.length };
};

/**
 * Mise en forme générique : liste des attributs
 * @param {Array<Object>} features
 * @param {{lng: number, lat: number}} lngLat
 * @param {string} layerTitle
 * @returns {Object|null}
 */
const renderGeneric = (features, lngLat, layerTitle) => {
  if (!features || features.length === 0) {
    return null;
  }
  const props = nearestFeature(features, lngLat);
  let html = "<div>";
  for (const [key, value] of Object.entries(props)) {
    html += `<p>${escapeHtml(key)} : ${escapeHtml(value)}</p>`;
  }
  html += "</div>";
  return {
    title: `<p class="positionTitle">${escapeHtml(layerTitle || "")}</p>`,
    html,
    html2: "",
    lngLat: [lngLat.lng, lngLat.lat],
    count: features.length,
  };
};

const renderers = {
  effisHotspot: renderEffisHotspot,
};

/**
 * Met en forme la réponse selon le "renderer" configuré
 * @param {Object} gfiConfig
 * @param {Array<Object>} features
 * @param {{lng: number, lat: number}} lngLat
 * @param {string} layerTitle
 * @returns {Object|null}
 */
const render = (gfiConfig, features, lngLat, layerTitle) => {
  const fxt = renderers[gfiConfig.renderer];
  if (fxt) {
    return fxt(features, lngLat);
  }
  return renderGeneric(features, lngLat, layerTitle);
};

export default {
  GFI_IMAGE_SIZE,
  clickBbox,
  timeRange,
  getMapUrl,
  getFeatureInfoUrl,
  hasOpaquePixelNearCenter,
  parseMapServerGml,
  normalizeConfidence,
  renderEffisHotspot,
  render,
};
