"""Primitives géométriques uniques, partagées par les dessins SVG, les DXF,
le calepinage et les parcours d'usinage (une seule source de vérité).

Une primitive est un dict :
- ``{"type": "rrect", "x", "y", "w", "h", "r", "layer", "kind", "depth", "through"}``
- ``{"type": "circle", "cx", "cy", "r", "layer", "kind", "depth", "through"}``
"""
from __future__ import annotations

from . import shapes as S
from .model import OUVERTURE, PERCAGE, POCHE, RAINURE
from .provenance import fmt

LAYER_CONTOUR = "CONTOUR_EXT"
LAYER_COLORS = {"CONTOUR_EXT": 7, "OUVERTURE": 1, "PERCAGE": 5, "RAINURE": 3, "POCHE": 4, "PANNEAU": 8,
                "MARGE": 9, "ZONE_EXCLUE": 1, "ETIQUETTE": 2, "ORIGINE": 6}


def _num(v: float) -> str:
    return fmt(v).replace(".", "_")


def layer_for(kind: str, depth: float | None, through: bool, diameter: float | None = None) -> str:
    """Nom de calque explicite : type + profondeur (repris par les modèles de parcours Aspire)."""
    if kind == OUVERTURE:
        return "OUVERTURE_TRAV"
    p = "TRAV" if through else f"P{_num(depth)}"
    if kind == PERCAGE:
        return f"PERCAGE_D{_num(diameter)}_{p}"
    if kind == RAINURE:
        return f"RAINURE_{p}"
    if kind == POCHE:
        return f"POCHE_{p}"
    raise ValueError(kind)


def layer_color(layer: str) -> int:
    return LAYER_COLORS.get(layer.split("_")[0], LAYER_COLORS.get(layer, 7))


def part_primitives(part: dict) -> list[dict]:
    """Primitives d'une pièce (dict sérialisé), dans le repère pièce."""
    L, W = part["length"]["value"], part["width"]["value"]
    if part.get("contour") and part["contour"].get("path"):
        prims = [{"type": "path", "points": [list(p) for p in part["contour"]["path"]], "layer": LAYER_CONTOUR,
                  "kind": "contour", "through": True, "depth": None}]
    else:
        prims = [{"type": "rrect", "x": 0.0, "y": 0.0, "w": L, "h": W, "r": part.get("corner_r", 0.0),
                  "layer": LAYER_CONTOUR, "kind": "contour", "through": True, "depth": None}]
    for f in part["features"]:
        depth = None if f["through"] else f["depth"]["value"]
        base = {"kind": f["kind"], "through": f["through"], "depth": depth, "label": f["label"]}
        if f.get("path"):
            prims.append({**base, "type": "path", "points": [list(p) for p in f["path"]],
                          "layer": layer_for(f["kind"], depth, f["through"])})
        elif "diameter" in f:
            dia = f["diameter"]["value"]
            prims.append({**base, "type": "circle", "cx": f["x"]["value"], "cy": f["y"]["value"], "r": dia / 2,
                          "layer": layer_for(f["kind"], depth, f["through"], dia)})
        else:
            prims.append({**base, "type": "rrect", "x": f["x"]["value"], "y": f["y"]["value"],
                          "w": f["w"]["value"], "h": f["h"]["value"], "r": f.get("corner_r", 0.0),
                          "layer": layer_for(f["kind"], depth, f["through"])})
    return prims


def transform(prim: dict, part_width: float, rotated: bool, dx: float, dy: float) -> dict:
    """Place une primitive sur le panneau : rotation de 90° (sens trigo) puis translation.

    Rotation : (x, y) → (largeur_pièce − y, x).
    """
    p = dict(prim)
    if prim["type"] == "path":
        pts = S.rotate90(prim["points"], part_width) if rotated else prim["points"]
        p["points"] = S.translate(pts, dx, dy)
        return p
    if prim["type"] == "circle":
        cx, cy = prim["cx"], prim["cy"]
        if rotated:
            cx, cy = part_width - cy, cx
        p["cx"], p["cy"] = cx + dx, cy + dy
    else:
        x, y, w, h = prim["x"], prim["y"], prim["w"], prim["h"]
        if rotated:
            x, y, w, h = part_width - y - h, x, h, w
        p.update(x=x + dx, y=y + dy, w=w, h=h)
    return p


def bbox(prim: dict) -> tuple[float, float, float, float]:
    if prim["type"] == "path":
        return S.bbox(prim["points"])
    if prim["type"] == "circle":
        return (prim["cx"] - prim["r"], prim["cy"] - prim["r"], prim["cx"] + prim["r"], prim["cy"] + prim["r"])
    return (prim["x"], prim["y"], prim["x"] + prim["w"], prim["y"] + prim["h"])


def placed_primitives(part: dict, placement: dict) -> list[dict]:
    return [transform(p, part["width"]["value"], placement["rotated"], placement["x"], placement["y"])
            for p in part_primitives(part)]
