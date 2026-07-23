# Sorties enfants à Genève

Carte des sorties et activités pour enfants dans le canton de Genève et sa
couronne. Site statique (Astro + Leaflet), déployé sur Netlify.

## La donnée

`data/activités.xlsx` est **la source de vérité**. Le site est reconstruit à
partir du classeur, jamais l'inverse : pour corriger un lieu, on modifie le
classeur puis on relance le build.

D'autres fichiers CSV complètent le classeur, avec les mêmes colonnes. Ils
vivent à côté plutôt que dedans, pour ne pas avoir à réécrire le `.xlsx`.
`scripts/sources.mjs` réunit le tout.

| Fichier | Contenu | Produit par |
| --- | --- | --- |
| `complement-pays-de-gex.csv` | Annuaire de Pays de Gex agglo | à la main |
| `complement-parcs.csv` | Parcs, jardins et aires de jeux | `parcs-osm.mjs` |
| `evenements.csv` | Événements datés | à la main |

`evenements.csv` a deux colonnes de plus, `Début` et `Fin` (format AAAA-MM-JJ).
Une étape dont la date de fin est passée disparaît toute seule de la carte au
build suivant : rien à nettoyer à la main.

Trois feuilles alimentent la carte :

| Feuille | Contenu |
| --- | --- |
| `Sorties` | Le recensement principal (genevafamily.ch, enrichi Google Places) |
| `Nouveaux lieux trouvés` | Lieux ajoutés à la main, majoritairement géolocalisés |
| `Services (hors sorties)` | Santé et accueil parents-enfants |
| `Méthode & lacunes` | Sources, champs manquants et alertes de fraîcheur |

La feuille `Méthode & lacunes` n'est pas importée automatiquement : ses
constats sont repris à la main dans `scripts/build-data.mjs` (les alertes
affichées sur les fiches) et dans `src/pages/a-propos.astro`. **Si le classeur
change sur ces points, il faut mettre ces deux fichiers à jour.**

## Commandes

```bash
npm install
npm run dev      # reconstruit la donnée puis lance le serveur de dev
npm run build    # reconstruit la donnée puis génère dist/
npm run geocode  # géocode les adresses sans GPS (lent, à la demande)
npm run parcs    # réinterroge OpenStreetMap pour les parcs (écrase le CSV)
npm run horaires # complète les horaires manquants depuis OpenStreetMap
```

Les trois dernières commandes interrogent des services externes et sont lentes.
Elles ne tournent pas au build : on les lance à la main, puis on versionne leur
résultat.

## Chaîne de traitement

```
data/activités.xlsx
        │
        ├─ scripts/xlsx.mjs        lecteur .xlsx sans dépendance (zip + XML)
        │
        ├─ scripts/geocode.mjs     adresses sans GPS → Nominatim
        │                          cache : data/geocache.json
        │
        └─ scripts/build-data.mjs  normalisation, dédoublonnage, alertes
                    │
                    └─ src/data/lieux.json   (généré, non versionné)
```

`build-data.mjs` fait quatre choses qui méritent d'être connues :

- **Normalisation des catégories.** Les trois feuilles n'emploient ni le même
  vocabulaire ni la même casse ; tout est ramené à seize catégories canoniques
  définies en haut du script.
- **Dédoublonnage** sur un nom normalisé (sans accents, ponctuation ni
  articles). La fiche la plus complète est conservée et complétée par l'autre.
- **Filtre géographique.** Tout point hors de la boîte Genève + couronne est
  écarté : c'est le symptôme d'un géocodage tombé sur un homonyme.
- **Exclusion de catégories.** `CATEGORIES_EXCLUES` retire les espaces bébé et
  allaitement (commodités d'aéroport, de gare ou de centre commercial) ainsi
  que la santé (cliniques, consultations imad, gardes pédiatriques). La carte
  vise le loisir. Les lignes restent dans le classeur.
- **Alertes de fraîcheur** rattachées aux fiches concernées (musée fermé,
  équipements saisonniers, haltes-jeux fermées en vacances scolaires).

## Géocodage

Environ un tiers des lieux n'avaient pas de coordonnées dans le classeur.
`npm run geocode` interroge Nominatim (OpenStreetMap) en essayant plusieurs
formulations de chaque adresse, les adresses suisses placent le numéro après
la rue, ce que Nominatim interprète mal.

Les résultats, succès comme échecs, sont mis en cache dans
`data/geocache.json` ; relancer la commande ne réinterroge que les nouvelles
adresses. Le service impose une requête par seconde : compter quelques minutes
pour un lot complet.

Les positions issues du géocodage sont signalées dans la fiche du lieu quand
seule la rue a pu être retrouvée. Les marqueurs, eux, sont tous identiques.

## Limites connues

Aucune vérification systématique d'existence ou d'ouverture n'a été faite sur
l'ensemble des lieux. Les manques (site web, tarif précis, accessibilité PMR,
transports TPG) et les alertes vérifiées le 22.07.2026 sont listés sur la page
`/a-propos`.
