/**
 * Carte des sorties enfants, logique client.
 *
 * Un seul jeu de données filtré alimente deux vues synchronisées : la liste et
 * la carte Leaflet. Sélectionner une fiche d'un côté la met en avant de l'autre.
 */

import L from 'leaflet';
import 'leaflet.markercluster';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface Categorie {
  label: string;
  emoji: string;
  couleur: string;
}

interface Alerte {
  niveau: 'ferme' | 'attention' | 'saisonnier';
  texte: string;
}

interface Lieu {
  id: string;
  nom: string;
  type: 'sortie' | 'service';
  origine: string;
  categorie: string;
  emoji: string;
  age: { min: number; max: number; ouvert: boolean } | null;
  ageBrut: string;
  prix: 'gratuit' | 'payant' | 'mixte' | null;
  tarifPrecis: string;
  lieu: 'interieur' | 'exterieur' | 'les_deux' | null;
  adresse: string;
  codePostal: string;
  commune: string;
  lat: number | null;
  lon: number | null;
  precision: 'exacte' | 'geocodee' | 'approchee' | null;
  tags: string[];
  telephone: string;
  horaires: string;
  periode: { debut: string; fin: string; statut: 'encours' | 'avenir' | 'termine' } | null;
  site: string;
  accessibilite: string;
  remarque: string;
  alertes: Alerte[];
}

interface Donnees {
  genereLe: string;
  verifieLe: string;
  categories: Record<string, Categorie>;
  communes: string[];
  stats: Record<string, number>;
  lieux: Lieu[];
}

/* ------------------------------------------------------------------ */
/* Données et éléments                                                 */
/* ------------------------------------------------------------------ */

const brut: Donnees = JSON.parse(document.getElementById('donnees')!.textContent as string);

/**
 * Le statut des événements est recalculé ici, dans le navigateur, avec la date
 * du jour. Le site est statique : sans ce recalcul, un événement terminé
 * resterait affiché jusqu'au prochain build. Là, il disparaît tout seul.
 */
const AUJOURDHUI = new Date(new Date().toISOString().slice(0, 10));

