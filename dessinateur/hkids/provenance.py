"""Cotes avec provenance.

Chaque valeur porte son origine :
- ``fourni``      : donnée par Hiba (ou confirmée par elle) ;
- ``calcule``     : obtenue par une règle d'assemblage à partir de valeurs sûres ;
- ``a_confirmer`` : proposition, estimation (photo, plan lu par l'IA, valeur par
  défaut) ou calcul dépendant d'une proposition.

La provenance se propage : un calcul qui utilise une valeur à confirmer est
lui-même à confirmer. Une cote n'est donc jamais « confirmée » par accident.
"""
from __future__ import annotations

from dataclasses import dataclass

FOURNI = "fourni"
CALCULE = "calcule"
A_CONFIRMER = "a_confirmer"

LABELS = {FOURNI: "Fournie par Hiba", CALCULE: "Calculée (règle)", A_CONFIRMER: "À confirmer"}


def r1(v: float) -> float:
    """Arrondi au dixième de millimètre (précision de travail)."""
    return round(float(v) + 0.0, 1) + 0.0


def fmt(v: float) -> str:
    v = r1(v)
    return str(int(v)) if v == int(v) else f"{v:.1f}"


@dataclass
class Dim:
    value: float
    source: str = FOURNI
    formule: str = ""

    def to_dict(self) -> dict:
        d = {"value": r1(self.value), "source": self.source}
        if self.formule:
            d["formule"] = self.formule
        return d

    def __float__(self) -> float:
        return float(self.value)


def worst_source(*items) -> str:
    """Provenance d'un résultat calculé à partir de ``items``."""
    for it in items:
        src = it.source if isinstance(it, Dim) else it
        if src == A_CONFIRMER:
            return A_CONFIRMER
    return CALCULE


def calc(value: float, formule: str, *deps) -> Dim:
    """Crée une cote calculée ; ``formule`` est lisible (ex. "L − 2×ép = 800 − 2×18")."""
    return Dim(r1(value), worst_source(*deps), f"{formule} = {fmt(value)}")


def dim_from_param(p: dict | None) -> Dim | None:
    if p is None or p.get("value") in (None, ""):
        return None
    src = p.get("source", FOURNI)
    if src not in (FOURNI, A_CONFIRMER):
        src = A_CONFIRMER
    return Dim(float(p["value"]), src)
