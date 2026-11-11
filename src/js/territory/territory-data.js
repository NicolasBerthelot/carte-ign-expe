/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Sources de données du volet « Mon territoire ».
 *
 * - Commune et département : Géoplateforme (ADMIN EXPRESS)
 * - Météo : Open-Meteo (modèles Météo-France AROME/ARPEGE), sans clé
 * - Lieux remarquables : jeux du ministère de la Culture sur data.gouv.fr (Mérimée, Muséofile,
 *   Maisons des illustres, Jardins remarquables). La recherche se fait par distance au point, sur
 *   les conversions Parquet publiées par data.gouv.fr (seules les colonnes utiles sont lues) ;
 *   le détail des monuments vient de l'API tabulaire. Géoplateforme (WMS vecteur IGNF_SITES-UNESCO,
 *   déjà utilisé par l'appli) pour l'UNESCO
 * - Sorties : Géoplateforme (PMTiles DATATOURISME.FMA et HIKING.GEOTREK, déjà utilisés par l'appli)
 */
import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

import requestUtils from "../utils/request-utils";
import { getParquetTable, nearestRows } from "./parquet-source";

const TABULAR_API = "https://tabular-api.data.gouv.fr/api/resources";

/** Identifiants des ressources data.gouv.fr (jeux du ministère de la Culture) */
const RESOURCES = {
  merimee: "3a52af4a-f9da-4dcc-8110-b07774dfb3bc",
  museofile: "5ccd6238-4fb0-4b2c-b14a-581909489320",
  illustres: "bd705a3d-e13e-4388-a0a1-100ed47cc85f",
  jardins: "49a648e5-ef47-41fe-aa18-9323a811c2c7",
};

/** Index des photos Mémoire par département (workflow « Mérimée photos », publié avec GitHub Pages) */
const PHOTO_INDEX_URL = "https://nicolasberthelot.github.io/carte-ign-expe/data/merimee-photos";
/** Stockage public des images POP (Mémoire, Muséofile) */
const POP_ASSETS = "https://popcorn-prd-perf-assets.s3.gra.io.cloud.ovh.net/";
export const MEMOIRE_IMAGE_BASE = `${POP_ASSETS}memoire/`;

/** Image redimensionnée par POP (les photos Muséofile peuvent dépasser 5 000 px) */
export function popResized(url, width = 640) {
  return `https://pop.culture.gouv.fr/_next/image?url=${encodeURIComponent(url)}&w=${width}&q=75`;
}

/** Photo d'un musée sur POP (présente pour environ 3 musées sur 4) */
export function museofileImageUrl(identifiant) {
  const id = encodeURIComponent(identifiant);
  return `${POP_ASSETS}museo/${id}/museofile${id}.jpg`;
}

const PMTILES = {
  events: "https://data.geopf.fr/chunk/telechargement/download/DATATOURISME.FMA/archive/data.pmtiles",
  treks: "https://data.geopf.fr/chunk/telechargement/download/HIKING.GEOTREK/archive/data.pmtiles",
};

export const PLACE_THEMES = {
  monument: { label: "Monument historique", group: "Monuments historiques" },
  unesco: { label: "UNESCO", group: "Patrimoine mondial de l'UNESCO" },
  illustres: { label: "Maison des illustres", group: "Maisons des illustres" },
  musee: { label: "Musée de France", group: "Musées" },
  jardin: { label: "Jardin remarquable", group: "Jardins remarquables" },
};

/* -------------------------------------------------------------------------- */
/* Utilitaires purs (testés unitairement)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Distance en mètres entre deux points (formule de haversine)
 */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * « 650 m », « 1,8 km », « 12 km »
 */
export function formatDistance(meters) {
  if (!Number.isFinite(meters)) {
    return "";
  }
  if (meters < 1000) {
    return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  }
  if (meters < 10000) {
    return `${(meters / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km`;
  }
  return `${Math.round(meters / 1000)} km`;
}

/**
 * « 2h15 », « 45 min » à partir d'une durée en heures
 */
export function formatHours(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) {
    return "";
  }
  const totalMinutes = Math.round(h * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  if (hh === 0) {
    return `${mm} min`;
  }
  return mm ? `${hh}h${String(mm).padStart(2, "0")}` : `${hh}h`;
}

/**
 * Lit des coordonnées « lat, lon » (format des jeux Culture)
 * @returns {{lat: number, lng: number}|null}
 */
export function parseLatLon(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const parts = value.split(",").map((s) => parseFloat(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  return { lat: parts[0], lng: parts[1] };
}

const FRENCH_MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function parseFrenchDate(str) {
  const m = /(\d{1,2})(?:er)?\s+([a-zéû]+)\s+(\d{4})/i.exec(str);
  if (!m) {
    return null;
  }
  const month = FRENCH_MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) {
    return null;
  }
  return new Date(Number(m[3]), month, Number(m[1]));
}

/**
 * Lit les plages de dates DATAtourisme : « Du 3 janvier 2026 au 26 décembre 2026 », « Le 12 novembre 2026 »
 * @returns {{start: Date, end: Date}|null}
 */
export function parseDateRange(dateRange) {
  if (!dateRange || typeof dateRange !== "string") {
    return null;
  }
  const range = /du\s+(.+?)\s+au\s+(.+)/i.exec(dateRange);
  if (range) {
    const end = parseFrenchDate(range[2]);
    let start = parseFrenchDate(range[1]);
    if (!start && end) {
      // « Du 3 au 26 décembre 2026 » / « Du 3 janvier au 26 décembre 2026 »
      const partial = /(\d{1,2})(?:er)?(?:\s+([a-zéû]+))?/i.exec(range[1]);
      if (partial) {
        const month = partial[2] ? FRENCH_MONTHS.indexOf(partial[2].toLowerCase()) : end.getMonth();
        start = new Date(end.getFullYear(), month >= 0 ? month : end.getMonth(), Number(partial[1]));
      }
    }
    if (start && end) {
      return { start, end };
    }
  }
  const single = parseFrenchDate(dateRange);
  if (single) {
    return { start: single, end: single };
  }
  return null;
}

/**
 * Transforme du HTML (descriptions des jeux de données) en texte brut
 */
export function htmlToText(html) {
  if (!html) {
    return "";
  }
  let value = html;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    // Les descriptions Maisons des illustres / Jardins sont des tableaux JSON de paragraphes HTML
    try {
      const arr = JSON.parse(value);
      if (Array.isArray(arr)) {
        value = arr.join("\n");
      }
    } catch {
      // ce n'était pas du JSON
    }
  }
  const withBreaks = String(value).replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, "\n");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/**
 * Normalise une valeur « liste » (tableau JSON, chaîne séparée par ; ou ,)
 */
export function toList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(String);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          return arr.filter(Boolean).map(String);
        }
      } catch {
        // pas du JSON
      }
    }
    return trimmed.split(/\s*;\s*/).filter(Boolean);
  }
  return [String(value)];
}

