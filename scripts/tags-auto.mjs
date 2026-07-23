// Propose des tags secondaires pour chaque lieu, à partir d'OpenStreetMap puis
// de Google Places.
//
//   npm run tags                    OSM seulement
//   GOOGLE_PLACES_API_KEY=… npm run tags    OSM + Google
//
// Un lieu garde UNE catégorie principale, celle qui détermine son icône. Les
// tags secondaires disent ce qu'on y trouve en plus : un parc où il y a aussi
// des animaux et des tables de pique-nique.
//
// Le résultat va dans data/tagscache.json, versionné. Relancer n'interroge que
// les lieux absents du cache ou dont le nom ou l'adresse a changé : le script
// est lent (1 requête/seconde côté OSM) et Google est facturé.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CACHE = new URL('../data/tagscache.json', import.meta.url);
const LIEUX = new URL('../src/data/lieux.json', import.meta.url);

const UA = 'sorties-enfants-geneve/0.1 (+https://sorties-enfants-geneve.netlify.app)';
// 30 m : à 50 m, en ville dense, une bibliothèque héritait des cafés et du
// parc du bout de la rue. On veut le même site, pas le même quartier.
const RAYON = 30;
const MIROIRS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/* ------------------------------------------------------------------ */
/* Correspondances vers les 16 catégories canoniques                   */
/* ------------------------------------------------------------------ */

// Clé = "cléOSM=valeur". Les identifiants à droite sont ceux de CATEGORIES
// dans build-data.mjs.
const OSM_VERS_CATEGORIE = {
  'leisure=playground': 'parcs',
  'leisure=park': 'parcs',
  'leisure=garden': 'parcs',
  'leisure=nature_reserve': 'nature',
  'landuse=forest': 'nature',
  'natural=beach': 'piscines',
  'leisure=swimming_pool': 'piscines',
  'leisure=water_park': 'eau',
  'amenity=fountain': 'eau',
  'leisure=sports_centre': 'sport',
  'leisure=fitness_centre': 'sport',
  'leisure=pitch': 'sport',
  'leisure=ice_rink': 'sport',
  'sport=climbing': 'sport',
  'tourism=zoo': 'animaux',
  'attraction=animal': 'animaux',
  'amenity=animal_shelter': 'animaux',
  'tourism=museum': 'musees',
  'tourism=gallery': 'musees',
  'historic=castle': 'musees',
  'historic=fort': 'musees',
  'amenity=theatre': 'spectacles',
  'amenity=arts_centre': 'spectacles',
  'amenity=cinema': 'cinema',
  'amenity=library': 'biblio',
  'shop=books': 'biblio',
  'shop=toys': 'biblio',
  'amenity=cafe': 'cafes',
  'amenity=restaurant': 'cafes',
  'amenity=ice_cream': 'cafes',
  'amenity=fast_food': 'cafes',
  'amenity=biergarten': 'cafes',
  'tourism=picnic_site': 'grillades',
  'amenity=bbq': 'grillades',
  'leisure=picnic_table': 'grillades',
  'amenity=community_centre': 'parents',
  'amenity=childcare': 'parents',
  'leisure=indoor_play': 'couvert',
  'leisure=trampoline_park': 'couvert',
  'leisure=amusement_arcade': 'couvert',
  'tourism=theme_park': 'couvert',
  'amenity=workshop': 'ateliers',
  'craft=pottery': 'ateliers',
};

// Types renvoyés par Google Places. Beaucoup sont trop génériques
// (point_of_interest, establishment) : ils ne figurent pas ici et sont ignorés.
const GOOGLE_VERS_CATEGORIE = {
  park: 'parcs',
  playground: 'parcs',
  campground: 'nature',
  hiking_area: 'nature',
  national_park: 'nature',
  zoo: 'animaux',
  aquarium: 'animaux',
  farm: 'animaux',
  museum: 'musees',
  art_gallery: 'musees',
  historical_landmark: 'musees',
  tourist_attraction: 'musees',
  library: 'biblio',
  book_store: 'biblio',
  movie_theater: 'cinema',
  performing_arts_theater: 'spectacles',
  cafe: 'cafes',
  restaurant: 'cafes',
  bakery: 'cafes',
  ice_cream_shop: 'cafes',
  gym: 'sport',
  fitness_center: 'sport',
  sports_complex: 'sport',
  stadium: 'sport',
  ice_skating_rink: 'sport',
  swimming_pool: 'piscines',
  water_park: 'eau',
  amusement_park: 'couvert',
  amusement_center: 'couvert',
  childrens_camp: 'couvert',
  community_center: 'parents',
  child_care_agency: 'parents',
  toy_store: 'biblio',
};

