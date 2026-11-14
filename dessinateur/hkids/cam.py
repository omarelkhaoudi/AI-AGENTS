"""Moteur CAM simple (phase 3) : parcours 2,5D à partir des primitives.

Stratégie par panneau, dans cet ordre (une pièce n'est jamais détourée avant
ses usinages intérieurs) :
1. perçages (plongée débourrée si Ø fraise = Ø trou, sinon interpolation
   circulaire) ;
2. rainures et poches (vidage concentrique, de l'intérieur vers l'extérieur) ;
3. ouvertures (contour intérieur traversant) ;
4. contours extérieurs (traversants, avec onglets de maintien).

Les mouvements sont des dicts neutres ; le texte G-code est produit par un
post-processeur (``postprocessors``).
"""
from __future__ import annotations

import math

from . import shapes as S
from .geometry import placed_primitives
from .model import OUVERTURE, PERCAGE, POCHE, RAINURE
from .profile import tool as get_tool

EPS = 1e-6


class CamError(Exception):
    pass


class PathBuilder:
    def __init__(self, z_clear: float):
        self.moves: list[dict] = []
        self.x = self.y = None
        self.z = z_clear

    def rapid(self, x=None, y=None, z=None):
        self.moves.append({"g": 0, "x": x, "y": y, "z": z})
        self._upd(x, y, z)

    def feed(self, f, x=None, y=None, z=None):
        self.moves.append({"g": 1, "x": x, "y": y, "z": z, "f": f})
        self._upd(x, y, z)

    def arc(self, f, ccw, x, y, cx, cy):
        self.moves.append({"g": 3 if ccw else 2, "x": x, "y": y, "i": cx - self.x, "j": cy - self.y, "f": f})
        self._upd(x, y, None)

    def _upd(self, x, y, z):
        if x is not None:
            self.x = x
        if y is not None:
            self.y = y
        if z is not None:
            self.z = z


def z_levels(z_top: float, z_bottom: float, step: float) -> list[float]:
    total = z_top - z_bottom
    n = max(1, math.ceil(total / step - 1e-9))
    return [z_top - total * (i + 1) / n for i in range(n)]


def rect_path(x0, y0, x1, y1, c, ccw=True):
    """Segments d'un rectangle à angles arrondis (rayon c au centre outil), départ milieu du bas."""
    c = max(0.0, min(c, (x1 - x0) / 2, (y1 - y0) / 2))
    sx = (x0 + x1) / 2
    seg = []
    pts = [((sx, y0), (x1 - c, y0)), ("arc", (x1, y0 + c), (x1 - c, y0 + c)),
           ((x1, y0 + c), (x1, y1 - c)), ("arc", (x1 - c, y1), (x1 - c, y1 - c)),
           ((x1 - c, y1), (x0 + c, y1)), ("arc", (x0, y1 - c), (x0 + c, y1 - c)),
           ((x0, y1 - c), (x0, y0 + c)), ("arc", (x0 + c, y0), (x0 + c, y0 + c)),
           ((x0 + c, y0), (sx, y0))]
    cur = (sx, y0)
    for p in pts:
        if p[0] == "arc":
            if c > EPS:
                seg.append(("arc", cur, p[1], p[2], True))
                cur = p[1]
        else:
            a, b = p
            if math.dist(a, b) > EPS:
                seg.append(("line", cur, b))
            cur = b
    if ccw:
        return seg
    rev = []
    for s in reversed(seg):
        if s[0] == "line":
            rev.append(("line", s[2], s[1]))
        else:
            rev.append(("arc", s[2], s[1], s[3], False))
    return rev