const donnees: Donnees = {
  ...brut,
  lieux: brut.lieux
    .map((l) => {
      if (!l.periode) return l;
      const fin = l.periode.fin ? new Date(l.periode.fin) : null;
      const debut = l.periode.debut ? new Date(l.periode.debut) : null;
      const statut =
        fin && fin < AUJOURDHUI ? 'termine' : debut && debut > AUJOURDHUI ? 'avenir' : 'encours';
      return { ...l, periode: { ...l.periode, statut } };
    })
    .filter((l) => l.periode?.statut !== 'termine'),
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const elQ = $<HTMLInputElement>('q');
const elAge = $<HTMLSelectElement>('age');
const elPrix = $<HTMLSelectElement>('prix');
const elLieu = $<HTMLSelectElement>('lieu');
const elCommune = $<HTMLSelectElement>('commune');
const elReinit = $<HTMLButtonElement>('reinit');
const elListe = $<HTMLUListElement>('liste');
const elResume = $<HTMLParagraphElement>('resume');
const elVide = $<HTMLParagraphElement>('vide');
const elNoteCarte = $<HTMLParagraphElement>('note-carte');
const elFiche = $<HTMLElement>('fiche');
const elFicheContenu = $<HTMLElement>('fiche-contenu');
const elGrille = document.querySelector('.grille') as HTMLElement;
const puces = [...document.querySelectorAll<HTMLButtonElement>('.puce')];

const CENTRE: L.LatLngTuple = [46.2044, 6.1432]; // Genève, place du Molard

/* ------------------------------------------------------------------ */
/* État                                                                */
/* ------------------------------------------------------------------ */

const etat = {
  q: '',
  age: null as number | null,
  prix: '',
  lieu: '',
  commune: '',
  categories: new Set<string>(),
  saison: false,
  selection: null as string | null,
};

/** Texte normalisé (sans accents, minuscules) pour la recherche. */
const sansAccents = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

// Index de recherche calculé une fois : nom + tags + commune + adresse.
const index = new Map<string, string>();
for (const l of donnees.lieux) {
  index.set(
    l.id,
    sansAccents(
      [l.nom, l.commune, l.adresse, l.tags.join(' '), donnees.categories[l.categorie]?.label]
        .filter(Boolean)
        .join(' ')
    )
  );
}

function correspond(l: Lieu): boolean {
  // Filtre transversal : tout ce qui porte des dates, quelle que soit la
  // catégorie. Les guinguettes sont en Cafés, elles doivent sortir aussi.
  if (etat.saison && !l.periode) return false;
  if (etat.q && !index.get(l.id)!.includes(etat.q)) return false;
  if (etat.prix && l.prix !== etat.prix && l.prix !== 'mixte') return false;
  if (etat.commune && l.commune !== etat.commune) return false;
  if (etat.categories.size && !etat.categories.has(l.categorie)) return false;

  if (etat.lieu && l.lieu !== etat.lieu && l.lieu !== 'les_deux') return false;

  if (etat.age !== null && l.age) {
    // Un âge non renseigné n'exclut pas le lieu : mieux vaut le proposer.
    const dansLaTranche =
      etat.age >= l.age.min && (l.age.ouvert ? true : etat.age <= l.age.max);
    if (!dansLaTranche) return false;
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* Carte                                                               */
/* ------------------------------------------------------------------ */

const carte = L.map('carte', {
  center: CENTRE,
  zoom: 12,
  scrollWheelZoom: true,
  zoomControl: false,
});

L.control.zoom({ position: 'bottomright' }).addTo(carte);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(carte);

const groupe = L.markerClusterGroup({
  maxClusterRadius: 45,
  showCoverageOnHover: false,
  spiderfyDistanceMultiplier: 1.4,
});
carte.addLayer(groupe);

const marqueurs = new Map<string, L.Marker>();

function icone(l: Lieu, actif = false): L.DivIcon {
  const couleur = donnees.categories[l.categorie]?.couleur ?? '#888';
  return L.divIcon({
    className: 'marqueur-conteneur',
    html: `<span class="marqueur${
      actif ? ' actif' : ''
    }" style="--c:${couleur}"><i>${l.emoji}</i></span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 34],
    popupAnchor: [0, -30],
  });
}

/* ------------------------------------------------------------------ */
/* Rendu                                                               */
/* ------------------------------------------------------------------ */

const echappe = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

function libellePrix(l: Lieu): string {
  if (l.prix === 'gratuit') return 'Gratuit';
  if (l.prix === 'payant') return l.tarifPrecis || 'Payant';
  if (l.prix === 'mixte') return 'Gratuit et payant';
  return '';
}

function libelleLieu(l: Lieu): string {
  return l.lieu === 'interieur'
    ? 'Intérieur'
    : l.lieu === 'exterieur'
      ? 'Extérieur'
      : l.lieu === 'les_deux'
        ? 'Int. et ext.'
        : '';
}

function itineraire(l: Lieu): string {
  return l.lat
    ? `https://www.google.com/maps/dir/?api=1&destination=${l.lat},${l.lon}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${l.nom} ${l.adresse}`
      )}`;
}

const jourMois = new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'long' });

/** « 1 septembre » se dit « 1er septembre ». */
const jour = {
  format: (d: Date) => jourMois.format(d).replace(/^1 /, '1er '),
};

/**
 * Badge de période pour les événements datés : « En ce moment, jusqu'au 26
 * juillet » ou « Du 5 au 9 août ». Rien pour les lieux permanents.
 */
function badgePeriode(l: Lieu): string {
  if (!l.periode) return '';
  const { debut, fin, statut } = l.periode;
  const dDate = debut ? new Date(`${debut}T12:00:00`) : null;
  const fDate = fin ? new Date(`${fin}T12:00:00`) : null;
  const d = dDate ? jour.format(dDate) : '';
  const f = fDate ? jour.format(fDate) : '';

  // « Du 9 au 13 septembre » plutôt que « Du 9 septembre au 13 septembre »,
  // et « Le 15 août » quand l'événement tient sur une seule journée.
  const memeJour = debut && fin && debut === fin;
  const memeMois = dDate && fDate && dDate.getMonth() === fDate.getMonth();
  const plage = memeJour
    ? `Le ${f}`
    : memeMois
      ? `Du ${dDate!.getDate()} au ${f}`
      : `Du ${d} au ${f}`;

  const texte =
    statut === 'encours'
      ? memeJour
        ? "Aujourd'hui"
        : f
          ? `En ce moment, jusqu'au ${f}`
          : 'En ce moment'
      : d && f
        ? plage
        : `À partir du ${d}`;

  return `<span class="badge periode ${statut}">${echappe(texte)}</span>`;
}

/** Les badges communs aux deux cartes (liste et bulle). */
function badges(l: Lieu): string {
  return [
    badgePeriode(l),
    l.ageBrut && `<span class="badge">${echappe(l.ageBrut)} ans</span>`,
    l.prix && `<span class="badge ${l.prix}">${echappe(libellePrix(l))}</span>`,
    l.lieu && `<span class="badge">${echappe(libelleLieu(l))}</span>`,
  ]
    .filter(Boolean)
    .join('');
}

/**
 * Bulle compacte ouverte au clic sur un marqueur : l'essentiel sans masquer
 * la carte. Le bouton « Détails » ouvre la fiche complète.
 */
function miniCarte(l: Lieu): string {
  const cat = donnees.categories[l.categorie];
  const alerte = l.alertes.length
    ? `<p class="mini-alerte ${l.alertes[0].niveau}">${echappe(l.alertes[0].texte)}</p>`
    : '';

  return `
    <div class="mini">
      <p class="mini-cat" style="--c:${cat.couleur}">
        <span aria-hidden="true">${l.emoji}</span> ${echappe(cat.label)}
      </p>
      <h3>${echappe(l.nom)}</h3>
      <p class="badges">${badges(l)}</p>
      ${alerte}
      ${l.adresse ? `<p class="mini-adresse">${echappe(l.adresse)}</p>` : ''}
      ${l.horaires ? `<p class="mini-adresse">🕒 ${echappe(l.horaires)}</p>` : ''}
      <p class="mini-actions">
        <button type="button" class="mini-details" data-id="${l.id}">Détails</button>
        <a href="${echappe(itineraire(l))}" target="_blank" rel="noopener">Itinéraire</a>
      </p>
    </div>`;
}

function carteLieu(l: Lieu): string {
  const cat = donnees.categories[l.categorie];
  const alerte = l.alertes.length
    ? `<p class="mini-alerte ${l.alertes[0].niveau}">${echappe(l.alertes[0].texte)}</p>`
    : '';

  const sansGps = l.lat === null ? '<span class="sans-gps">non localisé</span>' : '';

  return `
    <li>
      <button type="button" class="fiche-carte" data-id="${l.id}" aria-pressed="false">
        <span class="pastille" style="--c:${cat.couleur}" aria-hidden="true">${l.emoji}</span>
        <span class="corps">
          <span class="nom">${echappe(l.nom)}</span>
          <span class="meta">${echappe(cat.label)}${
            l.commune ? ` · ${echappe(l.commune)}` : ''
          } ${sansGps}</span>
          <span class="badges">${badges(l)}</span>
          ${alerte}
        </span>
      </button>
    </li>`;
}

let visibles: Lieu[] = [];

function rendre(): void {
  visibles = donnees.lieux.filter(correspond);

  // --- Liste ---
  elListe.innerHTML = visibles.map(carteLieu).join('');
  elVide.hidden = visibles.length > 0;

  const avecGps = visibles.filter((l) => l.lat !== null);
  const services = visibles.filter((l) => l.type === 'service').length;
  elResume.textContent =
    visibles.length === 0
      ? ''
      : `${visibles.length} lieu${visibles.length > 1 ? 'x' : ''}` +
        (services ? ` (dont ${services} service${services > 1 ? 's' : ''})` : '') +
        ` · ${avecGps.length} sur la carte`;

  const manquants = visibles.length - avecGps.length;
  elNoteCarte.textContent = manquants
    ? manquants > 1
      ? `${manquants} lieux sans coordonnées ne sont pas affichés ici, ils figurent dans la liste.`
      : "1 lieu sans coordonnées n'est pas affiché ici, il figure dans la liste."
    : '';

  // --- Carte ---
  groupe.clearLayers();
  marqueurs.clear();
  marqueurAccentue = null; // les marqueurs sont recréés : le suivi repart de zéro

  for (const l of avecGps) {
    const m = L.marker([l.lat!, l.lon!], {
      icon: icone(l, l.id === etat.selection),
      title: l.nom,
      alt: l.nom,
    });
    // La bulle s'ouvre seule au clic (comportement Leaflet) ; on se contente
    // de synchroniser la surbrillance et la liste.
    m.bindPopup(() => miniCarte(l), {
      className: 'popup-mini',
      minWidth: 210,
      maxWidth: 250,
      autoPanPadding: [24, 24],
      offset: [0, -6],
    });
    m.on('click', () => {
      surligner(l.id, 'carte');
      // Si la fiche détaillée est ouverte, elle suit le lieu qu'on vient de
      // choisir plutôt que de rester sur le précédent. La vue de la carte,
      // elle, ne bouge pas : on reste où l'utilisateur avait zoomé.
      if (!elFiche.hidden) ouvrirFiche(l);
    });
    marqueurs.set(l.id, m);
    groupe.addLayer(m);
  }

  elReinit.hidden = !filtresActifs();
  majSelection();

  // Au premier rendu seulement : cadrer sur l'ensemble des lieux plutôt que
  // sur un zoom fixe. Ensuite on laisse la vue là où l'utilisateur l'a mise.
  if (premierRendu && avecGps.length) {
    cadrageInitial = L.latLngBounds(avecGps.map((l) => [l.lat!, l.lon!] as L.LatLngTuple));
    // Sur mobile la carte démarre masquée : un fitBounds sur un conteneur de
    // taille nulle donne un cadrage aberrant. On attend qu'elle soit visible.
    if (carte.getContainer().clientHeight > 0) {
      premierRendu = false;
      carte.fitBounds(cadrageInitial, { padding: [40, 40], maxZoom: 14 });
    }
  }
}

let premierRendu = true;
let cadrageInitial: L.LatLngBounds | null = null;

function filtresActifs(): boolean {
  return Boolean(
    etat.q || etat.age !== null || etat.prix || etat.lieu || etat.commune || etat.categories.size || etat.saison
  );
}

/* ------------------------------------------------------------------ */
/* Sélection et fiche détaillée                                        */
/* ------------------------------------------------------------------ */

/** Index par identifiant, pour éviter une recherche linéaire par marqueur. */
const parId = new Map(donnees.lieux.map((l) => [l.id, l]));

/** Dernier marqueur mis en avant, pour ne rendre que ce qui change. */
let marqueurAccentue: string | null = null;

function majSelection(): void {
  for (const b of elListe.querySelectorAll<HTMLButtonElement>('.fiche-carte')) {
    b.setAttribute('aria-pressed', String(b.dataset.id === etat.selection));
  }

  // On ne retouche que les deux marqueurs concernés. Réappliquer une icône à
  // tous les marqueurs à chaque clic faisait remanier le calque entier, ce qui
  // était lent et pouvait perturber la vue.
  if (marqueurAccentue === etat.selection) return;

  for (const id of [marqueurAccentue, etat.selection]) {
    if (!id) continue;
    const m = marqueurs.get(id);
    const l = parId.get(id);
    if (m && l) m.setIcon(icone(l, id === etat.selection));
  }
  marqueurAccentue = etat.selection;
}

function ligne(icone: string, texte: string, lien?: string): string {
  const contenu = lien
    ? `<a href="${echappe(lien)}" ${
        lien.startsWith('http') ? 'target="_blank" rel="noopener"' : ''
      }>${echappe(texte)}</a>`
    : echappe(texte);
  return `<p class="ligne"><span aria-hidden="true">${icone}</span> ${contenu}</p>`;
}

function ouvrirFiche(l: Lieu): void {
  const cat = donnees.categories[l.categorie];
  const alertes = l.alertes
    .map(
      (a) =>
        `<p class="alerte ${a.niveau}"><strong>${
          a.niveau === 'ferme' ? 'Fermé' : a.niveau === 'saisonnier' ? 'Saisonnier' : 'À vérifier'
        }</strong> ${echappe(a.texte)}</p>`
    )
    .join('');

  const itineraire = l.lat
    ? `https://www.google.com/maps/dir/?api=1&destination=${l.lat},${l.lon}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${l.nom} ${l.adresse}`
      )}`;

  elFicheContenu.innerHTML = `
    <p class="fiche-cat" style="--c:${cat.couleur}">
      <span aria-hidden="true">${l.emoji}</span> ${echappe(cat.label)}
    </p>
    <h2 id="fiche-titre">${echappe(l.nom)}</h2>
    ${alertes}
    <p class="badges">
      ${badgePeriode(l)}
      ${l.ageBrut ? `<span class="badge">${echappe(l.ageBrut)} ans</span>` : ''}
      ${l.prix ? `<span class="badge ${l.prix}">${echappe(libellePrix(l))}</span>` : ''}
      ${l.lieu ? `<span class="badge">${echappe(libelleLieu(l))}</span>` : ''}
    </p>
    ${l.tags.length ? `<p class="tags">${l.tags.map((t) => `<span>${echappe(t)}</span>`).join('')}</p>` : ''}
    ${l.remarque ? `<p class="remarque">${echappe(l.remarque)}</p>` : ''}
    <div class="infos">
      ${l.adresse ? ligne('📍', l.adresse) : ''}
      ${l.horaires ? ligne('🕒', l.horaires) : ''}
      ${l.telephone ? ligne('📞', l.telephone, `tel:${l.telephone.replace(/\s/g, '')}`) : ''}
      ${l.site ? ligne('🔗', l.site.replace(/^https?:\/\//, ''), l.site) : ''}
      ${l.accessibilite ? ligne('♿', l.accessibilite) : ''}
    </div>
    <p class="actions">
      <a class="bouton" href="${itineraire}" target="_blank" rel="noopener">Itinéraire</a>
    </p>`;

  // On ne prend le focus qu'à l'ouverture. Le reprendre à chaque changement de
  // lieu ferait sauter la page pendant qu'on parcourt la carte.
  const etaitFermee = elFiche.hidden;
  elFiche.hidden = false;
  if (etaitFermee) elFiche.focus();
}

/**
 * Met un lieu en avant sans ouvrir la fiche complète : marqueur accentué et
 * ligne correspondante amenée dans la liste. C'est ce que déclenche un clic
 * sur la carte, où la bulle suffit.
 */
function surligner(id: string | null, source: 'liste' | 'carte'): void {
  etat.selection = id;
  majSelection();

  if (!id) {
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }

  history.replaceState(null, '', `#lieu=${id}`);

  if (source === 'carte') {
    const b = elListe.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    b?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function fermerFiche(): void {
  elFiche.hidden = true;
}

/** Depuis la liste : fiche complète, et la carte suit. */
function selectionner(id: string | null, source: 'liste' | 'carte'): void {
  if (!id) {
    fermerFiche();
    surligner(null, source);
    return;
  }

  const l = donnees.lieux.find((x) => x.id === id);
  if (!l) return;

  surligner(id, source);
  ouvrirFiche(l);

  if (source === 'liste' && l.lat !== null) {
    // Ouvre le cluster si nécessaire, puis centre sur le marqueur.
    const m = marqueurs.get(id);
    if (m) groupe.zoomToShowLayer(m, () => carte.panTo([l.lat!, l.lon!]));
  }
}

/* ------------------------------------------------------------------ */
/* Événements                                                          */
/* ------------------------------------------------------------------ */

let minuteur: number;
elQ.addEventListener('input', () => {
  clearTimeout(minuteur);
  minuteur = window.setTimeout(() => {
    etat.q = sansAccents(elQ.value.trim());
    rendre();
  }, 140);
});

elAge.addEventListener('change', () => {
  etat.age = elAge.value === '' ? null : Number(elAge.value);
  rendre();
});

for (const [el, champ] of [
  [elPrix, 'prix'],
  [elLieu, 'lieu'],
  [elCommune, 'commune'],
] as const) {
  el.addEventListener('change', () => {
    (etat as any)[champ] = el.value;
    rendre();
  });
}

for (const p of puces) {
  p.addEventListener('click', () => {
    const cat = p.dataset.cat!;
    if (etat.categories.has(cat)) etat.categories.delete(cat);
    else etat.categories.add(cat);
    p.setAttribute('aria-pressed', String(etat.categories.has(cat)));
    rendre();
  });
}

$('saison').addEventListener('click', () => {
  etat.saison = !etat.saison;
  $('saison').setAttribute('aria-pressed', String(etat.saison));
  rendre();
});

elReinit.addEventListener('click', () => {
  etat.saison = false;
  $('saison').setAttribute('aria-pressed', 'false');
  etat.q = '';
  etat.age = null;
  etat.prix = '';
  etat.lieu = '';
  etat.commune = '';
  etat.categories.clear();
  elQ.value = '';
  elAge.value = '';
  elPrix.value = '';
  elLieu.value = '';
  elCommune.value = '';
  for (const p of puces) p.setAttribute('aria-pressed', 'false');
  rendre();
});

elListe.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.fiche-carte');
  if (b?.dataset.id) selectionner(b.dataset.id, 'liste');
});

// « Détails » dans la bulle : on passe à la fiche complète. La bulle est
// reconstruite à chaque ouverture, d'où l'écoute déléguée sur le conteneur.
carte.getContainer().addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.mini-details');
  if (!b?.dataset.id) return;
  const l = donnees.lieux.find((x) => x.id === b.dataset.id);
  if (l) {
    carte.closePopup();
    ouvrirFiche(l);
  }
});

// Fermer la bulle retire la surbrillance, sauf si la fiche complète est ouverte.
carte.on('popupclose', () => {
  if (elFiche.hidden) surligner(null, 'carte');
});

$('fermer-fiche').addEventListener('click', () => selectionner(null, 'liste'));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !elFiche.hidden) selectionner(null, 'liste');
});

