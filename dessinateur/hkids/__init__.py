"""Agent IA dessinateur méthodes et préparation CNC — H-KIDS.

Le cœur du système (pièces, cotes, DXF, calepinage, parcours) est un moteur
géométrique déterministe et vérifiable. L'IA ne sert qu'à lire les demandes de
Hiba (texte, plans, photos) et à proposer des valeurs : elle ne produit jamais
une cote confirmée.
"""

__version__ = "0.1.0"
