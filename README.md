# OctoScheduler

Plugin OctoPrint (testé avec 1.11.8) pour mettre des impressions en file d'attente et les lancer les unes après les autres.

- **Timeline** : durée de chaque impression, heure de début et de fin, nuits grisées. On peut réorganiser la file en glissant les blocs, ou y déposer un fichier. Elle affiche tout le planning à l'ouverture ; on zoome avec les boutons 🔍, Ctrl/⌘ + molette ou un pincement au trackpad (sans pouvoir dézoomer au-delà du planning complet), et on se déplace avec la molette, la barre de défilement ou en faisant glisser le fond.
- **Liste** : miniature, nom, durée estimée et heures de début/fin de chaque fichier. On réorganise par glisser-déposer (ou avec les flèches ↑/↓ sur mobile) et on retire un fichier avec ✕.
- **L'impression en cours est verrouillée** : elle apparaît en tête de la timeline et de la liste, mais on ne peut ni la déplacer ni la supprimer.
- **Jamais d'enchaînement automatique** : il faut vider et nettoyer le plateau. Pour lancer l'impression suivante, appuyez sur **« Imprimante prête »** sur l'imprimante (elle envoie `//action:ready`) ou cliquez sur **Lancer la suivante** dans l'onglet. Le planning compte environ 5 min entre deux impressions pour ce nettoyage (réglable).

## Installation

Dans OctoPrint : **Paramètres → Gestionnaire de plugins → Obtenir plus… → … depuis une archive**, puis choisissez `OctoScheduler.zip` (voir plus bas pour la générer). Vous pouvez aussi saisir l'URL d'un zip de ce dépôt.

Générer l'archive depuis le dépôt :

```sh
git archive --format=zip --prefix=OctoScheduler/ -o OctoScheduler.zip HEAD
```

## Ajouter des fichiers

- Bouton <i>calendrier +</i> sur chaque fichier de la liste de fichiers d'OctoPrint (barre latérale)
- Glisser un fichier de la barre latérale vers la timeline ou la liste du planificateur
- Bouton **Ajouter des fichiers** dans l'onglet *Planificateur* : recherche, puis **+** ou glisser-déposer

## Bouton « Imprimante prête »

Le plugin lance l'impression suivante quand l'imprimante envoie la commande hôte `//action:ready` (configurable dans les réglages). Rien ne se passe si une impression est déjà en cours ou si la file est vide.

- **Prusa (MK3S/MK4/XL/Mini…)** : menu **« Imprimante prête » / « Set Ready »**.
- **Marlin** : ajoutez un élément de menu personnalisé dans `Configuration_adv.h` :
  ```c
  #define CUSTOM_MENU_MAIN
  #define MAIN_MENU_ITEM_1_DESC "Imprimante prete"
  #define MAIN_MENU_ITEM_1_GCODE "M118 A1 action:ready"
  ```
- **Klipper** : macro `RESPOND TYPE=command MSG="action:ready"`.

N'utilisez pas `start` comme nom d'action : OctoPrint le traite déjà lui-même (il relance le fichier sélectionné).

## Durées et miniatures

- **Miniatures** : celles du plugin *Slicer Thumbnails* s'il est installé. Sinon, le plugin lit lui-même les miniatures embarquées dans le G-code (PNG, JPG ou QOI ; PrusaSlicer, OrcaSlicer, SuperSlicer, Bambu Studio, Cura…).
- **Durée** (mode automatique), dans cet ordre de priorité :
  1. moyenne des impressions précédentes de ce fichier (statistiques d'OctoPrint) ;
  2. estimation de **PrintTimeGenius**, s'il est installé ;
  3. commentaire du slicer (`estimated printing time`, `;TIME:`…) ;
  4. estimation d'OctoPrint.
- **Impression en cours** : le temps restant est celui d'OctoPrint, c'est-à-dire celui de PrintTimeGenius quand il est installé.
- **Temps entre deux impressions** : réglable (5 min par défaut). Il sert à calculer les heures de fin.

## Réglages

| Réglage | Défaut | Rôle |
|---|---|---|
| Commande « prête » | `ready` | Noms des actions `//action:<nom>` qui lancent l'impression suivante |
| Remettre en tête de file une impression échouée | oui | Une impression annulée ou échouée revient en tête de la file |
| Temps entre deux impressions | 5 min | Pour le calcul du planning |
| Source de la durée | Automatique | Ordre de priorité décrit plus haut |
| Nuit | 22 h → 7 h | Zone grisée sur la timeline |

## Comportement

- La file est enregistrée dans `~/.octoprint/data/octoscheduler/queue.json` et survit aux redémarrages.
- Si OctoPrint redémarre pendant une impression lancée par la file, celle-ci est remise en tête de file.
- Un fichier renommé ou déplacé dans OctoPrint est suivi automatiquement. Un fichier supprimé est signalé « introuvable » et sauté au lancement.
- Permission **« Gérer la file d'impression »** (groupes Admins et Utilisateurs par défaut) pour ajouter, retirer et réordonner. Lancer une impression demande la permission *Imprimer*.

## API

Toutes les routes sont sous `/plugin/octoscheduler/` et demandent d'être authentifié (clé API ou session + jeton CSRF).

| Méthode | Route | Corps |
|---|---|---|
| GET | `state` | — |
| POST | `queue/add` | `{"path": "dossier/fichier.gcode"}` ou `{"paths": [...], "index": 0}` |
| POST | `queue/remove` | `{"id": "..."}` |
| POST | `queue/reorder` | `{"order": ["id1", "id2", ...]}` |
| POST | `queue/clear` | — |
| POST | `start` | — (lance la première impression de la file) |

## Développement

```sh
python3 -m unittest discover -s tests
pip install -e .   # dans le virtualenv d'OctoPrint
```
