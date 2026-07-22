// Géocode les adresses sans coordonnées via Nominatim (OpenStreetMap).
// Résultats mis en cache dans data/geocache.json — relancer est sans risque,
// seules les adresses absentes du cache sont interrogées.
//
//   node scripts/geocode.mjs
//
// Nominatim impose 1 requête/seconde max et un User-Agent identifiable.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readSheets } from './xlsx.mjs';

const UA = 'sorties-enfants-geneve/0.1 (carte des sorties famille, contact: barbarin.louise@gmail.com)';
const CACHE = new URL('../data/geocache.json', import.meta.url);
const XLSX = new URL('../data/activités.xlsx', import.meta.url);

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};

const sheets = readSheets(XLSX);
const wanted = new Set();

for (const [name, rows] of Object.entries(sheets)) {
  if (name === 'Méthode & lacunes') continue;
  for (const r of rows) {
    if (r['Latitude'] && r['Longitude']) continue;
    const addr = (r['Adresse vérifiée (Google)'] || r['Adresse'] || '').trim();
    if (addr) wanted.add(addr);
  }
}

const todo = [...wanted].filter((a) => !(a in cache));
console.log(`${wanted.size} adresses sans GPS, ${todo.length} à géocoder (${wanted.size - todo.length} en cache)`);

// Nominatim comprend mal les adresses suisses "Rue X 12" (numéro après la rue)
// et les abréviations. On tente plusieurs formulations du plus précis au plus large.
function variants(addr) {
  const out = [addr];
  const expanded = addr
    .replace(/\bCh\./gi, 'Chemin')
    .replace(/\bAv\./gi, 'Avenue')
    .replace(/\bBd\.?\b/gi, 'Boulevard')
    .replace(/\bRte\b/gi, 'Route')
    .replace(/\bPl\./gi, 'Place')
    .replace(/\bQ\./gi, 'Quai');
  if (expanded !== addr) out.push(expanded);

  // "Rue de Lausanne 45, 1201 Genève" -> "45 Rue de Lausanne, 1201 Genève"
  const swapped = expanded.replace(/^([^,\d]+?)\s+(\d+[a-zA-Z]?)\s*,/, '$2 $1,');
  if (swapped !== expanded) out.push(swapped);

  // Sans le numéro de rue : au pire on tombe sur la bonne rue.
  const noNum = expanded.replace(/\s*\b\d+[a-zA-Z]?\b\s*,/, ',');
  if (noNum !== expanded) out.push(noNum);

  return [...new Set(out)];
}

async function query(q) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ch,fr&q=' +
    encodeURIComponent(q);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0;
let fail = 0;

for (const [i, addr] of todo.entries()) {
  let hit = null;
  let usedVariant = null;

  for (const v of variants(addr)) {
    await sleep(1100); // rate limit Nominatim
    try {
      const json = await query(v);
      if (json.length) {
        hit = json[0];
        usedVariant = v;
        break;
      }
    } catch (err) {
      console.warn(`  ! ${addr} :: ${err.message}`);
      await sleep(3000);
    }
  }

  if (hit) {
    cache[addr] = {
      lat: Number(hit.lat),
      lon: Number(hit.lon),
      precision: hit.addresstype === 'road' || hit.addresstype === 'suburb' ? 'rue' : 'exacte',
      matched: hit.display_name,
      variant: usedVariant === addr ? undefined : usedVariant,
    };
    ok++;
  } else {
    cache[addr] = null; // mémorise l'échec pour ne pas retenter à chaque build
    fail++;
  }

  if (i % 10 === 0 || i === todo.length - 1) {
    writeFileSync(CACHE, JSON.stringify(cache, null, 2) + '\n');
    console.log(`  ${i + 1}/${todo.length} — ${ok} trouvées, ${fail} échecs`);
  }
}

writeFileSync(CACHE, JSON.stringify(cache, null, 2) + '\n');
console.log(`Terminé : ${ok} géocodées, ${fail} introuvables.`);
