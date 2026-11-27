/**
 * Copyright (c) Institut national de l'information géographique et forestière
 *
 * This program and the accompanying materials are made available under the terms of the GPL License, Version 3.0.
 */

/**
 * Territoire survolé : à quel territoire appartient le centre de la carte ?
 *
 * Par défaut la commune, remplacée par un zonage plus parlant quand on s'y trouve
 * (forêt domaniale, parc national, parc naturel régional). Les zonages sont décrits
 * dans ZONE_TYPES et l'ordre de ce tableau donne leur priorité : en ajouter un revient
 * à ajouter une entrée.
 *
 * Pour que le survol reste fluide sans multiplier les requêtes :
 * - la France est découpée en dalles de 0,05° (≈ 5 × 4 km) ; pour une dalle, une seule requête WFS
 *   (plusieurs requêtes dans un même appel) ramène TOUTES les communes et zones qui la touchent,
 *   avec leur géométrie ;
 * - ensuite tout se calcule sur l'appareil (point dans polygone) : tant que la carte reste dans des
 *   dalles déjà connues, le survol ne génère aucune requête ;
 * - les objets déjà en cache sont exclus des requêtes suivantes (un parc national n'est téléchargé
 *   qu'une fois, même s'il couvre des centaines de dalles) ;
 * - communes et parcs viennent de la BD CARTO (géométries généralisées, ~5 à 15 ko par commune) ;
 *   les forêts domaniales n'existent qu'à la précision de la BD TOPO (jusqu'à plusieurs centaines
 *   de ko) : elles font l'objet d'une requête à part pour ne pas retarder l'affichage de la commune.
 */

const WFS = "https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&outputFormat=json&srsName=EPSG:4326&maxFeatures=300";

/** Taille des dalles (degrés) */
export const TILE_SIZE = 0.05;

/** Nombre maximal de dalles gardées en mémoire (les plus anciennes sont oubliées) */
export const MAX_TILES = 150;

/**
 * Commune : toujours demandée (elle donne le département, et sert de repli)
 */
export const COMMUNE_TYPE = {
  id: "commune",
  typeName: "BDCARTO_V5:commune",
  properties: ["cleabs", "nom_officiel", "code_insee", "code_postal", "code_insee_du_departement", "population"],
  request: "light",
};

/**
 * Zonages qui remplacent la commune quand le centre de la carte s'y trouve, par ordre de priorité
 * (le plus local d'abord).
 * - request : « light » (requête principale) ou « heavy » (requête séparée, géométries lourdes)
 * - accept(props) : l'objet relève-t-il de ce zonage ?
 * - toZone(props) : { name, kicker } à afficher
 */