/* ------------------------------------------------------------------ */
/* Outils                                                              */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Clé de cache : même normalisation que le dédoublonnage de build-data. */
const cle = (nom) =>
  (nom || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bmuseum\b/g, 'musee')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(le|la|les|de|des|du|l|d|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Empreinte du lieu : si elle change, on réinterroge. */
const empreinte = (l) => `${l.nom}|${l.adresse}|${l.lat ?? ''},${l.lon ?? ''}`;

/* ------------------------------------------------------------------ */
/* Étape 1 : OpenStreetMap                                             */
/* ------------------------------------------------------------------ */

/**
 * Une seule requête Overpass pour tous les lieux : `around` accepte une liste
 * de coordonnées. Interroger 400 fois de suite serait absurde et impoli.
 */
async function interrogerOsm(lieux) {
  const filtres = Object.keys(OSM_VERS_CATEGORIE)
    .map((t) => {
      const [k, v] = t.split('=');
      return `  nwr["${k}"="${v}"](around:REMPLACER);`;
    })
    .join('\n');

  const resultats = new Map(); // id du lieu -> Set de catégories
  const paquets = [];
  for (let i = 0; i < lieux.length; i += 25) paquets.push(lieux.slice(i, i + 25));

  console.log(`OpenStreetMap : ${lieux.length} lieux en ${paquets.length} requêtes…`);

  for (const [n, paquet] of paquets.entries()) {
    // `around:rayon,lat1,lon1,lat2,lon2,…` couvre plusieurs points d'un coup.
    const points = paquet.map((l) => `${l.lat},${l.lon}`).join(',');
    const requete = `[out:json][timeout:120];\n(\n${filtres.replaceAll(
      'REMPLACER',
      `${RAYON},${points}`
    )}\n);\nout center tags;`;

    const objets = await requeteOverpass(requete);
    if (!objets) continue;

    // Overpass ne dit pas quel point a déclenché quel objet : on rattache par
    // distance, ce qui est fiable au vu du rayon employé.
    for (const o of objets) {
      const lat = o.lat ?? o.center?.lat;
      const lon = o.lon ?? o.center?.lon;
      if (lat == null) continue;
      for (const l of paquet) {
        if (distanceM(l.lat, l.lon, lat, lon) > RAYON * 1.5) continue;
        for (const [k, v] of Object.entries(o.tags ?? {})) {
          const cat = OSM_VERS_CATEGORIE[`${k}=${v}`];
          if (!cat) continue;
          if (!resultats.has(l.id)) resultats.set(l.id, new Set());
          resultats.get(l.id).add(cat);
        }
      }
    }

    if ((n + 1) % 5 === 0 || n === paquets.length - 1) {
      console.log(`  ${n + 1}/${paquets.length} requêtes`);
    }
    await sleep(1100); // politique d'usage d'Overpass
  }
  return resultats;
}

async function requeteOverpass(requete) {
  for (const url of MIROIRS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(requete),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const texte = await res.text();
      if (!texte.trimStart().startsWith('{')) throw new Error('réponse non JSON');
      return JSON.parse(texte).elements;
    } catch (err) {
      console.warn(`  ! ${new URL(url).host} : ${err.message}`);
      await sleep(2000);
    }
  }
  return null;
}

function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/* ------------------------------------------------------------------ */
/* Étape 2 : Google Places                                             */
/* ------------------------------------------------------------------ */

/**
 * Le classeur ne contient pas de place_id : chaque lieu doit donc être
 * retrouvé par son nom et sa position. Un seul appel suffit, Text Search
 * renvoyant déjà les `types`, ce qui évite un Place Details facturé en plus.
 */
