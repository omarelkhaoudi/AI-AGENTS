"""Meuble hors catalogue : pièces décrites une à une.

Utilisé lorsque le meuble ne correspond à aucun modèle paramétrique, ou pour
les géométries créées dans Rhino. Chaque valeur garde sa provenance.

Format d'une pièce ::

    {"name": "Montant", "qty": 2, "material": "cp18", "length": 900, "width": 300,
     "grain": true, "corner_r": 0, "source": "fourni",
     "features": [{"kind": "percage", "x": 50, "y": 37, "diameter": 5, "depth": 12},
                  {"kind": "rainure", "x": 0, "y": 280, "w": 900, "h": 4, "depth": 8}],
     "assembly": "…", "role": "cnc"}

``role`` = "cnc" (découpée à la CNC) ou "hors_cnc" (poutre, poteau, renfort…).
Une valeur peut être un nombre ou {"value": …, "source": "a_confirmer"}.

Formes (voir ``shapes``) : contour ``"contour": {"shape": "pignon", "h_egout": 1180}`` ou
``{"shape": "libre", "path": [[x, y, bulge], …]}`` ; ouverture ``{"kind": "ouverture", "shape": "arc",
"x": …, "y": …, "w": …, "h": …}`` ou ``{"kind": "ouverture", "shape": "libre", "path": […]}`` (repère pièce).
"""
from __future__ import annotations

from .. import shapes as S
from ..model import FEATURE_LABELS, OUVERTURE, Extra, Feature, Part
from ..profile import material, thickness
from ..provenance import A_CONFIRMER, FOURNI, Dim
from . import Design, FurnitureModel, ParamDef, pval

REQUIRED = [("name", "Nom"), ("qty", "Quantité"), ("material", "Matière"), ("length", "Longueur de débit"),
            ("width", "Largeur de débit")]


def _val(v):
    return v.get("value") if isinstance(v, dict) else v


def _dim(v, default_src) -> Dim | None:
    if v in (None, ""):
        return None
    if isinstance(v, dict):
        if v.get("value") in (None, ""):
            return None
        return Dim(float(v["value"]), v.get("source", default_src))
    return Dim(float(v), default_src)


