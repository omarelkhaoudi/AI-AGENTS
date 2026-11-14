"""Calepinage des pièces sur panneaux (algorithme MaxRects, déterministe)
et vérification indépendante du résultat.

Repère panneau : origine au coin avant gauche, X le long de la longueur du
panneau (sens du fil du panneau), Y le long de la largeur.
Règles : marge périphérique, espacement minimal entre pièces (≥ Ø fraise de
contour), zones de fixation exclues, rotation interdite si fil imposé,
quantités exactes.
"""
from __future__ import annotations

from .profile import tool

EPS = 1e-6


class MaxRects:
    def __init__(self, width: float, height: float, obstacles=()):
        self.free = [(0.0, 0.0, width, height)]
        for o in obstacles:
            self._occupy(o)

    def find(self, w, h, rot_allowed, heuristic, force_rot=False):
        best = None
        options = [(h, w, True)] if force_rot else [(w, h, False)] + ([(h, w, True)] if rot_allowed else [])
        for fx, fy, fw, fh in self.free:
            for ww, hh, rot in options:
                if ww <= fw + EPS and hh <= fh + EPS:
                    if heuristic == "bssf":
                        score = (min(fw - ww, fh - hh), max(fw - ww, fh - hh), fy, fx)
                    elif heuristic == "baf":
                        score = (fw * fh - ww * hh, min(fw - ww, fh - hh), fy, fx)
                    else:  # bl : coin bas-gauche
                        score = (fy + hh, fx, 0, 0)
                    if best is None or score < best[0]:
                        best = (score, fx, fy, ww, hh, rot)
        return best

    def _occupy(self, r):
        rx, ry, rw, rh = r
        new = []
        for f in self.free:
            fx, fy, fw, fh = f
            if rx >= fx + fw - EPS or rx + rw <= fx + EPS or ry >= fy + fh - EPS or ry + rh <= fy + EPS:
                new.append(f)
                continue
            if rx > fx + EPS:
                new.append((fx, fy, rx - fx, fh))
            if rx + rw < fx + fw - EPS:
                new.append((rx + rw, fy, fx + fw - rx - rw, fh))
            if ry > fy + EPS:
                new.append((fx, fy, fw, ry - fy))
            if ry + rh < fy + fh - EPS:
                new.append((fx, ry + rh, fw, fy + fh - ry - rh))
        self.free = [a for i, a in enumerate(new) if not any(
            i != j and _contains(b, a) and (not _contains(a, b) or j < i) for j, b in enumerate(new))]

    def place(self, x, y, w, h):
        self._occupy((x, y, w, h))


def _contains(a, b):
    return (b[0] >= a[0] - EPS and b[1] >= a[1] - EPS and b[0] + b[2] <= a[0] + a[2] + EPS
            and b[1] + b[3] <= a[1] + a[3] + EPS)


def panel_setup(profile: dict, mat_id: str) -> dict:
    m = profile["materiaux"][mat_id]
    p = m["panneau"]
    return {"length": float(p["longueur"]), "width": float(p["largeur"]), "margin": float(p["marge"]),
            "zones": [dict(z) for z in p.get("zones_exclues", [])], "grain": bool(m["fil"])}


def spacing(profile: dict) -> float:
    return float(profile["usinage"]["espacement_pieces"])


def _instances(parts: list[dict]) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for p in parts:
        if not p.get("cnc", True):
            continue
        for i in range(p["qty"]):
            groups.setdefault(p["material_id"], []).append({
                "ref": p["ref"], "instance": i + 1, "l": p["length"]["value"], "w": p["width"]["value"],
                "rot": bool(p["rotation_allowed"]), "force": bool(p.get("grain_y"))})
    return groups


SORTS = {
    "aire": lambda it: (-(it["l"] * it["w"]), -max(it["l"], it["w"])),
    "cote_max": lambda it: (-max(it["l"], it["w"]), -(it["l"] * it["w"])),
    "longueur": lambda it: (-it["l"], -it["w"]),
    "largeur": lambda it: (-it["w"], -it["l"]),
}


def _fill_sheet(items, W, H, s, obstacles):
    """Remplit un panneau ; essaie plusieurs heuristiques et garde la meilleure."""
    best = None
    for sort_name, key in SORTS.items():
        for heur in ("bssf", "baf", "bl"):
            mr = MaxRects(W, H, obstacles)
            placed, rest = [], []
            for it in sorted(items, key=key):
                f = mr.find(it["l"] + s, it["w"] + s, it["rot"], heur, it.get("force", False))
                if f is None:
                    rest.append(it)
                    continue
                _, x, y, ww, hh, rot = f
                mr.place(x, y, ww, hh)
                placed.append((it, x, y, rot))
            area = sum(it["l"] * it["w"] for it, *_ in placed)
            score = (area, -len(rest))
            if best is None or score > best[0]:
                best = (score, placed, rest, f"{sort_name}/{heur}")
    return best[1], best[2], best[3]


