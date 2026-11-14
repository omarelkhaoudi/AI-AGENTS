"""Modèles de meubles paramétriques et registre.

Un modèle déclare ses paramètres (ce que Hiba doit fournir) et une fonction
``build`` qui décompose le meuble en pièces à partir de règles d'assemblage
explicites. Le modèle « pieces_libres » couvre les meubles hors catalogue :
les pièces sont alors décrites une à une (par Hiba, l'agent IA ou Rhino).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from ..model import Extra, Part
from ..provenance import A_CONFIRMER, FOURNI, Dim, dim_from_param


@dataclass
class ParamDef:
    name: str
    label: str
    type: str                       # mm | int | choice | bool | list_mm | material | text | pieces
    required: bool = True
    group: str = ""
    group_title: str = ""
    choices: list | None = None     # [[valeur, libellé], ...]
    proposal: object = None         # proposition (sera « à confirmer »)
    help: str = ""
    when: Callable[[dict], bool] | None = None
    min: float | None = None
    max: float | None = None

    def to_dict(self) -> dict:
        return {"name": self.name, "label": self.label, "type": self.type, "required": self.required,
                "group": self.group or self.name, "choices": self.choices, "proposal": self.proposal,
                "help": self.help, "min": self.min, "max": self.max}


@dataclass
class Design:
    parts: list[Part] = field(default_factory=list)
    extras: list[Extra] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)   # {"level": "bloquant"|"avertissement", "text"}
    used_materials: set = field(default_factory=set)
    used_rules: set = field(default_factory=set)
    elevation: dict = field(default_factory=dict)        # vue de face d'ensemble

    def block(self, text: str):
        self.warnings.append({"level": "bloquant", "text": text})

    def warn(self, text: str):
        self.warnings.append({"level": "avertissement", "text": text})

    def number_parts(self):
        for i, p in enumerate(self.parts, 1):
            p.ref = f"P{i:02d}"


def pval(params: dict, name: str, default=None):
    p = params.get(name)
    if p is None or p.get("value") in (None, ""):
        return default
    return p["value"]


def pdim(params: dict, name: str) -> Dim:
    d = dim_from_param(params.get(name))
    if d is None:
        raise KeyError(name)
    return d


def psrc(params: dict, name: str) -> str:
    p = params.get(name) or {}
    return p.get("source", FOURNI)


class FurnitureModel:
    id = ""
    name = ""
    description = ""
    params: list[ParamDef] = []

    def relevant(self, pdef: ParamDef, params: dict) -> bool:
        return pdef.when is None or pdef.when(params)

    def check_values(self, params: dict, profile: dict) -> list[str]:
        """Erreurs de saisie (valeurs hors limites, matière inconnue…)."""
        errs = []
        for pd in self.params:
            v = pval(params, pd.name)
            if v is None or not self.relevant(pd, params):
                continue
            if pd.type in ("mm", "int"):
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    errs.append(f"{pd.label} : valeur non numérique « {v} ».")
                    continue
                if pd.min is not None and fv < pd.min:
                    errs.append(f"{pd.label} : {v} est inférieur au minimum {pd.min}.")
                if pd.max is not None and fv > pd.max:
                    errs.append(f"{pd.label} : {v} dépasse le maximum {pd.max}.")
            if pd.type == "choice" and pd.choices and v not in [c[0] for c in pd.choices]:
                errs.append(f"{pd.label} : choix « {v} » inconnu.")
            if pd.type == "material" and v not in profile["materiaux"]:
                errs.append(f"{pd.label} : matière « {v} » absente du profil d'atelier.")
        return errs

    def questions(self, params: dict, profile: dict) -> list[dict]:
        """Questions indispensables : paramètres manquants ou propositions non confirmées."""
        groups: dict[str, dict] = {}
        titles = {}
        for pd in self.params:
            if pd.group_title:
                titles.setdefault(pd.group or pd.name, pd.group_title)
        for pd in self.params:
            if not self.relevant(pd, params):
                continue
            p = params.get(pd.name)
            missing = p is None or p.get("value") in (None, "", [])
            unconfirmed = not missing and p.get("source") == A_CONFIRMER
            if not (missing and pd.required) and not unconfirmed:
                continue
            gid = pd.group or pd.name
            q = groups.setdefault(gid, {
                "id": f"projet.{gid}", "scope": "projet", "stage": "dessin",
                "title": titles.get(gid, pd.label), "text": "", "fields": []})
            f = {"key": pd.name, "label": pd.label, "type": pd.type, "choices": self.choices_for(pd, profile),
                 "help": pd.help, "value": None if missing else p["value"], "status":
                 "manquant" if missing else "a_confirmer"}
            if missing and pd.proposal is not None:
                f["proposal"] = pd.proposal
            if unconfirmed and p.get("note"):
                f["note"] = p["note"]
            q["fields"].append(f)
        for q in groups.values():
            n_miss = sum(1 for f in q["fields"] if f["status"] == "manquant")
            n_conf = len(q["fields"]) - n_miss
            parts = []
            if n_miss:
                parts.append(f"{n_miss} information(s) manquante(s)")
            if n_conf:
                parts.append(f"{n_conf} proposition(s) à confirmer")
            q["text"] = " · ".join(parts)
        return list(groups.values())

    def choices_for(self, pd: ParamDef, profile: dict):
        if pd.type == "material":
            return [[k, m["nom"]] for k, m in profile["materiaux"].items()]
        return pd.choices

    def can_build(self, params: dict) -> bool:
        return all(pval(params, pd.name) not in (None, "", []) for pd in self.params
                   if pd.required and self.relevant(pd, params))

    def build(self, params: dict, profile: dict) -> Design:  # pragma: no cover - abstrait
        raise NotImplementedError

    def to_dict(self, profile: dict) -> dict:
        out = []
        for pd in self.params:
            d = pd.to_dict()
            d["choices"] = self.choices_for(pd, profile)
            d["group_title"] = pd.group_title or pd.label
            out.append(d)
        return {"id": self.id, "name": self.name, "description": self.description, "params": out}


def registry() -> dict[str, FurnitureModel]:
    from .bibliotheque import Bibliotheque
    from .coffre_jouets import CoffreJouets
    from .maisonnette import Maisonnette
    from .pieces_libres import PiecesLibres
    from .table_activite import TableActivite
    models = [Bibliotheque(), TableActivite(), CoffreJouets(), Maisonnette(), PiecesLibres()]
    return {m.id: m for m in models}


def get_model(type_id: str) -> FurnitureModel:
    reg = registry()
    if type_id not in reg:
        raise KeyError(f"Type de meuble inconnu : {type_id}")
    return reg[type_id]