/**
 * Tuile WMTS Géoplateforme (PM) contenant un point, utilisée comme vignette
 */
export function tileImageUrl(lat, lng, zoom = 17, layer = "ORTHOIMAGERY.ORTHOPHOTOS") {
  const n = 2 ** zoom;
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  const format = layer.includes("PLANIGN") ? "image/png" : "image/jpeg";
  return `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&FORMAT=${format}&TILEMATRIX=${zoom}&TILEROW=${y}&TILECOL=${x}`;
}

/**
 * Plage de tuiles couvrant un cercle (rayon en km) à un niveau de zoom
 */
export function tilesAround(lat, lng, radiusKm, zoom) {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
  const n = 2 ** zoom;
  const toX = (lon) => Math.floor((lon + 180) / 360 * n);
  const toY = (la) => {
    const r = la * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  };
  const tiles = [];
  for (let x = toX(lng - dLng); x <= toX(lng + dLng); x++) {
    for (let y = toY(lat + dLat); y <= toY(lat - dLat); y++) {
      tiles.push({ z: zoom, x, y });
    }
  }
  return tiles;
}

/**
 * Code météo WMO → libellé et pictogramme
 */
export function weatherFromCode(code, isDay = true) {
  const c = Number(code);
  if (c === 0) return { label: "Ensoleillé", icon: isDay ? "sun" : "moon" };
  if ([1, 2].includes(c)) return { label: "Éclaircies", icon: isDay ? "cloudSun" : "cloud" };
  if (c === 3) return { label: "Couvert", icon: "cloud" };
  if ([45, 48].includes(c)) return { label: "Brouillard", icon: "cloud" };
  if (c >= 51 && c <= 67) return { label: "Pluie", icon: "rain" };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { label: "Neige", icon: "snow" };
  if (c >= 80 && c <= 82) return { label: "Averses", icon: "rain" };
  if (c >= 95) return { label: "Orage", icon: "storm" };
  return { label: "", icon: "cloud" };
}