def nest(parts: list[dict], profile: dict) -> dict:
    s = spacing(profile)
    out = {"groups": [], "errors": [], "warnings": [], "spacing": s}
    t = tool(profile, profile["usinage"]["outil_contour"])
    if t and s < t["diametre"] + 1:
        out["errors"].append(f"Espacement entre pièces ({s} mm) inférieur au Ø de la fraise de contour "
                             f"({t['diametre']} mm) + 1 mm : les parcours se chevaucheraient.")
    by_ref = {p["ref"]: p for p in parts}
    for mat_id, items in _instances(parts).items():
        ps = panel_setup(profile, mat_id)
        m = ps["margin"]
        W = ps["length"] - 2 * m + s
        H = ps["width"] - 2 * m + s
        obstacles = []
        for z in ps["zones"]:
            obstacles.append((z["x"] - m, z["y"] - m, z["w"] + s, z["h"] + s))
        group = {"material_id": mat_id, "material_name": profile["materiaux"][mat_id]["nom"],
                 "thickness": by_ref[items[0]["ref"]]["thickness"]["value"], "panel": ps, "sheets": [],
                 "unplaced": []}
        todo = []
        for it in items:
            straight = it["l"] + s <= W + EPS and it["w"] + s <= H + EPS
            turned = it["w"] + s <= W + EPS and it["l"] + s <= H + EPS
            fits = turned if it.get("force") else (straight or (it["rot"] and turned))
            if not fits:
                group["unplaced"].append(it)
                out["errors"].append(
                    f"{it['ref']} ({it['l']}×{it['w']}) ne tient pas dans le panneau utile "
                    f"{ps['length'] - 2 * m}×{ps['width'] - 2 * m} de {group['material_name']}"
                    + (" (fil vertical : pièce obligatoirement tournée)" if it.get("force") else
                       "" if it["rot"] else " (rotation interdite : sens du fil)") + ".")
            else:
                todo.append(it)
        guard = 0
        while todo and guard < 500:
            guard += 1
            placed, todo, heur = _fill_sheet(todo, W, H, s, obstacles)
            if not placed:
                out["errors"].append(f"Placement impossible pour {len(todo)} pièce(s) de {group['material_name']} "
                                     "(zones exclues ?).")
                group["unplaced"].extend(todo)
                break
            plc = []
            for it, x, y, rot in placed:
                plc.append({"ref": it["ref"], "instance": it["instance"], "x": round(m + x, 3),
                            "y": round(m + y, 3), "w": it["w"] if rot else it["l"], "h": it["l"] if rot else it["w"],
                            "rotated": rot})
            plc.sort(key=lambda p: (p["ref"], p["instance"]))
            used = sum(p["w"] * p["h"] for p in plc)
            group["sheets"].append({"index": len(group["sheets"]) + 1, "placements": plc,
                                    "utilization": round(100 * used / (ps["length"] * ps["width"]), 1),
                                    "heuristic": heur})
        out["groups"].append(group)
    out["total_sheets"] = sum(len(g["sheets"]) for g in out["groups"])
    out["errors"].extend(verify(out, parts, profile))
    return out


def verify(nesting: dict, parts: list[dict], profile: dict) -> list[str]:
    """Contrôle indépendant : limites, chevauchements, zones exclues, quantités, rotations."""
    errs = []
    s = nesting["spacing"]
    by_ref = {p["ref"]: p for p in parts}
    expected = {p["ref"]: p["qty"] for p in parts if p.get("cnc", True)}
    counted: dict[str, int] = {}
    for g in nesting["groups"]:
        ps = g["panel"]
        m = ps["margin"]
        for it in g["unplaced"]:
            counted[it["ref"]] = counted.get(it["ref"], 0)
        for sh in g["sheets"]:
            pl = sh["placements"]
            for p in pl:
                counted[p["ref"]] = counted.get(p["ref"], 0) + 1
                part = by_ref[p["ref"]]
                L, W = part["length"]["value"], part["width"]["value"]
                exp = (W, L) if p["rotated"] else (L, W)
                if abs(p["w"] - exp[0]) > 0.01 or abs(p["h"] - exp[1]) > 0.01:
                    errs.append(f"{p['ref']} : dimensions placées incohérentes.")
                if part.get("grain_y"):
                    if not p["rotated"]:
                        errs.append(f"{p['ref']} : fil dans la hauteur, la pièce doit être tournée de 90°.")
                elif p["rotated"] and not part["rotation_allowed"]:
                    errs.append(f"{p['ref']} : rotation interdite (sens du fil) mais pièce tournée.")
                if (p["x"] < m - EPS or p["y"] < m - EPS or p["x"] + p["w"] > ps["length"] - m + 1e-3
                        or p["y"] + p["h"] > ps["width"] - m + 1e-3):
                    errs.append(f"{p['ref']} (panneau {sh['index']}) sort de la zone utile du panneau.")
                for z in ps["zones"]:
                    if _gap(p, z) < s - 1e-3:
                        errs.append(f"{p['ref']} (panneau {sh['index']}) trop proche d'une zone de fixation.")
            for i in range(len(pl)):
                for j in range(i + 1, len(pl)):
                    if _gap(pl[i], pl[j]) < s - 1e-3:
                        errs.append(f"{pl[i]['ref']} et {pl[j]['ref']} (panneau {sh['index']}) : chevauchement "
                                    f"ou espacement inférieur à {s} mm.")
    for ref, q in expected.items():
        if counted.get(ref, 0) != q:
            errs.append(f"{ref} : {counted.get(ref, 0)} exemplaire(s) placés pour {q} demandé(s).")
    return errs


def _gap(a: dict, b: dict) -> float:
    """Distance minimale entre deux rectangles alignés (négative si chevauchement)."""
    bx = b.get("x"), b.get("y"), b.get("w"), b.get("h")
    dx = max(bx[0] - (a["x"] + a["w"]), a["x"] - (bx[0] + bx[2]))
    dy = max(bx[1] - (a["y"] + a["h"]), a["y"] - (bx[1] + bx[3]))
    if dx < 0 and dy < 0:
        return max(dx, dy)
    return max(dx, dy) if (dx < 0 or dy < 0) else (dx * dx + dy * dy) ** 0.5
