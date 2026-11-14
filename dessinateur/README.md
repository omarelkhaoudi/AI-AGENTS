# Moteur du dessinateur méthodes

Le moteur géométrique de l'« Agent IA dessinateur méthodes et préparation CNC
H-KIDS », repris dans le cockpit pour l'agent Production. Seule la partie
dessin est reprise : modèles de meubles, cotes avec leur provenance, tableau de
débit, calepinage et DXF. La préparation CNC (parcours, post-processeurs,
G-code) reste hors du cockpit tant qu'elle n'est pas qualifiée sur la machine.

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
