# Moteur du dessinateur méthodes

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
