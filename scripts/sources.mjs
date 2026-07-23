// Inventaire des sources de lieux, partagé par build-data.mjs et geocode.mjs
// pour que les deux voient exactement le même jeu de données.

import { readFileSync } from 'node:fs';
import { readSheets } from './xlsx.mjs';

const XLSX = new URL('../data/activités.xlsx', import.meta.url);
const GEX = new URL('../data/complement-pays-de-gex.csv', import.meta.url);
const PARCS = new URL('../data/complement-parcs.csv', import.meta.url);
const EVENEMENTS = new URL('../data/evenements.csv', import.meta.url);

/** Découpe une ligne CSV en respectant les guillemets et les "" échappés. */
function decouper(ligne) {
  const cellules = [];
  let courant = '';
  let entreGuillemets = false;

  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (entreGuillemets) {
      if (c === '"') {
        if (ligne[i + 1] === '"') {
          courant += '"';
          i++;
        } else entreGuillemets = false;
      } else courant += c;
    } else if (c === '"') entreGuillemets = true;
    else if (c === ',') {
      cellules.push(courant);
      courant = '';
    } else courant += c;
  }
  cellules.push(courant);
  return cellules;
}

function lireCsv(url) {
  const lignes = readFileSync(url, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  if (!lignes.length) return [];
  const entete = decouper(lignes[0]).map((h) => h.trim());
  return lignes.slice(1).map((ligne) => {
    const cellules = decouper(ligne);
    const obj = {};
    entete.forEach((h, i) => {
      if (h) obj[h] = (cellules[i] ?? '').trim();
    });
    return obj;
  });
}

/**
 * Toutes les sources de lieux, dans l'ordre de priorité.
 * `type` distingue les sorties des services ; `origine` sert à tracer d'où
 * vient chaque fiche.
 */
export function lireSources() {
  const feuilles = readSheets(XLSX);
  return [
    { nom: 'Sorties', type: 'sortie', origine: 'genevafamily', lignes: feuilles['Sorties'] ?? [] },
    {
      nom: 'Nouveaux lieux trouvés',
      type: 'sortie',
      origine: 'complement',
      lignes: feuilles['Nouveaux lieux trouvés'] ?? [],
    },
    {
      nom: 'Services (hors sorties)',
      type: 'service',
      origine: 'genevafamily',
      lignes: feuilles['Services (hors sorties)'] ?? [],
    },
    { nom: 'Pays de Gex', type: 'sortie', origine: 'paysdegex', lignes: lireCsv(GEX) },
    { nom: 'Parcs OSM', type: 'sortie', origine: 'osm', lignes: lireCsv(PARCS) },
    { nom: 'Événements', type: 'evenement', origine: 'manuel', lignes: lireCsv(EVENEMENTS) },
  ];
}
