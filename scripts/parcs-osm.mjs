// Interroge OpenStreetMap (Overpass) pour lister les parcs, jardins et aires
// de jeux nommés du bassin genevois, puis écrit ceux qui manquent à la carte
// dans data/complement-parcs.csv.
//
//   node scripts/parcs-osm.mjs
//
// Le fichier produit est destiné à être relu et corrigé à la main : OSM nomme
// parfois des bandes de gazon « parc ». Relancer écrase le fichier.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { lireSources } from './sources.mjs';

const MIROIRS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Canton de Genève et Pays de Gex. On reste large ici et on filtre ensuite
// sur la commune retournée par OSM.
const BBOX = '46.10,5.90,46.45,6.33';

const REQUETE = `[out:json][timeout:180];
(
  way["leisure"="park"]["name"](${BBOX});
  relation["leisure"="park"]["name"](${BBOX});
  way["leisure"="garden"]["name"]["access"!="private"](${BBOX});
  way["leisure"="playground"]["name"](${BBOX});
  node["leisure"="playground"]["name"](${BBOX});
);
out center bb tags;`;

// OSM nomme « parc » ou « jardin » quantité de choses qui n'en sont pas :
// parvis d'église, cour d'immeuble, terrain de foot, bac à fleurs. On écarte
// ce qui, au vu du nom, n'est pas une destination de promenade.
const SANS_LETTRE = /^[\d\s.,'-]+$/;

const MOTS_REJETES =
  /cr[eè]che|[ée]cole|coll[eè]ge|[ée]glise|temple|ambassade|mission permanente|parking|cimeti[eè]re|d[ée]chet|h[oô]pital|clinique|EMS\b|football|terrain de sport|tennis|p[ée]tanque|centre[- ]ville|capsule|four communal|cour des|cour champendal|balan[cç]oire|potager|jardins? familiaux|jardins? ouvriers|all[ée]e|rond[- ]point|giratoire|par(vis|celle)|toiture|private/i;

// Agrès isolés nommés dans OSM : ils appartiennent à une aire de jeux, ils
// n'en sont pas une. Comparé au nom exact, en minuscules.
const AGRES = new Set([
  'toboggan', 'tyrolienne', 'petit train', 'pyramide de cordes', 'la pyramide',
  'les rocailles', "jeux d'enfants", 'jeux', 'aire de jeux',
]);

// Le périmètre annoncé : canton de Genève et Pays de Gex. Le cadre de la
// requête déborde forcément (Nyon, Annemasse, Saint-Julien) : on filtre ici.
const COMMUNES = new Set(
  [
    // Canton de Genève
    'Aire-la-Ville', 'Anières', 'Avully', 'Avusy', 'Bardonnex', 'Bellevue', 'Bernex',
    'Carouge', 'Cartigny', 'Céligny', 'Chancy', 'Chêne-Bougeries', 'Chêne-Bourg',
    'Choulex', 'Collex-Bossy', 'Collonge-Bellerive', 'Cologny', 'Confignon', 'Corsier',
    'Dardagny', 'Genève', 'Genthod', 'Le Grand-Saconnex', 'Grand-Saconnex', 'Gy',
    'Hermance', 'Jussy', 'Laconnex', 'Lancy', 'Meinier', 'Meyrin', 'Onex',
    'Perly-Certoux', 'Plan-les-Ouates', 'Pregny-Chambésy', 'Chambésy', 'Presinge',
    'Puplinge', 'Russin', 'Satigny', 'Soral', 'Thônex', 'Troinex', 'Vandœuvres',
    'Vernier', 'Versoix', 'Veyrier',
    // Pays de Gex
    'Cessy', 'Challex', 'Chevry', 'Chézery-Forens', 'Collonges', 'Crozet',
    'Divonne-les-Bains', 'Échenevex', 'Farges', 'Ferney-Voltaire', 'Gex', 'Grilly',
    'Léaz', 'Lélex', 'Mijoux', 'Ornex', 'Péron', 'Pougny', 'Prévessin-Moëns',
    'Saint-Genis-Pouilly', 'Saint-Jean-de-Gonville', 'Sauverny', 'Sergy', 'Thoiry',
    'Versonnex', 'Vesancy',
  ].map((c) => c.toLowerCase())
);

/** « Carouge GE » et « Carouge » désignent la même commune. */
const normCommune = (c) => c.replace(/\s+(GE|VD|CH)$/i, '').trim();

// Longueur minimale de la diagonale de l'emprise, en mètres. En dessous, un
// « parc » est un carré de pelouse : sans intérêt pour une sortie.
const TAILLE_MIN_PARC = 90;
const TAILLE_MIN_JARDIN = 70;

/** Diagonale approximative de l'emprise OSM, en mètres. */
function tailleM(e) {
  const b = e.bounds;
  if (!b) return null;
  const dLat = (b.maxlat - b.minlat) * 111320;
  const dLon =
    (b.maxlon - b.minlon) * 111320 * Math.cos(((b.maxlat + b.minlat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

async function interroger() {
  for (const url of MIROIRS) {
    try {
      process.stdout.write(`Interrogation de ${new URL(url).host}… `);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(REQUETE),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const texte = await res.text();
      if (!texte.trimStart().startsWith('{')) throw new Error('réponse non JSON');
      console.log('ok');
      return JSON.parse(texte);
    } catch (err) {
      console.log(`échec (${err.message})`);
    }
  }
  throw new Error('Aucun miroir Overpass disponible.');
}

/** Clé de comparaison, alignée sur celle de build-data.mjs. */
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

const donnees = await interroger();

// Ce qui est déjà connu, pour ne pas proposer de doublons.
const connus = new Set();
for (const { lignes } of lireSources()) {
  for (const r of lignes) if (r['Nom']) connus.add(cle(r['Nom']));
}

const echappeCsv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const vus = new Set();
const retenus = [];
const rejets = { deja: 0, nom: 0, taille: 0, doublon: 0 };

for (const e of donnees.elements) {
  const t = e.tags ?? {};
  const nom = (t.name || '').trim();
  if (!nom) continue;

  // Selon la combinaison d'options `out`, Overpass renvoie `center`, `bounds`,
  // ou les deux. On accepte les deux formes.
  const lat = e.lat ?? e.center?.lat ?? (e.bounds && (e.bounds.minlat + e.bounds.maxlat) / 2);
  const lon = e.lon ?? e.center?.lon ?? (e.bounds && (e.bounds.minlon + e.bounds.maxlon) / 2);
  if (lat == null || lon == null) continue;

  if (SANS_LETTRE.test(nom) || MOTS_REJETES.test(nom) || AGRES.has(nom.toLowerCase())) {
    rejets.nom++;
    continue;
  }

  const aireDeJeux = t.leisure === 'playground';
  // Une aire de jeux est petite par nature : on ne lui applique pas de seuil.
  if (!aireDeJeux) {
    const taille = tailleM(e);
    const seuil = t.leisure === 'garden' ? TAILLE_MIN_JARDIN : TAILLE_MIN_PARC;
    if (taille !== null && taille < seuil) {
      rejets.taille++;
      continue;
    }
  }

  const k = cle(nom);
  if (connus.has(k)) {
    rejets.deja++;
    continue;
  }
  if (vus.has(k)) {
    rejets.doublon++; // le même parc présent en way et en relation
    continue;
  }
  vus.add(k);

  retenus.push({
    nom,
    categorie: 'Parcs & aires de jeux',
    age: aireDeJeux ? '0-12+' : '',
    prix: 'Gratuit',
    lieu: 'Extérieur',
    adresse: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '),
    commune: (t['addr:city'] || '').trim(),
    tags: aireDeJeux ? 'Aire de jeux' : '',
    lat: Number(lat),
    lon: Number(lon),
    site: (t.website || '').trim(),
  });
}

retenus.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

/* --- Communes manquantes, par géocodage inverse Nominatim --- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'sorties-enfants-geneve/0.1 (carte des sorties famille, contact: barbarin.louise@gmail.com)';

// Cache des communes, pour qu'une seconde exécution ne réinterroge pas
// Nominatim. Clé : coordonnées arrondies à ~100 m.
const CACHE_COM = new URL('../data/communes-cache.json', import.meta.url);
const communes = existsSync(CACHE_COM) ? JSON.parse(readFileSync(CACHE_COM, 'utf8')) : {};
const cleCoord = (r) => `${r.lat.toFixed(3)},${r.lon.toFixed(3)}`;

const aCompleter = retenus.filter((r) => !r.commune && !(cleCoord(r) in communes));
console.log(
  `${aCompleter.length} communes à retrouver (environ ${Math.ceil((aCompleter.length * 1.1) / 60)} min)…`
);

for (const [i, r] of aCompleter.entries()) {
  await sleep(1100);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${r.lat}&lon=${r.lon}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    const a = (await res.json()).address ?? {};
    communes[cleCoord(r)] = (a.city || a.town || a.village || a.municipality || '').trim();
  } catch {
    communes[cleCoord(r)] = '';
  }
  if ((i + 1) % 25 === 0) {
    writeFileSync(CACHE_COM, JSON.stringify(communes, null, 1) + '\n');
    console.log(`  ${i + 1}/${aCompleter.length}`);
  }
}
writeFileSync(CACHE_COM, JSON.stringify(communes, null, 1) + '\n');

for (const r of retenus) {
  r.commune = normCommune(r.commune || communes[cleCoord(r)] || '');
}

// Hors périmètre annoncé (Nyon, Annemasse, Saint-Julien…).
const horsZone = retenus.filter((r) => !COMMUNES.has(r.commune.toLowerCase()));
const gardes = retenus.filter((r) => COMMUNES.has(r.commune.toLowerCase()));
retenus.length = 0;
retenus.push(...gardes);

const ENTETE =
  'Nom,Catégorie,Âge,Prix,Intérieur/Extérieur,Adresse,Code postal,Commune,Tags affichés,Latitude,Longitude,Téléphone,Horaires,Site web,Remarque';

const lignes = retenus.map((r) =>
  [
    r.nom, r.categorie, r.age, r.prix, r.lieu, r.adresse, '', r.commune, r.tags,
    r.lat.toFixed(6), r.lon.toFixed(6), '', '', r.site, '',
  ]
    .map(echappeCsv)
    .join(',')
);

writeFileSync(
  new URL('../data/complement-parcs.csv', import.meta.url),
  ENTETE + '\n' + lignes.join('\n') + '\n'
);

console.log(
  `${donnees.elements.length} objets OSM\n` +
    `  écartés : ${rejets.nom} sur le nom, ${rejets.taille} trop petits, ` +
    `${rejets.deja} déjà présents, ${rejets.doublon} doublons OSM\n` +
    `  hors canton GE et Pays de Gex : ${horsZone.length}\n` +
    `  retenus : ${retenus.length}`
);
