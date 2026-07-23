// Transforme data/activités.xlsx en src/data/lieux.json (consommé par le site).
// Le classeur reste la source de vérité : on ne modifie jamais le .xlsx ici.
//
//   node scripts/build-data.mjs
//
// Étapes : lecture des 3 feuilles de lieux -> normalisation (catégories, âges,
// prix) -> ajout des coordonnées du cache de géocodage -> déduplication ->
// rattachement des alertes de fraîcheur documentées dans la feuille "Méthode".

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { lireSources } from './sources.mjs';

const CACHE = new URL('../data/geocache.json', import.meta.url);
const HORAIRES_OSM = new URL('../data/horaires-osm.json', import.meta.url);
const OUT_DIR = new URL('../src/data/', import.meta.url);
const OUT = new URL('lieux.json', OUT_DIR);

// Genève et sa couronne. Tout point hors de cette boîte vient d'un géocodage
// parti dans le décor (homonyme en France ou ailleurs en Suisse) : on l'écarte.
const BBOX = { latMin: 46.05, latMax: 46.4, lonMin: 5.85, lonMax: 6.35 };

/* ------------------------------------------------------------------ */
/* Catégories                                                          */
/* ------------------------------------------------------------------ */

// Chaque catégorie canonique : libellé affiché, emoji, couleur du marqueur.
// Teintes pastel, volontairement claires : l'interface pose toujours du texte
// sombre par-dessus, jamais du blanc.
const CATEGORIES = {
  parcs: { label: 'Parcs & aires de jeux', emoji: '🌳', couleur: '#8fc79b' },
  eau: { label: "Pataugeoires & jeux d'eau", emoji: '💦', couleur: '#8fcbe8' },
  piscines: { label: 'Piscines & baignade', emoji: '🏊', couleur: '#6fb8d8' },
  sport: { label: 'Sport & mouvement', emoji: '🏃', couleur: '#7ec8c2' },
  evenement: { label: 'Événements de saison', emoji: '⛺', couleur: '#f2a65a' },
  couvert: { label: 'Jeux couverts', emoji: '🎪', couleur: '#f5a58d' },
  biblio: { label: 'Bibliothèques & ludothèques', emoji: '📚', couleur: '#b4a4dc' },
  musees: { label: 'Musées & culture', emoji: '🏛️', couleur: '#dfc48d' },
  spectacles: { label: 'Théâtres & spectacles', emoji: '🎭', couleur: '#eaa3c2' },
  animaux: { label: 'Animaux', emoji: '🐐', couleur: '#c8ad87' },
  nature: { label: 'Balades & nature', emoji: '🥾', couleur: '#aecb8d' },
  ateliers: { label: 'Activités & ateliers', emoji: '🎨', couleur: '#f4bc85' },
  cinema: { label: 'Cinémas', emoji: '🎬', couleur: '#a1abdd' },
  grillades: { label: 'Grillades & pique-nique', emoji: '🔥', couleur: '#eda58e' },
  cafes: { label: 'Cafés & restaurants', emoji: '☕', couleur: '#d2ae97' },
  parents: { label: 'Accueil parents-enfants', emoji: '🤱', couleur: '#f2acc0' },
};

// Catégories reconnues à la lecture mais écartées de la carte : la carte vise
// le loisir en famille.
//   bebe , tables à langer et salles d'allaitement d'aéroport, de gare ou de
//           centre commercial : des commodités, pas des destinations.
//   sante, cliniques, consultations imad, gardes pédiatriques : on n'y va pas
//           pour le plaisir.
const CATEGORIES_EXCLUES = new Set(['bebe', 'sante']);

