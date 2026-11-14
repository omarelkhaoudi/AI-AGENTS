"""Export DXF (R2010, millimètres, échelle 1:1) depuis les primitives communes.

Calques : CONTOUR_EXT, OUVERTURE_TRAV, PERCAGE_D<Ø>_<P…|TRAV>, RAINURE_P<prof>,
POCHE_P<prof> (+ PANNEAU, MARGE, ZONE_EXCLUE, ETIQUETTE, ORIGINE pour le
placement). Les noms de calques portent l'opération et la profondeur afin de
pouvoir appliquer des modèles de parcours dans Aspire.
"""
from __future__ import annotations

import io
import math

import ezdxf
import ezdxf.bbox
from ezdxf import units

from .geometry import layer_color, part_primitives, placed_primitives

BULGE_90 = math.tan(math.radians(90) / 4)


def _new_doc():
    doc = ezdxf.new("R2010", setup=False)
    doc.units = units.MM
    doc.header["$INSUNITS"] = 4       # millimètres
    doc.header["$MEASUREMENT"] = 1    # métrique
    doc.header["$LUNITS"] = 2
    return doc


def _layer(doc, name):
    if name not in doc.layers:
        doc.layers.add(name, color=layer_color(name))
    return name


def rrect_points(x, y, w, h, r):
    """Sommets (x, y, bulge) d'un rectangle à angles arrondis, sens trigonométrique."""
    r = max(0.0, min(r, w / 2, h / 2))
    if r <= 1e-9:
        return [(x, y, 0), (x + w, y, 0), (x + w, y + h, 0), (x, y + h, 0)]
    b = BULGE_90
    return [(x + r, y, 0), (x + w - r, y, b), (x + w, y + r, 0), (x + w, y + h - r, b),
            (x + w - r, y + h, 0), (x + r, y + h, b), (x, y + h - r, 0), (x, y + r, b)]


def _write_prim(msp, doc, prim):
    layer = _layer(doc, prim["layer"])
    if prim["type"] == "path":
        msp.add_lwpolyline([tuple(p) for p in prim["points"]], format="xyb", close=True, dxfattribs={"layer": layer})
        return
    if prim["type"] == "circle":
        msp.add_circle((prim["cx"], prim["cy"]), prim["r"], dxfattribs={"layer": layer})
    else:
        pts = rrect_points(prim["x"], prim["y"], prim["w"], prim["h"], prim.get("r", 0))
        msp.add_lwpolyline(pts, format="xyb", close=True, dxfattribs={"layer": layer})


def _to_bytes(doc) -> bytes:
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode("utf-8")


def part_dxf(part: dict) -> bytes:
    doc = _new_doc()
    msp = doc.modelspace()
    for prim in part_primitives(part):
        _write_prim(msp, doc, prim)
    return _to_bytes(doc)


def sheet_dxf(group: dict, sheet: dict, parts_by_ref: dict, with_labels: bool = True) -> bytes:
    doc = _new_doc()
    msp = doc.modelspace()
    ps = group["panel"]
    PL, PW, m = ps["length"], ps["width"], ps["margin"]
    msp.add_lwpolyline(rrect_points(0, 0, PL, PW, 0), format="xyb", close=True,
                       dxfattribs={"layer": _layer(doc, "PANNEAU")})
    msp.add_lwpolyline(rrect_points(m, m, PL - 2 * m, PW - 2 * m, 0), format="xyb", close=True,
                       dxfattribs={"layer": _layer(doc, "MARGE")})
    for z in ps["zones"]:
        msp.add_lwpolyline(rrect_points(z["x"], z["y"], z["w"], z["h"], 0), format="xyb", close=True,
                           dxfattribs={"layer": _layer(doc, "ZONE_EXCLUE")})
    lo = _layer(doc, "ORIGINE")
    msp.add_line((0, 0), (50, 0), dxfattribs={"layer": lo})
    msp.add_line((0, 0), (0, 50), dxfattribs={"layer": lo})
    for pl in sheet["placements"]:
        part = parts_by_ref[pl["ref"]]
        for prim in placed_primitives(part, pl):
            _write_prim(msp, doc, prim)
        if with_labels:
            h = max(8.0, min(40.0, min(pl["w"], pl["h"]) / 4))
            t = msp.add_text(f"{pl['ref']}-{pl['instance']}", height=h,
                             dxfattribs={"layer": _layer(doc, "ETIQUETTE")})
            t.set_placement((pl["x"] + pl["w"] / 2, pl["y"] + pl["h"] / 2),
                            align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
    return _to_bytes(doc)


def read_geometry(data: bytes) -> list[dict]:
    """Relit un DXF produit ici (utilisé par les tests de réception)."""
    doc = ezdxf.read(io.StringIO(data.decode("utf-8")))
    out = []
    for e in doc.modelspace():
        if e.dxftype() == "CIRCLE":
            out.append({"layer": e.dxf.layer, "type": "circle", "cx": e.dxf.center.x, "cy": e.dxf.center.y,
                        "r": e.dxf.radius})
        elif e.dxftype() == "LWPOLYLINE":
            ext = ezdxf.bbox.extents([e], fast=False)
            out.append({"layer": e.dxf.layer, "type": "poly", "x0": ext.extmin.x, "y0": ext.extmin.y,
                        "x1": ext.extmax.x, "y1": ext.extmax.y, "closed": e.closed,
                        "points": [list(p) for p in e.get_points("xyb")]})
    out_units = doc.header.get("$INSUNITS")
    return [dict(o, insunits=out_units) for o in out]
