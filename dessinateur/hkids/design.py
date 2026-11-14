"""Calcul complet d'une version de projet : questions, pièces, débit,
compléments, calepinage et empreinte (hash) servant aux validations."""
from __future__ import annotations

import hashlib
import json

from .furniture import get_model
from .model import EXTRA_CATEGORIES, FEATURE_LABELS
from .nesting import nest
from .profile import material_question, rule_question, usinage_question
from .provenance import A_CONFIRMER, fmt


def canonical_hash(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def _part_checks(part: dict, profile: dict) -> list[dict]:
    out = []
    L, W, e = part["length"]["value"], part["width"]["value"], part["thickness"]["value"]
    tools = sorted(t["diametre"] for t in profile["outils"])
    for f in part["features"]:
        if "diameter" in f:
            r = f["diameter"]["value"] / 2
            x0, y0, x1, y1 = f["x"]["value"] - r, f["y"]["value"] - r, f["x"]["value"] + r, f["y"]["value"] + r
        else:
            x0, y0 = f["x"]["value"], f["y"]["value"]
            x1, y1 = x0 + f["w"]["value"], y0 + f["h"]["value"]
            if tools and min(f["w"]["value"], f["h"]["value"]) < tools[0] - 1e-6:
                out.append({"level": "bloquant", "text": f"{part['ref']} : {f['label']} plus étroite "
                            f"({fmt(min(f['w']['value'], f['h']['value']))} mm) que la plus petite fraise "
                            f"(Ø{fmt(tools[0])})."})
        if x0 < -0.01 or y0 < -0.01 or x1 > L + 0.01 or y1 > W + 0.01:
            out.append({"level": "bloquant", "text": f"{part['ref']} : {f['label']} sort de la pièce."})
        if not f["through"] and f["depth"]["value"] >= e:
            out.append({"level": "bloquant", "text": f"{part['ref']} : {f['label']} plus profonde que l'épaisseur."})
        if "diameter" in f and tools and f["diameter"]["value"] < tools[0] - 1e-6:
            out.append({"level": "bloquant", "text": f"{part['ref']} : perçage Ø{fmt(f['diameter']['value'])} "
                        f"plus petit que la plus petite fraise (Ø{fmt(tools[0])})."})
    out += _contour_checks(part)
    return out


def _feature_polygon(f: dict):
    from shapely.geometry import Point, Polygon, box
    from .shapes import discretize
    if f.get("path"):
        return Polygon(discretize(f["path"], 0.1))
    if "diameter" in f:
        return Point(f["x"]["value"], f["y"]["value"]).buffer(f["diameter"]["value"] / 2, quad_segs=32)
    x, y = f["x"]["value"], f["y"]["value"]
    return box(x, y, x + f["w"]["value"], y + f["h"]["value"])


def _contour_checks(part: dict) -> list[dict]:
    """Pièce de forme : contour cohérent avec le débit, usinages à l'intérieur avec assez de matière."""
    c = part.get("contour")
    if not c or not c.get("path"):
        return []
    from shapely.geometry import Polygon
    from .shapes import bbox, discretize
    out = []
    x0, y0, x1, y1 = bbox(c["path"])
    L, W = part["length"]["value"], part["width"]["value"]
    if abs(x0) > 0.05 or abs(y0) > 0.05 or abs(x1 - L) > 0.05 or abs(y1 - W) > 0.05:
        out.append({"level": "bloquant", "text": f"{part['ref']} : le contour ({fmt(x1 - x0)} × {fmt(y1 - y0)}) ne "
                    f"correspond pas au débit {fmt(L)} × {fmt(W)}."})
    cp = Polygon(discretize(c["path"], 0.1))
    if not cp.is_valid:
        out.append({"level": "bloquant", "text": f"{part['ref']} : contour invalide (il se recoupe)."})
        return out
    for f in part["features"]:
        fp = _feature_polygon(f)
        if not cp.buffer(0.01).contains(fp):
            out.append({"level": "bloquant", "text": f"{part['ref']} : {f['label']} sort du contour de la pièce."})
            continue
        web = cp.exterior.distance(fp)
        if web < 8:
            out.append({"level": "bloquant", "text": f"{part['ref']} : {f['label']} à {fmt(web)} mm du bord "
                        "(8 mm de matière minimum)."})
        elif web < 20:
            out.append({"level": "avertissement", "text": f"{part['ref']} : {f['label']} à {fmt(web)} mm du bord, "
                        "matière fragile."})
    return out


def cutlist_rows(parts: list[dict]) -> list[dict]:
    rows = []
    for p in parts:
        obs = []
        if p["grain_x"]:
            obs.append("Fil dans la longueur (rotation interdite)")
        if p.get("grain_y"):
            obs.append("Fil dans la hauteur (pièce tournée sur le panneau)")
        kinds = {}
        for f in p["features"]:
            kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
        if kinds:
            obs.append(", ".join(f"{n} {FEATURE_LABELS[k].lower()}{'s' if n > 1 else ''}" for k, n in kinds.items()))
        if p.get("corner_r"):
            obs.append(f"Angles R{fmt(p['corner_r'])}")
        if p.get("contour"):
            obs.append(f"Forme : {p['contour'].get('label') or p['contour'].get('shape')} (débit = encombrement)")
        obs.extend(p["edges"])
        obs.extend(p["notes"])
        if p["source"] == A_CONFIRMER:
            obs.insert(0, "⚠ COTES À CONFIRMER")
        rows.append({"ref": p["ref"], "designation": p["name"],
                     "dimensions": f"{fmt(p['length']['value'])} × {fmt(p['width']['value'])}",
                     "length": p["length"], "width": p["width"], "qty": p["qty"], "material": p["material_name"],
                     "thickness": p["thickness"], "observations": " · ".join(obs), "source": p["source"]})
    return rows


def compute(spec: dict, profile: dict) -> dict:
    model = get_model(spec["type"])
    params = spec.get("params", {})
    res = {"type": spec["type"], "model_name": model.name, "built": False, "errors": [], "warnings": [],
           "questions": [], "parts": [], "extras": [], "nesting": None, "cutlist": [], "elevation": {}}
    res["errors"] = model.check_values(params, profile)
    res["questions"] = model.questions(params, profile)
    if res["errors"] or not model.can_build(params):
        res["design_hash"] = None
        return res
    try:
        design = model.build(params, profile)
    except KeyError as exc:  # paramètre ou matière manquante
        res["errors"].append(f"Donnée manquante : {exc}")
        res["design_hash"] = None
        return res
    parts = [p.to_dict() for p in design.parts]
    res["parts"] = parts
    res["extras"] = [x.to_dict() for x in design.extras]
    res["extra_categories"] = EXTRA_CATEGORIES
    res["warnings"] = list(design.warnings)
    for p in parts:
        res["warnings"].extend(_part_checks(p, profile))
    res["elevation"] = design.elevation
    res["cutlist"] = cutlist_rows(parts)
    # Questions de profil liées aux matières et méthodes réellement utilisées
    pq = [material_question(profile, m) for m in sorted(design.used_materials)]
    pq += [rule_question(profile, r) for r in sorted(design.used_rules)]
    pq.append(usinage_question(profile))
    res["questions"] += [q for q in pq if q]
    res["built"] = True
    if parts:
        res["nesting"] = nest(parts, profile)
    res["design_hash"] = canonical_hash({"params": params, "type": spec["type"], "parts": parts,
                                         "extras": res["extras"], "nesting": res["nesting"]})
    return res


def readiness(res: dict) -> dict:
    """Ce qui empêche la validation du dessin par Hiba."""
    reasons = []
    if not res["built"]:
        reasons.append("Le meuble ne peut pas encore être décomposé (informations manquantes).")
    reasons += res["errors"]
    reasons += [w["text"] for w in res["warnings"] if w["level"] == "bloquant"]
    open_q = [q for q in res["questions"] if q["stage"] == "dessin"]
    if open_q:
        reasons.append(f"{len(open_q)} question(s) indispensable(s) sans réponse.")
    n_conf = [p["ref"] for p in res["parts"] if p["source"] == A_CONFIRMER]
    if n_conf:
        reasons.append("Cotes à confirmer sur : " + ", ".join(n_conf) + ".")
    if res.get("nesting"):
        reasons += res["nesting"]["errors"]
    extras_conf = [x["designation"] for x in res["extras"] if x["source"] == A_CONFIRMER]
    return {"ready": not reasons, "reasons": reasons, "extras_to_accept": extras_conf}