// Les trois feuilles n'utilisent pas le même vocabulaire ni la même casse.
// Clé = libellé source en minuscules.
const MAP_CATEGORIE = {
  'parcs & aires de jeux': 'parcs',
  "pataugeoires & jeux d'eau": 'eau',
  'activités sportives & aquatiques': 'sport',
  'sport & aquatique': 'sport',
  'piscines & baignade': 'piscines',
  'sport & mouvement': 'sport',
  'événements de saison': 'evenement',
  escalade: 'sport',
  'pumptrack & skate': 'sport',
  'aire de jeux couverte': 'couvert',
  'trampolines & parkour': 'couvert',
  'parc de loisirs': 'couvert',
  'bibliothèques & ludothèques': 'biblio',
  librairie: 'biblio',
  'musées & culture': 'musees',
  'théâtres & spectacles': 'spectacles',
  'concerts jeune public': 'spectacles',
  animaux: 'animaux',
  'balades & nature': 'nature',
  activités: 'ateliers',
  'cours de cuisine & ateliers': 'ateliers',
  'cours de langue': 'ateliers',
  cinémas: 'cinema',
  'grillades & pique-nique': 'grillades',
  'cafés & restaurants bébé-friendly': 'cafes',
  'accueil parents-enfants': 'parents',
  santé: 'sante',
  'espace bébé & allaitement': 'bebe',
};

// « Sport & aquatique » du classeur mélange la natation et le reste. On sépare
// sur le nom : ce qui parle d'eau part en piscines, le reste en sport.
const MOTS_AQUATIQUES =
  /piscine|natation|nageur|nage\b|aquatique|aqua|baignade|nautique|bains?\b|swim|plage|dauphin/i;

function categorie(brut, nom) {
  const key = MAP_CATEGORIE[(brut || '').toLowerCase().trim()];
  if (key === 'sport') return MOTS_AQUATIQUES.test(nom) ? 'piscines' : 'sport';
  if (key) return key;
  // Deux lignes de la feuille Services sont sans catégorie (crèches).
  if (/crèche|vie enfantine/i.test(nom)) return 'parents';
  return 'ateliers';
}

/* ------------------------------------------------------------------ */
/* Champs                                                              */
/* ------------------------------------------------------------------ */

// "0-12+" -> { min: 0, max: 12, ouvert: true } ; "Adultes" -> null
function parseAge(brut) {
  const s = (brut || '').trim();
  if (!s || /adulte/i.test(s)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)(\+)?$/.exec(s);
  if (m) {
    return { min: Math.floor(Number(m[1])), max: Number(m[2]), ouvert: Boolean(m[3]) };
  }
  const seul = /^(\d+)(\+)?$/.exec(s);
  if (seul) return { min: Number(seul[1]), max: Number(seul[1]), ouvert: Boolean(seul[2]) };
  return null;
}

const PRIX = { gratuit: 'gratuit', payant: 'payant', mixte: 'mixte' };
const LIEU = {
  intérieur: 'interieur',
  extérieur: 'exterieur',
  'int./ext.': 'les_deux',
};

function nombre(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null; // Number('') vaut 0 : à écarter avant la conversion
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Aujourd'hui, à minuit, pour comparer des dates sans se soucier de l'heure.
const AUJOURDHUI = new Date(new Date().toISOString().slice(0, 10));

/**
 * Période d'un événement daté. `statut` vaut 'encours', 'avenir' ou 'termine' ;
 * les étapes terminées sont retirées plus bas.
 */
function periode(debut, fin) {
  const d = (debut || '').trim();
  const f = (fin || '').trim();
  if (!d && !f) return null;

  const dd = d ? new Date(d) : null;
  const df = f ? new Date(f) : dd;
  const statut = df && df < AUJOURDHUI ? 'termine' : dd && dd > AUJOURDHUI ? 'avenir' : 'encours';
  return { debut: d, fin: f, statut };
}

/**
 * Nettoie un texte venu d'une source : espaces superflus et tirets cadratins,
 * que le classeur emploie abondamment dans les noms (« 372 Natation , Cours à
 * domicile ») et qu'on ne veut nulle part sur le site.
 */
function net(v) {
  return String(v ?? '')
    .replace(/\s+—\s+/g, ', ')
    .replace(/—/g, ',')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,+/g, ',')
    .trim();
}

function tags(r) {
  return (r['Tags affichés'] || '')
    .split('/')
    .map((t) => net(t))
    .filter(Boolean);
}

const sansAccents = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