class PiecesLibres(FurnitureModel):
    id = "pieces_libres"
    name = "Meuble hors catalogue (pièces libres)"
    description = "Liste de pièces décrites une à une (saisie, agent IA ou import Rhino)."
    params = [ParamDef("pieces", "Pièces du meuble", "pieces", group="pieces", group_title="Pièces"),
              ParamDef("quantite", "Nombre de meubles identiques", "int", group="pieces", min=1, proposal=1)]

    def questions(self, params: dict, profile: dict) -> list[dict]:
        qs = []
        q = pval(params, "quantite")
        if q is None or params["quantite"].get("source") == A_CONFIRMER:
            qs.append({"id": "projet.quantite", "scope": "projet", "stage": "dessin",
                       "title": "Nombre de meubles", "text": "Information manquante ou à confirmer",
                       "fields": [{"key": "quantite", "label": "Nombre de meubles identiques", "type": "int",
                                   "value": q, "proposal": 1, "status": "manquant" if q is None else "a_confirmer"}]})
        pieces = pval(params, "pieces") or []
        if not pieces:
            qs.append({"id": "projet.pieces", "scope": "projet", "stage": "dessin", "title": "Pièces du meuble",
                       "text": "Aucune pièce décrite : envoyer un plan coté, utiliser Rhino ou saisir les pièces.",
                       "fields": []})
        for i, pc in enumerate(pieces):
            fields = []
            src = pc.get("source", FOURNI)
            for key, lbl in REQUIRED:
                v = pc.get(key)
                missing = _val(v) in (None, "")
                unconf = (not missing and key in ("length", "width", "qty")
                          and (src == A_CONFIRMER or (isinstance(v, dict) and v.get("source") == A_CONFIRMER)))
                if missing or unconf:
                    fields.append({"key": f"pieces.{i}.{key}", "label": lbl,
                                   "type": "material" if key == "material" else ("text" if key == "name" else
                                                                                 ("int" if key == "qty" else "mm")),
                                   "choices": self.choices_for(ParamDef("m", "m", "material"), profile)
                                   if key == "material" else None,
                                   "value": None if missing else _val(v),
                                   "status": "manquant" if missing else "a_confirmer"})
            for j, f in enumerate(pc.get("features", [])):
                for k in ("x", "y", "w", "h", "diameter", "depth"):
                    v = f.get(k)
                    if isinstance(v, dict) and v.get("source") == A_CONFIRMER:
                        fields.append({"key": f"pieces.{i}.features.{j}.{k}",
                                       "label": f"{FEATURE_LABELS.get(f.get('kind'), 'Usinage')} {j + 1} — {k}",
                                       "type": "mm", "value": v.get("value"), "status": "a_confirmer"})
            if fields:
                qs.append({"id": f"projet.piece.{i}", "scope": "projet", "stage": "dessin",
                           "title": f"Pièce {i + 1} « {_val(pc.get('name')) or 'sans nom'} »",
                           "text": "Informations manquantes ou à confirmer", "fields": fields})
        return qs

    def check_values(self, params: dict, profile: dict) -> list[str]:
        errs = []
        for i, pc in enumerate(pval(params, "pieces") or []):
            m = _val(pc.get("material"))
            if m and m not in profile["materiaux"]:
                errs.append(f"Pièce {i + 1} : matière « {m} » absente du profil d'atelier.")
        return errs

    def can_build(self, params: dict) -> bool:
        pieces = pval(params, "pieces") or []
        return bool(pieces) and pval(params, "quantite") is not None and all(
            _val(pc.get(k)) not in (None, "") for pc in pieces for k, _ in REQUIRED)

    def build(self, params: dict, profile: dict) -> Design:
        d = Design()
        n_meubles = int(pval(params, "quantite"))
        for i, pc in enumerate(pval(params, "pieces")):
            src = pc.get("source", FOURNI)
            name = str(_val(pc["name"]))
            if pc.get("role") == "hors_cnc":
                d.extras.append(Extra("element", f"{name} — {_val(pc.get('length'))}×{_val(pc.get('width'))}",
                                      int(_val(pc["qty"])) * n_meubles, "u", src, pc.get("assembly", "")))
                continue
            mat_id = _val(pc["material"])
            mat = material(profile, mat_id)
            d.used_materials.add(mat_id)
            e = thickness(profile, mat_id)
            L, W = _dim(pc["length"], src), _dim(pc["width"], src)
            contour = None
            cdef = pc.get("contour")
            if isinstance(cdef, dict) and cdef.get("shape") not in (None, "", "rectangle"):
                try:
                    if cdef["shape"] == "libre":
                        cpath = S.normalize(cdef["path"])
                    else:
                        cpath = S.build(cdef["shape"], L.value, W.value, cdef)
                    contour = {"shape": cdef["shape"], "label": S.SHAPES.get(cdef["shape"], cdef["shape"]),
                               "path": cpath, "source": src}
                except (S.ShapeError, KeyError, TypeError, ValueError) as exc:
                    d.block(f"Pièce {i + 1} : forme du contour — {exc}")
            feats = []
            for j, f in enumerate(pc.get("features", [])):
                kind = f.get("kind")
                if kind not in FEATURE_LABELS:
                    d.block(f"Pièce {i + 1} : type d'usinage inconnu « {kind} ».")
                    continue
                through = bool(f.get("through")) or kind == OUVERTURE
                fshape, fpath = f.get("shape") or "", None
                fx, fy, fw, fh = (_dim(f.get(k), src) for k in ("x", "y", "w", "h"))
                try:
                    if f.get("path"):
                        fpath = [list(map(float, q)) for q in f["path"]]
                        bx0, by0, bx1, by1 = S.bbox(fpath)
                        fx, fy = fx or Dim(bx0, src), fy or Dim(by0, src)
                        fw, fh = fw or Dim(bx1 - bx0, src), fh or Dim(by1 - by0, src)
                        fshape = fshape or "libre"
                    elif fshape and fshape != "rectangle" and None not in (fx, fy, fw, fh):
                        fpath = S.translate(S.build(fshape, fw.value, fh.value, f), fx.value, fy.value)
                except (S.ShapeError, KeyError, TypeError, ValueError) as exc:
                    d.block(f"Pièce {i + 1}, usinage {j + 1} : forme — {exc}")
                    continue
                ft = Feature(kind, f.get("label") or f"{FEATURE_LABELS[kind]} {j + 1}", fx, fy, w=fw, h=fh,
                             diameter=_dim(f.get("diameter"), src),
                             depth=None if through else _dim(f.get("depth"), src), through=through,
                             corner_r=float(_val(f.get("corner_r")) or 0), shape=fshape if fpath else "",
                             path=fpath)
                if ft.x is None or ft.y is None or (not ft.is_circle and (ft.w is None or ft.h is None)):
                    d.block(f"Pièce {i + 1}, usinage {j + 1} : position ou dimensions manquantes.")
                    continue
                if not through and ft.depth is None:
                    d.block(f"Pièce {i + 1}, usinage {j + 1} : profondeur manquante.")
                    continue
                if not through and ft.depth.value >= e.value:
                    d.block(f"Pièce {i + 1}, usinage {j + 1} : profondeur ≥ épaisseur (déclarer « traversant »).")
                x0, y0, x1, y1 = ft.bbox()
                if x0 < -0.01 or y0 < -0.01 or x1 > L.value + 0.01 or y1 > W.value + 0.01:
                    d.block(f"Pièce {i + 1}, usinage {j + 1} : hors de la pièce.")
                feats.append(ft)
            d.parts.append(Part("", name, int(_val(pc["qty"])) * n_meubles, material_id=mat_id,
                                material_name=mat["nom"], thickness=e, length=L, width=W,
                                grain_x=bool(pc.get("grain", mat["fil"])),
                                rotation_allowed=not bool(pc.get("grain", mat["fil"])) and bool(pc.get("rotation_allowed", True)),
                                corner_r=float(_val(pc.get("corner_r")) or 0), features=feats, contour=contour,
                                assembly=pc.get("assembly", ""), orientation=pc.get("orientation", ""),
                                notes=[pc["note"]] if pc.get("note") else []))
        d.number_parts()
        # Vue d'ensemble indisponible sans modèle 3D : on aligne les pièces.
        x = 0.0
        rects = []
        for p in d.parts:
            rects.append({"name": p.name, "x": x, "y": 0, "w": p.length.value, "h": p.width.value})
            x += p.length.value + 50
        d.elevation = {"title": "Pièces (vue à plat, sans assemblage)", "width": max(x - 50, 1),
                       "height": max([p.width.value for p in d.parts] or [1]), "rects": rects, "flat": True}
        return d
