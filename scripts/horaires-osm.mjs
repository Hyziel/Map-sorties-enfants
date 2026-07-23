// Complète les horaires manquants depuis OpenStreetMap.
//
//   node scripts/horaires-osm.mjs
//
// Pour chaque lieu déjà cartographié mais sans horaires, on cherche dans OSM
// un objet portant `opening_hours` à moins de 150 m et dont le nom concorde.
// Le résultat va dans data/horaires-osm.json, relu par build-data.mjs.
//
// Un rapprochement par proximité peut se tromper : on exige donc que les noms
// se ressemblent, et on note la distance pour pouvoir vérifier après coup.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const SORTIE = new URL('../data/horaires-osm.json', import.meta.url);
const LIEUX = new URL('../src/data/lieux.json', import.meta.url);

const MIROIRS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const BBOX = '46.10,5.90,46.45,6.33';

// Seuils volontairement sévères. À 150 m et 50 % de mots communs, on récoltait
// les horaires du coiffeur d'à côté ou de la mairie qui héberge la
// bibliothèque. Mieux vaut vingt horaires sûrs que soixante douteux.
const DISTANCE_MAX = 80; // mètres
const RESSEMBLANCE_MIN = 0.8;

const REQUETE = `[out:json][timeout:240];
(
  node["opening_hours"]["name"](${BBOX});
  way["opening_hours"]["name"](${BBOX});
);
out center tags;`;

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

const mots = (s) =>
  new Set(
    (s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((m) => m.length > 3) // « de », « les », « parc » n'identifient rien
  );

/** Part des mots significatifs du nom OSM retrouvés dans le nom du lieu. */
function ressemblance(a, b) {
  const A = mots(a);
  const B = mots(b);
  if (!A.size || !B.size) return 0;
  let communs = 0;
  for (const m of A) if (B.has(m)) communs++;
  return communs / Math.min(A.size, B.size);
}

function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

// Certains bâtiments portent les horaires de leur bureau de vote. Rattachés à
// une bibliothèque ou une ludothèque, ils donnent « ouvert le dimanche
// 10h-12h », ce qui est faux et trompeur.
const HORAIRES_REJETES = /votation|[ée]lection/i;

/** « Mo-Fr 08:00-18:00 » -> « Lun-ven 8h-18h » */
function humaniser(oh) {
  const JOURS = {
    Mo: 'lun', Tu: 'mar', We: 'mer', Th: 'jeu', Fr: 'ven', Sa: 'sam', Su: 'dim',
  };
  const MOIS = {
    Jan: 'janv.', Feb: 'févr.', Mar: 'mars', Apr: 'avr.', May: 'mai', Jun: 'juin',
    Jul: 'juil.', Aug: 'août', Sep: 'sept.', Oct: 'oct.', Nov: 'nov.', Dec: 'déc.',
  };
  if (/^24\/7$/.test(oh.trim())) return 'Ouvert en permanence';

  let s = oh;
  // Les mois d'abord : « Mar » est à la fois mars et mardi en abrégé OSM, mais
  // un mois est toujours suivi d'un jour du mois ou d'un tiret de plage.
  for (const [en, fr] of Object.entries(MOIS)) {
    s = s.replace(new RegExp(`\\b${en}\\b(?=\\s*\\d|\\s*-\\s*[A-Z])`, 'g'), fr);
  }
  for (const [en, fr] of Object.entries(JOURS)) s = s.replaceAll(en, fr);
  s = s
    .replace(/(\d{1,2}):00/g, '$1h')
    .replace(/(\d{1,2}):(\d{2})/g, '$1h$2')
    .replace(/;\s*/g, ' ; ')
    .replace(/,\s*/g, ', ')
    .replace(/\boff\b/g, 'fermé')
    .replace(/\bPH\b/g, 'jours fériés')
    .replace(/\bSH\b/g, 'vacances scolaires');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

if (!existsSync(LIEUX)) {
  console.error('src/data/lieux.json absent : lancer `npm run data` d\'abord.');
  process.exit(1);
}

const lieux = JSON.parse(readFileSync(LIEUX, 'utf8')).lieux;
const cibles = lieux.filter((l) => l.lat !== null && !l.horaires);
console.log(`${cibles.length} lieux cartographiés sans horaires.`);

const donnees = await interroger();
const candidats = donnees.elements
  .map((e) => ({
    nom: e.tags?.name ?? '',
    oh: e.tags?.opening_hours ?? '',
    lat: e.lat ?? e.center?.lat,
    lon: e.lon ?? e.center?.lon,
  }))
  .filter((c) => c.nom && c.oh && c.lat != null && !HORAIRES_REJETES.test(c.oh));

console.log(`${candidats.length} objets OSM avec horaires dans la zone.`);

const trouves = {};
let ambigus = 0;

for (const l of cibles) {
  let meilleur = null;

  for (const c of candidats) {
    const d = distanceM(l.lat, l.lon, c.lat, c.lon);
    if (d > DISTANCE_MAX) continue;
    const r = ressemblance(l.nom, c.nom);
    if (r < RESSEMBLANCE_MIN) continue; // noms trop différents : refusé
    if (!meilleur || r > meilleur.r || (r === meilleur.r && d < meilleur.d)) {
      meilleur = { r, d, nom: c.nom, oh: c.oh };
    }
  }

  if (!meilleur) continue;
  if (meilleur.r < 1) ambigus++;

  trouves[l.id] = {
    horaires: humaniser(meilleur.oh),
    source: meilleur.nom,
    brut: meilleur.oh,
    distance: Math.round(meilleur.d),
    confiance: Number(meilleur.r.toFixed(2)),
  };
}

writeFileSync(SORTIE, JSON.stringify(trouves, null, 1) + '\n');
console.log(
  `${Object.keys(trouves).length} horaires retrouvés ` +
    `(dont ${ambigus} à confiance moyenne, à relire dans data/horaires-osm.json).`
);