/* -------------------------------------------------------------------------- */
/* Requêtes                                                                    */
/* -------------------------------------------------------------------------- */

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} pour ${url}`);
  }
  return response.json();
}

function splitPostcodes(value) {
  return String(value || "").split(/[^0-9AB]+/i).filter((cp) => /^[0-9][0-9AB][0-9]{3}$/i.test(cp));
}

/**
 * Commune et département du point
 */
export async function getCommune(lat, lng) {
  const [communes, departements] = await Promise.all([
    requestUtils.requestWfs(lat, lng, "LIMITES_ADMINISTRATIVES_EXPRESS.LATEST:commune",
      ["nom_officiel", "population", "code_insee", "code_postal", "code_insee_du_departement"], 0, "geometrie"),
    requestUtils.requestWfs(lat, lng, "LIMITES_ADMINISTRATIVES_EXPRESS.LATEST:departement",
      ["nom_officiel"], 0, "geometrie"),
  ]);
  if (!communes.length) {
    return null;
  }
  const [name, population, codeInsee, codePostal, codeDepartement] = communes[0];
  return {
    name,
    population: Number(population) || null,
    codeInsee,
    postcodes: splitPostcodes(codePostal),
    codeDepartement,
    departement: departements[0] || "",
  };
}

/**
 * Météo actuelle (Open-Meteo)
 */
export async function getWeather(lat, lng, signal) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`
    + "&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FParis&forecast_days=1";
  const json = await fetchJson(url, signal);
  const current = json.current || {};
  return {
    temperature: Math.round(current.temperature_2m),
    ...weatherFromCode(current.weather_code, current.is_day !== 0),
    max: json.daily?.temperature_2m_max ? Math.round(json.daily.temperature_2m_max[0]) : null,
    min: json.daily?.temperature_2m_min ? Math.round(json.daily.temperature_2m_min[0]) : null,
  };
}

async function tabular(resource, filters, columns, signal, pageSize = 200) {
  const params = new URLSearchParams({ page_size: String(pageSize) });
  Object.entries(filters).forEach(([key, value]) => params.append(key, value));
  if (columns) {
    params.append("columns", columns.join(","));
  }
  const json = await fetchJson(`${TABULAR_API}/${resource}/data/?${params.toString()}`, signal);
  return json.data || [];
}

const MERIMEE_COLUMNS = [
  "Reference", "Titre_editorial_de_la_notice", "Denomination_de_l_edifice", "Commune_forme_editoriale",
  "coordonnees_au_format_WGS84", "Adresse_forme_editoriale", "Statut_juridique_de_l_edifice",
  "Siecle_de_la_campagne_principale_de_construction", "Datation_de_l_edifice", "Typologie_de_la_protection",
  "Precision_de_la_protection", "Date_et_typologie_de_la_protection", "Historique", "Description_de_l_edifice",
  "Cadre_de_l_etude", "Lien_vers_la_base_Archiv_MH", "Domaine", "Departement_format_numerique",
];