class SheetCam:
    def __init__(self, profile: dict, thickness: float, settings: dict):
        self.p = profile
        self.u = profile["usinage"]
        self.ep = thickness
        self.settings = settings
        zref = profile["machine"].get("origine_z") or "dessus_matiere"
        self.top = 0.0 if zref == "dessus_matiere" else thickness
        self.z_safe = self.top + float(self.u["hauteur_securite"])
        self.z_clear = self.top + float(self.u["hauteur_degagement"])
        self.z_through = self.top - thickness - float(self.u["depassement_martyr"])
        self.climb = self.u.get("sens_coupe", "avalant") == "avalant"

    # -- choix des fraises ----------------------------------------------------
    def tool(self, tid):
        t = get_tool(self.p, tid)
        if t is None:
            raise CamError(f"Fraise {tid} absente du profil.")
        return t

    def pick_tool(self, kind: str, size: float, depth: float, exact: float | None = None) -> dict:
        override = (self.settings.get("outils") or {}).get(kind)
        if override and override != "auto":
            t = self.tool(override)
            if t["diametre"] > size + EPS:
                raise CamError(f"Fraise {override} (Ø{t['diametre']}) trop grosse pour {kind} de {size} mm.")
            return t
        if kind in ("contour", OUVERTURE):
            t = self.tool(self.u["outil_contour"])
            if t["diametre"] <= size + EPS and t["longueur_utile"] >= depth - EPS:
                return t
        cands = [t for t in self.p["outils"] if t["diametre"] <= size + EPS and t["longueur_utile"] >= depth - EPS]
        if exact is not None:
            ex = [t for t in cands if abs(t["diametre"] - exact) < 0.05]
            if ex:
                return ex[0]
        if not cands:
            raise CamError(f"Aucune fraise adaptée pour {kind} de {size} mm à {depth} mm de profondeur.")
        return max(cands, key=lambda t: t["diametre"])

    # -- opérations -------------------------------------------------------------
    def depth_z(self, prim) -> float:
        if prim["through"]:
            return self.z_through
        return self.top - prim["depth"]

    def op_drill(self, prim, ref) -> dict:
        d = 2 * prim["r"]
        zb = self.depth_z(prim)
        t = self.pick_tool(PERCAGE, d, self.top - zb, exact=d)
        D = t["diametre"]
        pb = PathBuilder(self.z_clear)
        cx, cy = prim["cx"], prim["cy"]
        rr = (d - D) / 2
        if rr < 0.05:
            pb.rapid(cx, cy, None)
            pb.rapid(z=self.z_safe)
            for z in z_levels(self.top, zb, t["passe_max"]):
                pb.feed(t["plongee"], z=z)
                pb.rapid(z=self.z_safe)
            strategy = "plongée débourrée"
        else:
            pb.rapid(cx + rr, cy, None)
            pb.rapid(z=self.z_safe)
            for z in z_levels(self.top, zb, t["passe_max"]):
                pb.feed(t["plongee"], z=z)
                ccw = not self.climb  # intérieur : avalant = sens horaire
                pb.arc(t["avance"], ccw, cx - rr, cy, cx, cy)
                pb.arc(t["avance"], ccw, cx + rr, cy, cx, cy)
            pb.rapid(z=self.z_safe)
            strategy = "interpolation circulaire"
        return {"type": PERCAGE, "tool": t["id"], "ref": ref, "moves": pb.moves, "x": cx, "y": cy,
                "label": f"{ref} perçage Ø{d:g} ({strategy})", "depth": round(self.top - zb, 3)}

    def op_pocket(self, prim, ref) -> dict:
        if prim["type"] != "rrect":
            raise CamError(f"{ref} : poche ou rainure de forme non rectangulaire — à préparer dans Aspire (mode assisté).")
        w, h = prim["w"], prim["h"]
        zb = self.depth_z(prim)
        t = self.pick_tool(prim["kind"], min(w, h), self.top - zb)
        D = t["diametre"]
        r = D / 2
        step = D * (1 - float(self.u.get("recouvrement", 0.4)))
        x0, y0, x1, y1 = prim["x"], prim["y"], prim["x"] + w, prim["y"] + h
        half = min(w, h) / 2
        # anneaux concentriques : le dernier doit couvrir le centre (k + r ≥ demi-largeur)
        k = min(r, half)
        insets = [k]
        while k + r < half - EPS:
            k = min(k + step, half)
            insets.append(k)
        insets = sorted(set(round(i, 4) for i in insets), reverse=True)  # intérieur → extérieur
        pb = PathBuilder(self.z_clear)
        start = None
        for z in z_levels(self.top, zb, t["passe_max"]):
            first = True
            for ins in insets:
                rx0, ry0, rx1, ry1 = x0 + ins, y0 + ins, x1 - ins, y1 - ins
                if first:
                    start = (rx0, ry0)
                    if pb.x is None or (pb.x, pb.y) != start:
                        pb.rapid(z=self.z_safe)
                        pb.rapid(*start, None)
                    pb.feed(t["plongee"], z=z)
                    first = False
                else:
                    pb.feed(t["avance"], rx0, ry0, None)
                if rx1 - rx0 < EPS and ry1 - ry0 < EPS:
                    continue
                if rx1 - rx0 < EPS or ry1 - ry0 < EPS:
                    pb.feed(t["avance"], rx1, ry1, None)
                    pb.feed(t["avance"], rx0, ry0, None)
                    continue
                for px, py in ((rx1, ry0), (rx1, ry1), (rx0, ry1), (rx0, ry0)):
                    pb.feed(t["avance"], px, py, None)
            pb.rapid(z=self.z_safe)
        return {"type": prim["kind"], "tool": t["id"], "ref": ref, "moves": pb.moves, "x": x0, "y": y0,
                "label": f"{ref} {prim['kind']} {w:g}×{h:g} p{self.top - zb:g}", "depth": round(self.top - zb, 3)}

    def op_profile(self, prim, ref, outside: bool) -> dict:
        kind = "contour" if outside else OUVERTURE
        if prim["type"] == "circle":
            size = 2 * prim["r"]
        elif prim["type"] == "path":
            bx0, by0, bx1, by1 = S.bbox(prim["points"])
            size = min(bx1 - bx0, by1 - by0)
        else:
            size = min(prim["w"], prim["h"])
        zb = self.z_through
        t = self.pick_tool(kind, 1e9 if outside else size, self.top - zb)
        D = t["diametre"]
        r = D / 2
        tabs = self.u.get("onglets", {})
        tab_on = bool(tabs.get("actifs"))
        z_tab = zb + float(tabs.get("hauteur", 3)) + float(self.u["depassement_martyr"])
        tab_len = float(tabs.get("largeur", 8)) + D
        min_side = float(tabs.get("longueur_mini_cote", 150))
        ccw = (not self.climb) if outside else self.climb
        pb = PathBuilder(self.z_clear)
        if prim["type"] == "circle":
            R = prim["r"] + (r if outside else -r)
            if R <= EPS:
                raise CamError(f"{ref} : cercle trop petit pour la fraise Ø{D}.")
            cx, cy = prim["cx"], prim["cy"]
            pb.rapid(z=self.z_safe)
            pb.rapid(cx + R, cy, None)
            for z in z_levels(self.top, zb, t["passe_max"]):
                pb.feed(t["plongee"], z=z)
                pb.arc(t["avance"], ccw, cx - R, cy, cx, cy)
                pb.arc(t["avance"], ccw, cx + R, cy, cx, cy)
            pb.rapid(z=self.z_clear)
            n_tabs = 0
        elif prim["type"] == "path":
            pts = offset_path(prim["points"], r if outside else -r, ref, D)
            if not ccw:
                pts = pts[::-1]
            perim = sum(math.dist(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts)))
            n_tabs = max(2, min(8, int(perim // 600) + 2)) if tab_on else 0
            if n_tabs and perim < n_tabs * tab_len * 2:
                n_tabs = 0
            intervals = [((k + 0.5) * perim / n_tabs - tab_len / 2, (k + 0.5) * perim / n_tabs + tab_len / 2)
                         for k in range(n_tabs)]
            levels = z_levels(self.top, zb, t["passe_max"])
            pb.rapid(z=self.z_safe)
            pb.rapid(pts[0][0], pts[0][1], None)
            for z in levels:
                pb.feed(t["plongee"], z=z)
                walk_polyline(pb, pts, z, z_tab, intervals if (tab_on and z < z_tab - EPS) else [],
                              t["avance"], t["plongee"])
            pb.rapid(z=self.z_clear)
            prim = dict(prim, x=S.bbox(prim["points"])[0], y=S.bbox(prim["points"])[1])
        else:
            x0, y0, x1, y1 = prim["x"], prim["y"], prim["x"] + prim["w"], prim["y"] + prim["h"]
            rc = prim.get("r", 0.0)
            if outside:
                x0, y0, x1, y1, c = x0 - r, y0 - r, x1 + r, y1 + r, rc + r
            else:
                if prim["w"] < D + EPS or prim["h"] < D + EPS:
                    raise CamError(f"{ref} : ouverture trop petite pour la fraise Ø{D}.")
                x0, y0, x1, y1, c = x0 + r, y0 + r, x1 - r, y1 - r, max(rc - r, 0.0)
            segs = rect_path(x0, y0, x1, y1, c, ccw)
            levels = z_levels(self.top, zb, t["passe_max"])
            pb.rapid(z=self.z_safe)
            pb.rapid(*segs[0][1], None)
            n_tabs = 0
            for z in levels:
                pb.feed(t["plongee"], z=z)
                with_tabs = tab_on and z < z_tab - EPS
                for s in segs:
                    if s[0] == "arc":
                        _, a, b, ctr, sccw = s
                        pb.arc(t["avance"], sccw, b[0], b[1], ctr[0], ctr[1])
                        continue
                    _, a, b = s
                    L = math.dist(a, b)
                    if with_tabs and L >= min_side:
                        m0 = 0.5 - tab_len / (2 * L)
                        m1 = 0.5 + tab_len / (2 * L)
                        p0 = (a[0] + (b[0] - a[0]) * m0, a[1] + (b[1] - a[1]) * m0)
                        p1 = (a[0] + (b[0] - a[0]) * m1, a[1] + (b[1] - a[1]) * m1)
                        pb.feed(t["avance"], p0[0], p0[1], None)
                        pb.feed(t["plongee"], z=z_tab)
                        pb.feed(t["avance"], p1[0], p1[1], None)
                        pb.feed(t["plongee"], z=z)
                        if z == levels[-1]:
                            n_tabs += 1
                    pb.feed(t["avance"], b[0], b[1], None)
            pb.rapid(z=self.z_clear)
        cx_, cy_ = (prim["cx"], prim["cy"]) if prim["type"] == "circle" else (prim["x"], prim["y"])
        return {"type": kind, "tool": t["id"], "ref": ref, "moves": pb.moves, "x": cx_, "y": cy_,
                "label": f"{ref} {'contour' if outside else 'ouverture'}", "tabs": n_tabs,
                "depth": round(self.top - zb, 3)}


def offset_path(points, dist: float, ref: str, D: float) -> list[tuple[float, float]]:
    """Parcours du centre de la fraise : contour décalé de ``dist`` (positif = extérieur), sens trigo.
    Les angles rentrants deviennent des arrondis au rayon de la fraise."""
    from shapely.geometry import Polygon
    from shapely.geometry.polygon import orient
    poly = Polygon(S.discretize(points, 0.02))
    if not poly.is_valid:
        poly = poly.buffer(0)
    off = poly.buffer(dist, quad_segs=32, join_style="round")
    if off.is_empty:
        raise CamError(f"{ref} : forme trop petite pour la fraise Ø{D:g}.")
    if off.geom_type != "Polygon":
        raise CamError(f"{ref} : forme trop étroite par endroits pour la fraise Ø{D:g} (le parcours se sépare).")
    coords = list(orient(off, 1.0).exterior.coords)[:-1]
    out = []
    for c in coords:
        if not out or math.dist(out[-1], c) > 0.005:
            out.append((round(c[0], 4), round(c[1], 4)))
    # départ au début du plus long segment (entrée de matière sur une partie droite)
    n = len(out)
    i0 = max(range(n), key=lambda i: math.dist(out[i], out[(i + 1) % n]))
    return out[i0:] + out[:i0]


def walk_polyline(pb: PathBuilder, pts, z, z_tab, intervals, feed, plunge):
    """Parcourt la polyligne fermée à la profondeur z en remontant à z_tab sur les intervalles (onglets),
    exprimés en abscisse curviligne depuis le premier point."""
    s = 0.0
    raised = False
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        L = math.dist(a, b)
        if L < 1e-9:
            continue
        cuts = sorted({t for u, v in intervals for t in (u, v) if s < t < s + L})
        prev = s
        for t in cuts + [s + L]:
            mid = (prev + t) / 2
            want = any(u <= mid <= v for u, v in intervals)
            if want != raised:
                pb.feed(plunge, z=z_tab if want else z)
                raised = want
            f = (t - s) / L
            pb.feed(feed, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, None)
            prev = t
        s += L
    if raised:
        pb.feed(plunge, z=z)


def _nearest_order(ops: list[dict]) -> list[dict]:
    rest = list(ops)
    out = []
    pos = (0.0, 0.0)
    while rest:
        nxt = min(rest, key=lambda o: (math.dist(pos, (o["x"], o["y"])), o["label"]))
        rest.remove(nxt)
        out.append(nxt)
        pos = (nxt["x"], nxt["y"])
    return out


def sheet_program(group: dict, sheet: dict, parts_by_ref: dict, profile: dict, settings: dict) -> dict:
    """Programme d'un panneau : liste ordonnée de fichiers (un par fraise si pas de changeur)."""
    cam = SheetCam(profile, group["thickness"], settings)
    drills, pockets, openings, contours = [], [], [], []
    errors = []
    for pl in sheet["placements"]:
        part = parts_by_ref[pl["ref"]]
        tag = f"{pl['ref']}-{pl['instance']}"
        prims = placed_primitives(part, pl)
        try:
            for prim in prims[1:]:
                if prim["kind"] == PERCAGE:
                    drills.append(cam.op_drill(prim, tag))
                elif prim["kind"] in (RAINURE, POCHE):
                    pockets.append(cam.op_pocket(prim, tag))
                elif prim["kind"] == OUVERTURE:
                    openings.append(cam.op_profile(prim, tag, outside=False))
            contours.append(cam.op_profile(prims[0], tag, outside=True))
        except CamError as exc:
            errors.append(str(exc))
    # Usinages intérieurs d'abord, groupés par fraise (fraise de contour en dernier pour
    # enchaîner sans changement d'outil), puis détourages.
    ordered = []
    feats = drills + pockets + openings
    ct = profile["usinage"]["outil_contour"]
    for tid in sorted({o["tool"] for o in feats}, key=lambda t: (t == ct, t)):
        for group_ops in (drills, pockets, openings):
            ordered += _nearest_order([o for o in group_ops if o["tool"] == tid])
    for tid in sorted({o["tool"] for o in contours}, key=lambda t: (t != ct, t)):
        ordered += _nearest_order([o for o in contours if o["tool"] == tid])
    has_changer = bool(profile["machine"].get("changeur_outils"))
    files = []
    for op in ordered:
        if files and (has_changer or files[-1]["tools"][-1] == op["tool"]):
            files[-1]["ops"].append(op)
            if op["tool"] != files[-1]["tools"][-1]:
                files[-1]["tools"].append(op["tool"])
        else:
            files.append({"ops": [op], "tools": [op["tool"]]})
    for i, f in enumerate(files, 1):
        f["index"] = i
        f["name"] = f"P{sheet['index']:02d}_{i:02d}_{'-'.join(f['tools'])}"
    return {"sheet": sheet["index"], "material_id": group["material_id"], "material_name": group["material_name"],
            "thickness": group["thickness"], "panel": group["panel"], "files": files, "errors": errors,
            "z_top": cam.top, "z_safe": cam.z_safe, "z_clear": cam.z_clear, "z_through": cam.z_through}


def build_programs(design: dict, profile: dict, settings: dict) -> list[dict]:
    parts_by_ref = {p["ref"]: p for p in design["parts"]}
    progs = []
    for g in design["nesting"]["groups"]:
        for sh in g["sheets"]:
            pr = sheet_program(g, sh, parts_by_ref, profile, settings)
            pr["group_key"] = g["material_id"]
            progs.append(pr)
    return progs


def pilot_program(profile: dict, settings: dict, thickness: float = 18.0) -> dict:
    """Programme pilote de qualification : petite pièce d'essai à usiner dans une chute.

    Rectangle 120×80 avec un perçage, une poche et une ouverture, sur une
    chute de 250×180 mm.
    """
    part = {"ref": "PILOTE", "name": "Pièce d'essai", "qty": 1, "length": {"value": 120.0},
            "width": {"value": 80.0}, "corner_r": 0.0, "rotation_allowed": False, "grain_x": False,
            "features": [
                {"kind": PERCAGE, "label": "Perçage d'essai", "x": {"value": 25.0}, "y": {"value": 40.0},
                 "diameter": {"value": 10.0}, "depth": {"value": 5.0}, "through": False},
                {"kind": POCHE, "label": "Poche d'essai", "x": {"value": 50.0}, "y": {"value": 20.0},
                 "w": {"value": 40.0}, "h": {"value": 20.0}, "depth": {"value": 3.0}, "through": False},
                {"kind": OUVERTURE, "label": "Ouverture d'essai", "x": {"value": 55.0}, "y": {"value": 50.0},
                 "w": {"value": 30.0}, "h": {"value": 18.0}, "through": True, "corner_r": 4.0}]}
    group = {"material_id": "chute", "material_name": "Chute d'essai", "thickness": thickness,
             "panel": {"length": 250.0, "width": 180.0, "margin": 10.0, "zones": [], "grain": False}}
    sheet = {"index": 1, "placements": [{"ref": "PILOTE", "instance": 1, "x": 65.0, "y": 50.0, "w": 120.0,
                                         "h": 80.0, "rotated": False}], "utilization": 0}
    pr = sheet_program(group, sheet, {"PILOTE": part}, profile, settings)
    pr["pilot_part"] = part
    pr["pilot_sheet"] = sheet
    return pr