async function interrogerGoogle(lieux, apiKey) {
  const resultats = new Map();
  let appels = 0;

  console.log(`Google Places : ${lieux.length} lieux, 1 appel chacun…`);

  for (const [n, l] of lieux.entries()) {
    const requete = {
      textQuery: `${l.nom} ${l.adresse || l.commune || 'Genève'}`,
      maxResultCount: 1,
      languageCode: 'fr',
      ...(l.lat !== null
        ? {
            locationBias: {
              circle: { center: { latitude: l.lat, longitude: l.lon }, radius: 200 },
            },
          }
        : {}),
    };

    try {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.types,places.displayName',
        },
        body: JSON.stringify(requete),
      });
      appels++;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const types = json.places?.[0]?.types ?? [];
      const cats = new Set();
      for (const t of types) if (GOOGLE_VERS_CATEGORIE[t]) cats.add(GOOGLE_VERS_CATEGORIE[t]);
      if (cats.size) resultats.set(l.id, cats);
    } catch (err) {
      console.warn(`  ! ${l.nom} : ${err.message}`);
    }

    if ((n + 1) % 25 === 0) console.log(`  ${n + 1}/${lieux.length}`);
    await sleep(120);
  }

  console.log(`Google Places : ${appels} appels facturés.`);
  return resultats;
}

/* ------------------------------------------------------------------ */
/* Exécution                                                           */
/* ------------------------------------------------------------------ */

if (!existsSync(LIEUX)) {
  console.error("src/data/lieux.json absent : lancer `npm run data` d'abord.");
  process.exit(1);
}

const tous = JSON.parse(readFileSync(LIEUX, 'utf8')).lieux;
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};

// À traiter : absents du cache, ou dont le nom ou l'adresse a bougé.
const aFaire = tous.filter((l) => {
  const e = cache[cle(l.nom)];
  return !e || e.empreinte !== empreinte(l);
});

console.log(`${tous.length} lieux, ${aFaire.length} à interroger (${tous.length - aFaire.length} en cache).\n`);

if (!aFaire.length) {
  console.log('Rien à faire.');
  process.exit(0);
}

const avecGps = aFaire.filter((l) => l.lat !== null);
const tagsOsm = avecGps.length ? await interrogerOsm(avecGps) : new Map();

const apiKeyGoogle = process.env.GOOGLE_PLACES_API_KEY;
let tagsGoogle = new Map();
if (apiKeyGoogle) {
  tagsGoogle = await interrogerGoogle(aFaire, apiKeyGoogle);
} else {
  console.log('\nGOOGLE_PLACES_API_KEY absente : étape Google ignorée.');
  console.log('Pour l\'activer : GOOGLE_PLACES_API_KEY=… npm run tags');
}

/* Fusion */

const LIBELLES = {
  parcs: 'Parcs & aires de jeux', eau: "Pataugeoires & jeux d'eau",
  piscines: 'Piscines & baignade', sport: 'Sport & mouvement',
  evenement: 'Événements de saison', couvert: 'Jeux couverts',
  biblio: 'Bibliothèques & ludothèques', musees: 'Musées & culture',
  spectacles: 'Théâtres & spectacles', animaux: 'Animaux',
  nature: 'Balades & nature', ateliers: 'Activités & ateliers',
  cinema: 'Cinémas', grillades: 'Grillades & pique-nique',
  cafes: 'Cafés & restaurants', parents: 'Accueil parents-enfants',
};

const horodatage = new Date().toISOString();
let avecTags = 0;

for (const l of aFaire) {
  const osm = tagsOsm.get(l.id) ?? new Set();
  const google = tagsGoogle.get(l.id) ?? new Set();
  const union = new Set([...osm, ...google]);
  union.delete(l.categorie); // pas de doublon avec la catégorie principale

  const sources = [osm.size && 'osm', google.size && 'google'].filter(Boolean);
  cache[cle(l.nom)] = {
    auto: [...union].map((c) => LIBELLES[c]).filter(Boolean).sort(),
    source: sources.join('+') || 'aucune',
    empreinte: empreinte(l),
    timestamp: horodatage,
  };
  if (union.size) avecTags++;
}

writeFileSync(CACHE, JSON.stringify(cache, null, 1) + '\n');
console.log(
  `\n${aFaire.length} lieux traités, ${avecTags} ont reçu au moins un tag.\n` +
    `Cache écrit dans data/tagscache.json. Lancer \`npm run data\` pour l'intégrer.`
);