function capitalize(str) {
  if (!str) {
    return "";
  }
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function merimeeToPlace(row) {
  const coords = parseLatLon(row.coordonnees_au_format_WGS84);
  if (!coords) {
    return null;
  }
  return {
    id: `merimee-${row.Reference}`,
    theme: "monument",
    name: row.Titre_editorial_de_la_notice || capitalize(row.Denomination_de_l_edifice),
    category: capitalize(row.Denomination_de_l_edifice),
    commune: row.Commune_forme_editoriale,
    address: row.Adresse_forme_editoriale,
    departement: row.Departement_format_numerique,
    ...coords,
    source: "Ministère de la Culture (Mérimée)",
    raw: row,
  };
}

function museofileToPlace(row) {
  const coords = parseLatLon(row.Coordonnees);
  if (!coords) {
    return null;
  }
  const photo = museofileImageUrl(row.Identifiant);
  return {
    id: `museo-${row.Identifiant}`,
    theme: "musee",
    image: popResized(photo, 640),
    photos: [{ url: photo, thumb: popResized(photo, 1080), credit: "Muséofile, ministère de la Culture" }],
    name: capitalize(row.Nom_officiel),
    category: "Musée de France",
    commune: row.Ville,
    address: [row.Adresse, [row.Code_postal, row.Ville].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    ...coords,
    source: "Ministère de la Culture (Muséofile)",
    raw: row,
  };
}

function labelToPlace(theme, row) {
  const lat = Number(row.latitude);
  const lng = Number(row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  const name = theme === "illustres" ? row.nom_mdi : row.nom_du_jardin;
  return {
    id: `${theme}-${row.id}`,
    theme,
    name,
    category: toList(row.types).join(", ") || PLACE_THEMES[theme].label,
    commune: capitalize((row.commune || "").toLowerCase()),
    address: row.adresse_entree_public || row.adresse_complete,
    lat,
    lng,
    source: "Ministère de la Culture",
    raw: row,
  };
}

/**
 * Requête WMS GetFeatureInfo couvrant tout un carré de ±radiusKm autour du point
 * (BUFFER couvre l'image entière) : permet de lister les objets des couches
 * Géoplateforme publiées uniquement en WMS vecteur, comme IGNF_SITES-UNESCO.
 */
export function wmsAroundUrl(layer, lat, lng, radiusKm, featureCount = 30) {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
  const bbox = [lat - dLat, lng - dLng, lat + dLat, lng + dLng].map((v) => v.toFixed(5)).join(",");
  return "https://data.geopf.fr/wms-v/ows?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo"
    + `&LAYERS=${layer}&QUERY_LAYERS=${layer}&STYLES=&CRS=EPSG:4326&BBOX=${bbox}`
    + `&WIDTH=101&HEIGHT=101&I=50&J=50&INFO_FORMAT=application/json&FEATURE_COUNT=${featureCount}&BUFFER=60`;
}

async function getUnesco(lat, lng, radiusKm, signal) {
  const json = await fetchJson(wmsAroundUrl("IGNF_SITES-UNESCO", lat, lng, radiusKm), signal);
  const byName = new Map();
  (json.features || []).forEach((feature) => {
    const p = feature.properties || {};
    const coords = feature.geometry?.type === "Point" ? feature.geometry.coordinates : [Number(p.x), Number(p.y)];
    if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
      return;
    }
    const place = {
      id: `unesco-${p.nom}-${coords.join(",")}`,
      theme: "unesco",
      name: p.nom,
      category: p.sous_titre || "Patrimoine mondial",
      commune: "",
      lat: coords[1],
      lng: coords[0],
      image: p.nom_image ? `https://data.geopf.fr/annexes/ressources/UNESCO/Unesco-Images-Redimentionnees/${encodeURIComponent(p.nom_image)}` : null,
      source: "UNESCO, IGN",
      raw: p,
    };
    place.distance = distanceMeters(lat, lng, place.lat, place.lng);
    // un même bien peut avoir plusieurs points (composantes) : on garde le plus proche
    const existing = byName.get(p.nom);
    if (!existing || existing.distance > place.distance) {
      byName.set(p.nom, place);
    }
  });
  return [...byName.values()];
}

/** Rayon et nombre maximal de lieux par jeu de données */
export const PLACES_RADIUS_KM = 20;
const PLACES_LIMITS = { monument: 60, musee: 30, illustres: 20, jardin: 20 };

const MERIMEE_INDEX_COLUMNS = ["Reference", "coordonnees_au_format_WGS84"];
const MUSEOFILE_COLUMNS = [
  "Identifiant", "Nom_officiel", "Adresse", "Code_postal", "Ville", "URL", "Telephone", "Domaine_thematique",
  "Histoire", "Atout", "Artiste", "Personnage_phare", "Interet", "Protection_batiment", "Coordonnees",
  "Date_arrete_attribution_appellation",
];
const numericCoords = (row) => ({ lat: Number(row.latitude), lng: Number(row.longitude) });

/**
 * Monuments historiques les plus proches : index Parquet (référence + coordonnées, ~1 Mo),
 * puis détail des notices retenues via l'API tabulaire
 */
async function getMonuments(lat, lng, signal) {
  const table = await getParquetTable(RESOURCES.merimee, MERIMEE_INDEX_COLUMNS,
    (row) => parseLatLon(row.coordonnees_au_format_WGS84));
  const hits = nearestRows(table, lat, lng, PLACES_RADIUS_KM, PLACES_LIMITS.monument);
  if (!hits.length) {
    return [];
  }
  const refs = hits.map((h) => h.row.Reference);
  const rows = await tabular(RESOURCES.merimee, { "Reference__in": refs.join(",") }, MERIMEE_COLUMNS, signal, refs.length);
  return rows.map(merimeeToPlace);
}

async function getNearest(resource, columns, getCoords, toPlace, limit, lat, lng) {
  const table = await getParquetTable(resource, columns, getCoords);
  return nearestRows(table, lat, lng, PLACES_RADIUS_KM, limit).map((h) => toPlace(h.row));
}

/**
 * Lieux remarquables autour d'un point, triés par distance
 * @returns {Promise<{places: Array, errors: Array<string>}>}
 */
export async function getPlaces(lat, lng, signal) {
  const jobs = [
    getMonuments(lat, lng, signal),
    getNearest(RESOURCES.museofile, MUSEOFILE_COLUMNS, (row) => parseLatLon(row.Coordonnees),
      museofileToPlace, PLACES_LIMITS.musee, lat, lng),
    getNearest(RESOURCES.illustres, undefined, numericCoords,
      (row) => labelToPlace("illustres", row), PLACES_LIMITS.illustres, lat, lng),
    getNearest(RESOURCES.jardins, undefined, numericCoords,
      (row) => labelToPlace("jardin", row), PLACES_LIMITS.jardin, lat, lng),
    getUnesco(lat, lng, 15, signal),
  ];
  const labels = ["Monuments historiques", "Musées", "Maisons des illustres", "Jardins remarquables", "UNESCO"];
  const results = await Promise.allSettled(jobs);
  const errors = [];
  const places = [];
  results.forEach((res, i) => {
    if (res.status === "fulfilled") {
      res.value.filter(Boolean).forEach((p) => places.push(p));
    } else if (res.reason?.name !== "AbortError") {
      console.warn(`[territoire] ${labels[i]} :`, res.reason);
      errors.push(labels[i]);
    }
  });
  places.forEach((p) => {
    p.distance = distanceMeters(lat, lng, p.lat, p.lng);
  });
  places.sort((a, b) => a.distance - b.distance);
  try {
    await attachMerimeePhotos(places, signal);
  } catch (err) {
    if (err.name !== "AbortError") {
      console.warn("[territoire] photos Mémoire :", err);
    }
  }
  return { places, errors };
}

/**
 * Photos d'une notice à partir d'un fichier d'index départemental
 * @param {{c: string[], p: Object<string, Array>}} index
 * @param {string} ref référence Mérimée (PA…, IA…, DN…)
 * @returns {Array<{url: string, credit: string}>}
 */
export function photosFromIndex(index, ref) {
  const entries = index?.p?.[ref] || [];
  return entries.map(([path, creditIndex]) => ({
    url: MEMOIRE_IMAGE_BASE + path,
    credit: index.c?.[creditIndex] || "",
  }));
}

const photoIndexCache = {};

function getPhotoIndex(departement, signal) {
  if (!photoIndexCache[departement]) {
    photoIndexCache[departement] = fetchJson(`${PHOTO_INDEX_URL}/${encodeURIComponent(departement)}.json`, signal)
      .catch((err) => {
        delete photoIndexCache[departement];
        throw err;
      });
  }
  return photoIndexCache[departement];
}

/**
 * Ajoute aux monuments historiques les photos de la base Mémoire (ministère de la Culture)
 */
export async function attachMerimeePhotos(places, signal) {
  const monuments = places.filter((p) => p.theme === "monument" && p.raw?.Reference);
  const departements = [...new Set(monuments.map((p) => String(p.departement || "").padStart(2, "0")).filter((d) => /^(\d{2}|2A|2B|97\d)$/.test(d)))];
  const indexes = {};
  await Promise.all(departements.map(async (dep) => {
    try {
      indexes[dep] = await getPhotoIndex(dep, signal);
    } catch (err) {
      if (err.name === "AbortError") {
        throw err;
      }
      console.warn(`[territoire] index photos ${dep} :`, err);
    }
  }));
  monuments.forEach((place) => {
    const index = indexes[String(place.departement || "").padStart(2, "0")];
    const photos = photosFromIndex(index, place.raw.Reference);
    if (photos.length) {
      place.photos = photos;
      place.image = photos[0].url;
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Sorties (PMTiles)                                                           */
/* -------------------------------------------------------------------------- */

const pmtilesCache = {};

async function readPmtilesFeatures(url, lat, lng, radiusKm) {
  if (!pmtilesCache[url]) {
    pmtilesCache[url] = new PMTiles(url);
  }
  const archive = pmtilesCache[url];
  const tiles = tilesAround(lat, lng, radiusKm, 10);
  const features = [];
  await Promise.all(tiles.map(async ({ z, x, y }) => {
    const tile = await archive.getZxy(z, x, y);
    if (!tile || !tile.data) {
      return;
    }
    const vt = new VectorTile(new PbfReader(new Uint8Array(tile.data)));
    Object.values(vt.layers).forEach((layer) => {
      for (let i = 0; i < layer.length; i++) {
        const geojson = layer.feature(i).toGeoJSON(x, y, z);
        if (geojson.geometry?.type === "Point") {
          features.push(geojson);
        }
      }
    });
  }));
  return features;
}

function eventToOuting(feature, today) {
  const p = feature.properties;
  const range = parseDateRange(p.dateRange);
  if (range && range.end < today) {
    return null;
  }
  const [lng, lat] = feature.geometry.coordinates;
  return {
    id: `event-${p.uri || p.title}`,
    kind: "event",
    name: p.title,
    commune: (p.address || "").replace(/^.*\b\d{5}\s+/, "") || "",
    address: p.address,
    dateRange: p.dateRange,
    start: range?.start || null,
    end: range?.end || null,
    ongoing: !!(range && range.start <= today),
    image: p.image_url || null,
    lat,
    lng,
    source: "DATAtourisme, ADN Tourisme",
    raw: p,
  };
}

function trekToOuting(feature) {
  const p = feature.properties;
  const [lng, lat] = feature.geometry.coordinates;
  let image;
  try {
    image = JSON.parse(p.medias || "[]")[0]?.url || null;
  } catch {
    image = null;
  }
  return {
    id: `trek-${p.uuid || p.id_local}`,
    kind: "trek",
    name: p.nom_itineraire,
    commune: (p.depart || "").split(",")[0],
    difficulty: p.difficulte_norm || p.difficulte || "",
    practice: p.pratique_norm || p.pratique || "",
    duration: formatHours(p.duree),
    length: p.longueur ? `${(p.longueur / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km` : (p.kilometers || ""),
    ascent: Number(p.denivele_positif) > 0 ? `+${Math.round(p.denivele_positif)} m` : "",
    image,
    lat,
    lng,
    source: p.producteur ? `Geotrek – ${p.producteur}` : "Geotrek",
    raw: p,
  };
}

/**
 * Sorties à proximité : événements DATAtourisme à venir ou en cours et randonnées Geotrek
 */
export async function getOutings(lat, lng, radiusKm = 15) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today.getTime() + 60 * 24 * 3600 * 1000);
  const [eventsRes, treksRes] = await Promise.allSettled([
    readPmtilesFeatures(PMTILES.events, lat, lng, radiusKm),
    readPmtilesFeatures(PMTILES.treks, lat, lng, radiusKm),
  ]);
  const errors = [];
  const seen = new Set();
  const outings = [];
  const add = (item) => {
    if (!item || seen.has(item.id)) {
      return;
    }
    item.distance = distanceMeters(lat, lng, item.lat, item.lng);
    if (item.distance > radiusKm * 1000) {
      return;
    }
    seen.add(item.id);
    outings.push(item);
  };
  if (eventsRes.status === "fulfilled") {
    eventsRes.value.map((f) => eventToOuting(f, today))
      .filter((e) => e && (!e.start || e.start <= horizon))
      .forEach(add);
  } else {
    console.warn("[territoire] événements :", eventsRes.reason);
    errors.push("Événements");
  }
  if (treksRes.status === "fulfilled") {
    treksRes.value.map(trekToOuting).forEach(add);
  } else {
    console.warn("[territoire] randonnées :", treksRes.reason);
    errors.push("Randonnées");
  }
  outings.sort((a, b) => a.distance - b.distance);
  return { outings, errors };
}

export default {
  getCommune,
  getWeather,
  getPlaces,
  getOutings,
};