export const ZONE_TYPES = [
  {
    id: "foret",
    label: "Forêt domaniale",
    typeName: "BDTOPO_V3:foret_publique",
    properties: ["cleabs", "nature", "toponyme"],
    cql: "nature='Forêt domaniale'",
    request: "heavy",
    accept: (p) => p.nature === "Forêt domaniale" && !!p.toponyme,
    toZone: (p) => ({ name: normalizeZoneName(p.toponyme), kicker: "Forêt domaniale" }),
  },
  {
    id: "parc-national",
    label: "Parc national",
    typeName: "BDCARTO_V5:parc_ou_reserve",
    properties: ["cleabs", "nature", "toponyme"],
    cql: "nature IN ('Parc national','Parc naturel régional')",
    request: "light",
    // cœur de parc (les réserves intégrales, incluses dans le cœur, sont ignorées)
    accept: (p) => p.nature === "Parc national" && !!p.toponyme && !/^aire d['’]adh[ée]sion/i.test(p.toponyme.trim())
      && !/^r[ée]serve/i.test(p.toponyme.trim()),
    toZone: (p) => ({ name: normalizeZoneName(p.toponyme), kicker: "Cœur de parc national" }),
  },
  {
    id: "parc-national-adhesion",
    label: "Parc national (aire d'adhésion)",
    // même type d'objet que le cœur : déjà ramené par la requête du cœur
    shares: "parc-national",
    accept: (p) => p.nature === "Parc national" && /^aire d['’]adh[ée]sion/i.test(String(p.toponyme || "").trim()),
    toZone: (p) => ({
      name: normalizeZoneName(String(p.toponyme).trim().replace(/^aire d['’]adh[ée]sion d[ue]s?\s+/i, "")),
      kicker: "Aire d'adhésion du parc national",
    }),
  },
  {
    id: "pnr",
    label: "Parc naturel régional",
    shares: "parc-national",
    accept: (p) => p.nature === "Parc naturel régional" && !!p.toponyme,
    toZone: (p) => ({ name: normalizeZoneName(p.toponyme), kicker: "Parc naturel régional" }),
  },
];

/** Types d'objets réellement demandés au WFS (une requête par type, regroupées par « request ») */
export const QUERY_TYPES = [COMMUNE_TYPE, ...ZONE_TYPES.filter((t) => !t.shares)];

/* -------------------------------------------------------------------------- */
/* Libellés                                                                    */
/* -------------------------------------------------------------------------- */

/** Départements et collectivités d'outre-mer (code INSEE → nom) */
export const DEPARTEMENTS = {
  "01": "Ain", "02": "Aisne", "03": "Allier", "04": "Alpes-de-Haute-Provence", "05": "Hautes-Alpes",
  "06": "Alpes-Maritimes", "07": "Ardèche", "08": "Ardennes", "09": "Ariège", "10": "Aube",
  "11": "Aude", "12": "Aveyron", "13": "Bouches-du-Rhône", "14": "Calvados", "15": "Cantal",
  "16": "Charente", "17": "Charente-Maritime", "18": "Cher", "19": "Corrèze", "2A": "Corse-du-Sud",
  "2B": "Haute-Corse", "21": "Côte-d'Or", "22": "Côtes-d'Armor", "23": "Creuse", "24": "Dordogne",
  "25": "Doubs", "26": "Drôme", "27": "Eure", "28": "Eure-et-Loir", "29": "Finistère",
  "30": "Gard", "31": "Haute-Garonne", "32": "Gers", "33": "Gironde", "34": "Hérault",
  "35": "Ille-et-Vilaine", "36": "Indre", "37": "Indre-et-Loire", "38": "Isère", "39": "Jura",
  "40": "Landes", "41": "Loir-et-Cher", "42": "Loire", "43": "Haute-Loire", "44": "Loire-Atlantique",
  "45": "Loiret", "46": "Lot", "47": "Lot-et-Garonne", "48": "Lozère", "49": "Maine-et-Loire",
  "50": "Manche", "51": "Marne", "52": "Haute-Marne", "53": "Mayenne", "54": "Meurthe-et-Moselle",
  "55": "Meuse", "56": "Morbihan", "57": "Moselle", "58": "Nièvre", "59": "Nord",
  "60": "Oise", "61": "Orne", "62": "Pas-de-Calais", "63": "Puy-de-Dôme", "64": "Pyrénées-Atlantiques",
  "65": "Hautes-Pyrénées", "66": "Pyrénées-Orientales", "67": "Bas-Rhin", "68": "Haut-Rhin", "69": "Rhône",
  "70": "Haute-Saône", "71": "Saône-et-Loire", "72": "Sarthe", "73": "Savoie", "74": "Haute-Savoie",
  "75": "Paris", "76": "Seine-Maritime", "77": "Seine-et-Marne", "78": "Yvelines", "79": "Deux-Sèvres",
  "80": "Somme", "81": "Tarn", "82": "Tarn-et-Garonne", "83": "Var", "84": "Vaucluse",
  "85": "Vendée", "86": "Vienne", "87": "Haute-Vienne", "88": "Vosges", "89": "Yonne",
  "90": "Territoire de Belfort", "91": "Essonne", "92": "Hauts-de-Seine", "93": "Seine-Saint-Denis",
  "94": "Val-de-Marne", "95": "Val-d'Oise",
  "971": "Guadeloupe", "972": "Martinique", "973": "Guyane", "974": "La Réunion", "975": "Saint-Pierre-et-Miquelon",
  "976": "Mayotte", "977": "Saint-Barthélemy", "978": "Saint-Martin",
};

/** « Hautes-Alpes (05) » */
export function departementLabel(code) {
  if (!code) {
    return "";
  }
  const name = DEPARTEMENTS[code];
  return name ? `${name} (${code})` : `(${code})`;
}

/**
 * Normalise les toponymes de la BD TOPO / BD CARTO, écrits avec des majuscules à chaque mot
 * pour la partie générique : « Parc Naturel Régional du Vexin Français » → « Parc naturel régional du Vexin Français »
 */
export function normalizeZoneName(name) {
  let value = String(name || "").replace(/\s+/g, " ").trim();
  const generic = [
    [/^parc naturel r[ée]gional\b/i, "Parc naturel régional"],
    [/^parc national\b/i, "Parc national"],
    [/^parc amazonien\b/i, "Parc amazonien"],
    [/^for[êe]t domaniale\b/i, "Forêt domaniale"],
  ];
  for (const [re, replacement] of generic) {
    if (re.test(value)) {
      value = value.replace(re, replacement);
      break;
    }
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function splitPostcodes(value) {
  return String(value || "").split(/[^0-9AB]+/i).filter((cp) => /^[0-9][0-9AB][0-9]{3}$/i.test(cp));
}

/**
 * Commune au format attendu par le volet « Mon territoire » (voir territory-data.getCommune)
 */
export function toCommune(props) {
  if (!props?.nom_officiel) {
    return null;
  }
  const codeDepartement = props.code_insee_du_departement || "";
  return {
    name: props.nom_officiel,
    population: Number(props.population) || null,
    codeInsee: props.code_insee,
    postcodes: splitPostcodes(props.code_postal),
    codeDepartement,
    departement: DEPARTEMENTS[codeDepartement] || "",
  };
}

/* -------------------------------------------------------------------------- */
/* Géométrie                                                                   */
/* -------------------------------------------------------------------------- */

/** Clé de la dalle contenant un point */
export function tileKey(lat, lng, size = TILE_SIZE) {
  return `${Math.floor(lat / size)}/${Math.floor(lng / size)}`;
}

/** Emprise d'une dalle : [minLat, minLng, maxLat, maxLng] */
export function tileBounds(key, size = TILE_SIZE) {
  const [i, j] = key.split("/").map(Number);
  const r = (v) => Math.round(v * 1e6) / 1e6;
  return [r(i * size), r(j * size), r((i + 1) * size), r((j + 1) * size)];
}

/** Liste des polygones (anneaux [lng, lat]) d'une géométrie GeoJSON Polygon / MultiPolygon */
function polygonsOf(geometry) {
  if (!geometry) {
    return [];
  }
  if (geometry.type === "Polygon") {
    return [geometry.coordinates];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates;
  }
  return [];
}

/** Emprise d'une géométrie : [minLng, minLat, maxLng, maxLat] */
export function geometryBbox(geometry) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  polygonsOf(geometry).forEach((polygon) => {
    (polygon[0] || []).forEach(([x, y]) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
  });
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Le point (lng, lat) est-il dans la géométrie (trous compris) ? */
export function pointInGeometry(lng, lat, geometry, bbox = null) {
  if (bbox && (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3])) {
    return false;
  }
  return polygonsOf(geometry).some((polygon) => {
    if (!polygon.length || !inRing(lng, lat, polygon[0])) {
      return false;
    }
    for (let k = 1; k < polygon.length; k++) {
      if (inRing(lng, lat, polygon[k])) {
        return false;
      }
    }
    return true;
  });
}

function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/* -------------------------------------------------------------------------- */
/* Requêtes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * URL WFS regroupant une requête par type d'objet (WFS 1.1.0 : typeName et propertyName
 * séparés par des virgules / parenthèses, CQL_FILTER séparés par des points-virgules)
 * @param {Array} types types (COMMUNE_TYPE ou entrées de ZONE_TYPES)
 * @param {string} key dalle
 * @param {Object<string, string[]>} exclude identifiants (cleabs) déjà en cache, par type
 */
export function buildTileUrl(types, key, exclude = {}) {
  const [minLat, minLng, maxLat, maxLng] = tileBounds(key);
  // axe lat/lon pour l'EPSG:4326 dans les filtres CQL de la Géoplateforme (comme Point(lat lon))
  const bbox = `BBOX(geometrie,${minLat},${minLng},${maxLat},${maxLng})`;
  const filters = types.map((type) => {
    const parts = [bbox];
    if (type.cql) {
      parts.push(type.cql);
    }
    const ids = exclude[type.id] || [];
    if (ids.length) {
      parts.push(`NOT (cleabs IN (${ids.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(",")}))`);
    }
    return parts.join(" AND ");
  });
  const typeNames = types.map((t) => t.typeName).join(",");
  const propertyNames = types.map((t) => `(${[...t.properties, "geometrie"].join(",")})`).join("");
  return `${WFS}&typeName=${encodeURIComponent(typeNames)}&propertyName=${encodeURIComponent(propertyNames)}`
    + `&CQL_FILTER=${encodeURIComponent(filters.join(";"))}`;
}

/** Type demandé d'où vient un objet GeoJSON (son id est « nom_du_type.N ») */
function typeOfFeature(feature, types) {
  const prefix = String(feature.id || "").split(".")[0];
  return types.find((t) => t.typeName.split(":")[1] === prefix) || null;
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Index local des communes et zones, alimenté dalle par dalle
 */
export class ZoneIndex {
  constructor({ fetchJson = defaultFetchJson, maxTiles = MAX_TILES } = {}) {
    this.fetchJson = fetchJson;
    this.maxTiles = maxTiles;
    /** cleabs → { id, typeId, props, geometry, bbox, tiles: Set } */
    this.features = new Map();
    /** dalle → { light: "ok"|"pending"|"error", heavy: idem, at: date de la dernière utilisation, retryAt } */
    this.tiles = new Map();
    this.requests = 0;
  }

  /** État d'une dalle : "ready" (tout est là), "partial" (communes et parcs, forêts en cours), "pending", "error" ou "unknown" */
  tileState(key) {
    const tile = this.tiles.get(key);
    if (!tile) {
      return "unknown";
    }
    if (tile.light === "ok" && tile.heavy === "ok") {
      return "ready";
    }
    if (tile.light === "ok") {
      return tile.heavy === "error" ? "ready" : "partial";
    }
    if (tile.light === "error") {
      return Date.now() >= tile.retryAt ? "unknown" : "error";
    }
    return "pending";
  }

  /**
   * Charge une dalle (sans effet si elle est déjà chargée ou en cours)
   * @param {string} key
   * @param {AbortSignal} [signal]
   * @returns {{light: Promise<void>, done: Promise<void>}} light : communes et parcs arrivés ; done : toute la dalle
   */
  loadTile(key, signal) {
    const state = this.tileState(key);
    let tile = this.tiles.get(key);
    if (tile?.done && ["pending", "partial"].includes(state)) {
      return { light: tile.light$, done: tile.done };
    }
    if (state === "ready" || state === "error") {
      if (tile) {
        tile.at = Date.now();
      }
      const resolved = Promise.resolve();
      return { light: resolved, done: resolved };
    }
    tile = { light: "pending", heavy: "pending", at: Date.now(), lightAt: 0, retryAt: 0 };
    this.tiles.set(key, tile);
    this.#evict();

    const run = (requestKind) => {
      const types = QUERY_TYPES.filter((t) => t.request === requestKind);
      if (!types.length) {
        tile[requestKind] = "ok";
        return Promise.resolve();
      }
      const exclude = this.#knownIds(types, key);
      this.requests += 1;
      return this.fetchJson(buildTileUrl(types, key, exclude), signal)
        .then((json) => {
          this.#addFeatures(json?.features || [], types, key);
          // les objets déjà connus qui touchent la dalle y sont rattachés aussi
          this.#attachKnown(types, key);
          tile[requestKind] = "ok";
          if (requestKind === "light") {
            tile.lightAt = Date.now();
          }
        })
        .catch((err) => {
          tile[requestKind] = "error";
          if (requestKind === "light") {
            tile.retryAt = Date.now() + 20000;
          }
          throw err;
        });
    };

    const light = run("light");
    const heavy = run("heavy");
    tile.light$ = light.catch(() => {});
    tile.done = Promise.allSettled([light, heavy]).then((results) => {
      const failed = results.find((r) => r.status === "rejected" && r.reason?.name !== "AbortError");
      if (failed) {
        console.warn("[territoire survolé] dalle", key, failed.reason);
      }
      if (results.some((r) => r.reason?.name === "AbortError")) {
        // dalle abandonnée : on la redemandera
        this.tiles.delete(key);
      }
    });
    return { light: tile.light$, done: tile.done };
  }

  /** Date d'arrivée des communes et parcs d'une dalle (0 si pas encore là) */
  lightArrival(key) {
    return this.tiles.get(key)?.lightAt || 0;
  }

  /**
   * Territoire au point : commune et zone prioritaire
   * @returns {{commune: Object|null, zone: Object|null, communeId: string|null}}
   */
  lookup(lat, lng) {
    const key = tileKey(lat, lng);
    const tile = this.tiles.get(key);
    if (tile) {
      tile.at = Date.now();
    }
    const hits = [];
    this.features.forEach((f) => {
      if (pointInGeometry(lng, lat, f.geometry, f.bbox)) {
        hits.push(f);
      }
    });
    const communeHit = hits.find((f) => f.typeId === COMMUNE_TYPE.id) || null;
    let zone = null;
    for (const type of ZONE_TYPES) {
      const source = type.shares || type.id;
      const hit = hits.find((f) => f.typeId === source && type.accept(f.props));
      if (hit) {
        zone = { id: `${type.id}:${hit.id}`, type: type.id, ...type.toZone(hit.props) };
        break;
      }
    }
    return {
      communeId: communeHit?.id || null,
      commune: communeHit ? toCommune(communeHit.props) : null,
      zone,
    };
  }

  #knownIds(types, key) {
    const bounds = tileBounds(key);
    const tileBbox = [bounds[1], bounds[0], bounds[3], bounds[2]];
    const exclude = {};
    this.features.forEach((f) => {
      if (types.some((t) => t.id === f.typeId) && bboxIntersects(f.bbox, tileBbox)) {
        (exclude[f.typeId] = exclude[f.typeId] || []).push(f.id);
      }
    });
    return exclude;
  }

  #addFeatures(features, types, key) {
    features.forEach((feature) => {
      const type = typeOfFeature(feature, types);
      const id = feature.properties?.cleabs;
      if (!type || !id || !feature.geometry) {
        return;
      }
      const bbox = geometryBbox(feature.geometry);
      if (!bbox) {
        return;
      }
      const known = this.features.get(id);
      if (known) {
        known.tiles.add(key);
        return;
      }
      this.features.set(id, { id, typeId: type.id, props: feature.properties, geometry: feature.geometry, bbox, tiles: new Set([key]) });
    });
  }

  #attachKnown(types, key) {
    const bounds = tileBounds(key);
    const tileBbox = [bounds[1], bounds[0], bounds[3], bounds[2]];
    this.features.forEach((f) => {
      if (types.some((t) => t.id === f.typeId) && bboxIntersects(f.bbox, tileBbox)) {
        f.tiles.add(key);
      }
    });
  }

  /** Oublie les dalles les moins récemment utilisées, et les objets qui ne servent plus à aucune dalle */
  #evict() {
    if (this.tiles.size <= this.maxTiles) {
      return;
    }
    const sorted = [...this.tiles.entries()]
      .filter(([, t]) => t.light !== "pending" && t.heavy !== "pending")
      .sort((a, b) => a[1].at - b[1].at);
    const toRemove = sorted.slice(0, this.tiles.size - this.maxTiles).map(([k]) => k);
    toRemove.forEach((k) => this.tiles.delete(k));
    this.features.forEach((f, id) => {
      toRemove.forEach((k) => f.tiles.delete(k));
      if (!f.tiles.size) {
        this.features.delete(id);
      }
    });
  }
}

async function defaultFetchJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

export default ZoneIndex;
