// Lecteur .xlsx minimal, sans dépendance.
// Un .xlsx est une archive ZIP de fichiers XML : on décompresse avec zlib
// (inflateRaw) puis on lit les feuilles. Suffisant pour ce classeur, qui
// n'utilise ni formules ni dates sérialisées.

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

function unzip(buf) {
  // On lit l'End Of Central Directory, puis le Central Directory, qui donne
  // l'offset de chaque fichier — plus fiable que scanner les entêtes locaux.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Archive ZIP invalide (EOCD introuvable)');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const files = {};

  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // L'entête local a ses propres longueurs de champs variables.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    files[name] = method === 0 ? raw : inflateRawSync(raw);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

// "AB12" -> index de colonne 0-based
function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1])).join('')
  );
}

function parseSheet(xml, shared) {
  const rows = [];

  for (const [, rowXml] of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    let max = -1;

    for (const m of rowXml.matchAll(/<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1];
      const body = m[3] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const idx = colIndex(ref);
      const type = /t="([^"]+)"/.exec(attrs)?.[1];

      let value = '';
      if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
          .map((t) => decodeEntities(t[1]))
          .join('');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        value = type === 's' ? (shared[Number(v)] ?? '') : decodeEntities(v);
      }

      cells[idx] = value;
      if (idx > max) max = idx;
    }

    if (max >= 0) {
      for (let i = 0; i <= max; i++) if (cells[i] === undefined) cells[i] = '';
      rows.push(cells);
    }
  }
  return rows;
}

/**
 * Lit un .xlsx et renvoie { "Nom de la feuille": [ {colonne: valeur}, ... ] }.
 * La première ligne de chaque feuille sert d'entête.
 */
export function readSheets(path) {
  const files = unzip(readFileSync(path));
  const text = (name) => (files[name] ? files[name].toString('utf8') : null);

  const shared = parseSharedStrings(text('xl/sharedStrings.xml'));
  const workbook = text('xl/workbook.xml');
  const rels = text('xl/_rels/workbook.xml.rels') ?? '';

  // L'ordre des attributs varie selon le producteur du fichier : on les lit
  // indépendamment plutôt que d'en supposer la séquence.
  const target = {};
  for (const [tag] of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(tag)?.[1];
    const path = /Target="([^"]+)"/.exec(tag)?.[1];
    if (id && path) target[id] = path.replace(/^\/?(xl\/)?/, '');
  }

  const out = {};
  for (const m of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const tag = m[0];
    const name = decodeEntities(/name="([^"]*)"/.exec(tag)?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(tag)?.[1];
    const file = target[rid];
    const xml = file && text(`xl/${file}`);
    if (!xml) continue;

    const rows = parseSheet(xml, shared);
    if (!rows.length) {
      out[name] = [];
      continue;
    }

    const header = rows[0].map((h) => h.trim());
    out[name] = rows.slice(1).map((cells) => {
      const obj = {};
      header.forEach((h, i) => {
        if (h) obj[h] = (cells[i] ?? '').trim();
      });
      return obj;
    });
  }
  return out;
}
