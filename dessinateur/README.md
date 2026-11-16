# Moteur du dessinateur méthodes

Le parcours du cockpit distingue désormais trois responsabilités : Production
coordonne deux agents IA (`dessinateur_2d3d` et `dessinateur_methodes`). Le premier
prépare la fiche technique globale, ses vues de pièces 2D et ses volumes OBJ en
millimètres. Sans positions et orientations fournies, ces volumes représentent
des pièces séparées ; ils ne constituent pas un modèle d'assemblage détaillé.
Le second transforme la **version validée** de la fiche en liste des pièces,
débit, calepinage et fiches d'opération imprimables, avec pièce, quantité,
machine, ordre et instructions. Les opérations sont celles de la fiche fournie :
aucun matériau ni passage à une machine n'est imposé par défaut.

Le parcours de validation est :

1. Fournir la fiche au Director ou importer son JSON dans Atelier → Dossier de
   fabrication. Une information manquante renvoie des questions sans fichier.
2. Une personne habilitée valide la fiche technique dans le cockpit.
3. Production confie le dossier au méthodes. Le calepinage scie utilise les
   dimensions disponibles, marges, trait de scie et sens du fil fournis. Les
   fiches de rabotage conservent les dimensions brutes et finies.
4. Pour les pièces CNC seulement, les DXF et les vues de calepinage sont produits
   depuis les pièces de la fiche validée. L'épaisseur du profil atelier doit
   correspondre à cette fiche. Production présente les liens à la direction.
5. **Tous les DXF courants doivent être validés humainement avant tout appel de
   génération du G-code.** Le dessin recalculé doit correspondre au dessin
   validé. Les paramètres réels et la qualification du post-processeur sur la
   machine restent obligatoires.
6. Chaque G-code est simulé et attend une validation humaine comprenant les
   contrôles du responsable atelier. Le statut de découpe CNC reste bloqué tant
   que tous les programmes attendus ne sont pas validés. Le logiciel ne pilote
   pas la machine ; la simulation intégrée ne remplace pas les contrôles physiques.

Les fichiers sont enregistrés sous `data/commandes/BC<référence>/FT/vN/`,
`FAB/vN/` et `CNC/vN/`. Le carnet `data/atelier.json` conserve les liens à la
fiche technique, au dossier, aux DXF sources, à la simulation et aux décisions.
Une correction crée une nouvelle fiche, rend les anciens fichiers CNC obsolètes
pour utilisation et conserve les archives téléchargeables. Le G-code envoyé
directement par API ou WhatsApp ne contourne pas ces règles.

Format minimal d'une fiche structurée (exemple fictif, à adapter aux données
réellement fournies ; aucune valeur machine de production n'est définie ici) :

```json
{
  "title": "Tablette de meuble", "units": "mm", "notes": "D'après la fiche fournie",
  "parts": [{
    "ref": "P01", "name": "Tablette", "length": 600, "width": 250,
    "thickness": 18, "quantity": 2, "material": "Panneau mélaminé",
    "confirmed": true, "grain": true, "rotationAllowed": false,
    "stock": { "length": 2440, "width": 1220, "margin": 10, "kerf": 3.2 },
    "operations": [{
      "type": "sciage_panneaux", "machine": "Scie à panneaux de l'atelier",
      "instructions": "Débiter aux dimensions et respecter le décor.",
      "checks": "Contrôler les dimensions et l'équerrage."
    }]
  }]
}
```

Types d'opération : `cnc`, `sciage_panneaux`, `rabotage`, `autre`.
Pour la CNC, préciser `materialId` du profil, `contour` (par exemple
`{"shape":"rectangle"}` si confirmé) et `features` (liste vide si aucun usinage
intérieur), selon le format `pieces_libres`. Pour le rabotage, préciser `rough`
avec `length`, `width`, `thickness` brutes. Pour des volumes 3D positionnés,
chaque référence d'occurrence (`quantity = 1`) peut préciser `position` avec
`x`, `y`, `z` et `plane` (`xy`, `xz`, `yz`).

Routes protégées : `POST /api/workshop/:number/technical-sheet`,
`POST /api/workshop/:number/technical-sheet/:id/decision`,
`POST /api/workshop/:number/fabrication` et
`GET /api/workshop/:number/fabrication/files/:id`. Les décisions de fiche et de
fichier CNC exigent le droit humain de décision ; les agents ne disposent
d'aucun outil d'approbation. La décision sur un G-code exige aussi
`workshopValidation` (contrôles rapportés par le responsable atelier).

Le moteur géométrique de l'« Agent IA dessinateur méthodes et préparation CNC
H-KIDS », repris dans le cockpit pour l'agent Production : modèles de meubles,
cotes avec leur provenance, tableau de débit, calepinage, DXF, puis parcours
2,5D (`cam.py`), post-processeurs génériques GRBL et Mach3
(`postprocessors.py`), simulation du G-code produit (`simulation.py`) et
programme pilote. Un post-processeur ne sert à la production qu'après le
programme pilote réussi sur la vraie machine ; le cockpit garde ces
qualifications avec le profil d'atelier.

- `hkids/bridge.py` : le pont appelé par `src/agent/design-office.js`
  (`python -m hkids.bridge`, une demande JSON sur l'entrée standard, la réponse
  JSON sur la sortie standard).
- `hkids/profile.py` : profil d'atelier de départ (panneaux de 3660 × 2020 mm,
  valeurs à confirmer). Le profil en vigueur est gardé par le cockpit dans
  `data/atelier-profil.json`.

Installer et tester :

```bash
python -m pip install -r dessinateur/requirements.txt
cd dessinateur && python -m pytest tests -q
```