// Clé de rapprochement pour la déduplication : nom sans accents, ponctuation
// ni articles, afin que "À L'Eau" et "A l'eau" se rejoignent.
function cle(nom) {
  return sansAccents(nom)
    .replace(/\bmuseum\b/g, 'musee') // « Musée » / « Muséum » d'histoire naturelle
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(le|la|les|de|des|du|l|d|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Alertes de fraîcheur (feuille « Méthode & lacunes », 22.07.2026)     */
/* ------------------------------------------------------------------ */

const ALERTES = [
  {
    // cle() supprime les articles isolés : on teste le nom, pas la clé.
    test: (l) => /mus(ee|eum).*histoire naturelle/.test(sansAccents(l.nom)),
    niveau: 'ferme',
    texte:
      'Fermé depuis janvier 2024 (infestation de vrillettes). Réouverture progressive annoncée dès 2028.',
  },
  {
    test: (l) => l.categorie === 'parents',
    niveau: 'attention',
    texte:
      'La plupart des espaces parents-enfants et haltes-jeux ferment pendant les vacances scolaires. À vérifier avant de se déplacer.',
  },
  {
    test: (l) => l.categorie === 'grillades',
    niveau: 'saisonnier',
    texte: 'Emplacement saisonnier : ouvert de fin mai à septembre.',
  },
  {
    test: (l) => l.categorie === 'eau',
    niveau: 'saisonnier',
    texte: "Pataugeoires et jeux d'eau sont saisonniers (ouverture estivale).",
  },
];

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const SOURCES = lireSources();

const lieux = [];
const stats = { total: 0, geocodes: 0, sansGps: 0, doublons: 0, horsZone: 0, exclus: 0 };

for (const { lignes, type, origine } of SOURCES) {
  for (const r of lignes) {
    const nom = net(r['Nom']);
    if (!nom) continue;

    const cat = categorie(r['Catégorie'] || r['Catégorie suggérée'], nom);
    if (CATEGORIES_EXCLUES.has(cat)) {
      stats.exclus++;
      continue;
    }
    stats.total++;

    const adresse = net(r['Adresse vérifiée (Google)'] || r['Adresse']);
    let lat = nombre(r['Latitude']);
    let lon = nombre(r['Longitude']);
    let precision = lat && lon ? 'exacte' : null;

    // Complète depuis le cache de géocodage quand la feuille n'a pas de GPS.
    if ((lat === null || lon === null) && cache[adresse]) {
      lat = cache[adresse].lat;
      lon = cache[adresse].lon;
      precision = cache[adresse].precision === 'rue' ? 'approchee' : 'geocodee';
    }

    if (lat !== null && lon !== null) {
      const dedans =
        lat >= BBOX.latMin && lat <= BBOX.latMax && lon >= BBOX.lonMin && lon <= BBOX.lonMax;
      if (!dedans) {
        stats.horsZone++;
        lat = lon = precision = null;
      }
    }

    if (lat === null) stats.sansGps++;
    else if (precision !== 'exacte') stats.geocodes++;

    const commune =
      net(r['Commune']) ||
      /,\s*\d{4}\s+([^,]+)$/.exec(adresse)?.[1]?.trim() ||
      '';

    lieux.push({
      id: '',
      nom,
      type,
      origine,
      categorie: cat,
      // L'emoji découle de la seule catégorie. La colonne « Emoji » du
      // classeur est incohérente (une goutte d'eau sur des cours de yoga, un
      // nageur sur un pumptrack) et donnait une carte illisible.
      emoji: CATEGORIES[cat].emoji,
      age: parseAge(r['Âge']),
      ageBrut: net(r['Âge']),
      prix: PRIX[(r['Prix'] || '').toLowerCase().trim()] ?? null,
      tarifPrecis: net(r['Tarif précis']),
      lieu: LIEU[(r['Intérieur/Extérieur'] || '').toLowerCase().trim()] ?? null,
      adresse,
      codePostal: net(r['Code postal']),
      commune,
      lat,
      lon,
      precision,
      tags: tags(r),
      telephone: net(r['Téléphone']),
      horaires: net(r['Horaires']) === 'Non publiés' ? '' : net(r['Horaires']),
      // Les notes et nombres d'avis Google du classeur ne sont pas repris :
      // choix éditorial, on ne classe pas les sorties par étoiles.
      periode: periode(r['Début'], r['Fin']),
      site: net(r['Site web']),
      accessibilite: net(r['Accessibilité poussette/PMR']),
      remarque: net(r['Remarque']),
      alertes: [],
    });
  }
}

// Déduplication : la feuille « Méthode » signale plusieurs doublons entre
// sources. On fusionne sur le nom normalisé en gardant la fiche la plus
// complète et en récupérant les champs manquants de l'autre.
const parCle = new Map();
const complet = (l) =>
  (l.lat !== null ? 4 : 0) + (l.horaires ? 2 : 0) + (l.telephone ? 1 : 0) + (l.site ? 1 : 0);

for (const l of lieux) {
  const k = `${l.type}:${cle(l.nom)}`;
  const deja = parCle.get(k);
  if (!deja) {
    parCle.set(k, l);
    continue;
  }
  stats.doublons++;
  const [garde, autre] = complet(l) > complet(deja) ? [l, deja] : [deja, l];
  for (const champ of [
    'telephone', 'horaires', 'site', 'tarifPrecis', 'accessibilite', 'remarque', 'adresse',
  ]) {
    if (!garde[champ] && autre[champ]) garde[champ] = autre[champ];
  }
  if (garde.lat === null && autre.lat !== null) {
    garde.lat = autre.lat;
    garde.lon = autre.lon;
    garde.precision = autre.precision;
  }
  if (!garde.tags.length) garde.tags = autre.tags;
  parCle.set(k, garde);
}

// Une étape d'événement déjà passée n'a plus rien à faire sur la carte.
const finaux = [...parCle.values()].filter((l) => l.periode?.statut !== 'termine');
stats.termines = parCle.size - finaux.length;

// Identifiants stables (utilisés dans l'URL : #lieu=parc-la-grange).
const vus = new Set();
for (const l of finaux) {
  let base = cle(l.nom).replace(/\s+/g, '-') || 'lieu';
  let id = base;
  let n = 2;
  while (vus.has(id)) id = `${base}-${n++}`;
  vus.add(id);
  l.id = id;

  for (const a of ALERTES) {
    if (a.test(l)) l.alertes.push({ niveau: a.niveau, texte: a.texte });
  }
}

// Horaires récupérés d'OpenStreetMap (voir scripts/horaires-osm.mjs). Ils ne
// remplacent jamais un horaire déjà renseigné, ils comblent les vides.
const horairesOsm = existsSync(HORAIRES_OSM) ? JSON.parse(readFileSync(HORAIRES_OSM, 'utf8')) : {};
stats.horaires = 0;
for (const l of finaux) {
  if (!l.horaires && horairesOsm[l.id]) {
    l.horaires = horairesOsm[l.id].horaires;
    l.horairesSource = 'osm';
    stats.horaires++;
  }
}

finaux.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

const communes = [...new Set(finaux.map((l) => l.commune).filter(Boolean))].sort((a, b) =>
  a.localeCompare(b, 'fr')
);

const payload = {
  genereLe: new Date().toISOString().slice(0, 10),
  verifieLe: '2026-07-22', // date de la vérification manuelle (feuille Méthode)
  categories: CATEGORIES,
  communes,
  stats: {
    lieux: finaux.length,
    sorties: finaux.filter((l) => l.type === 'sortie').length,
    services: finaux.filter((l) => l.type === 'service').length,
    cartographies: finaux.filter((l) => l.lat !== null).length,
    sansGps: finaux.filter((l) => l.lat === null).length,
  },
  lieux: finaux,
};

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(payload) + '\n');

console.log(
  `${payload.stats.lieux} lieux écrits (${payload.stats.sorties} sorties, ${payload.stats.services} services)\n` +
    `  cartographiés : ${payload.stats.cartographies}, sans GPS : ${payload.stats.sansGps}\n` +
    `  doublons fusionnés : ${stats.doublons}, points hors zone écartés : ${stats.horsZone}\n` +
    `  écartés (hors loisir : santé, espaces bébé) : ${stats.exclus}\n` +
    `  étapes d'événement terminées : ${stats.termines}\n` +
    `  horaires complétés depuis OSM : ${stats.horaires}`
);