/* --- Défilement de la rangée de catégories --- */

// Les catégories ne tiennent pas toutes dans la largeur : deux flèches
// apparaissent quand il reste quelque chose à voir d'un côté ou de l'autre.
{
  const rangee = $<HTMLElement>('ligne-cat');
  const gauche = $<HTMLButtonElement>('cat-gauche');
  const droite = $<HTMLButtonElement>('cat-droite');

  const majFleches = () => {
    const debord = rangee.scrollWidth - rangee.clientWidth;
    // 2 px de marge : les navigateurs arrondissent scrollLeft au sous-pixel.
    gauche.hidden = rangee.scrollLeft <= 2;
    droite.hidden = rangee.scrollLeft >= debord - 2;
  };

  const defiler = (sens: 1 | -1) => {
    rangee.scrollBy({ left: sens * rangee.clientWidth * 0.8 });
  };

  droite.addEventListener('click', () => defiler(1));
  gauche.addEventListener('click', () => defiler(-1));
  rangee.addEventListener('scroll', majFleches, { passive: true });
  new ResizeObserver(majFleches).observe(rangee);

  // Une puce atteinte au clavier doit rester visible sous les flèches.
  rangee.addEventListener('focusin', (e) => {
    (e.target as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  majFleches();
}

// Bascule liste/carte sur mobile.
for (const onglet of document.querySelectorAll<HTMLButtonElement>('.bascule button')) {
  onglet.addEventListener('click', () => {
    for (const o of document.querySelectorAll('.bascule button')) {
      o.setAttribute('aria-selected', String(o === onglet));
    }
    elGrille.dataset.vue = onglet.dataset.vue!;
    // Leaflet a besoin d'un recalcul quand son conteneur passe de display:none.
    if (onglet.dataset.vue === 'carte') {
      setTimeout(() => {
        carte.invalidateSize();
        if (premierRendu && cadrageInitial) {
          premierRendu = false;
          carte.fitBounds(cadrageInitial, { padding: [40, 40], maxZoom: 14 });
        }
      }, 0);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

rendre();

// Lien profond : #lieu=parc-grange
const cible = /#lieu=([^&]+)/.exec(location.hash)?.[1];
if (cible && donnees.lieux.some((l) => l.id === cible)) {
  selectionner(decodeURIComponent(cible), 'liste');
}
