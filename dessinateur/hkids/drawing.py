"""Dessins SVG : pièce cotée, aperçu de calepinage par panneau, vue d'ensemble.

Les dessins sont générés à partir des primitives de ``geometry`` : ce sont
exactement les mêmes données que celles écrites dans les DXF.
Couleurs de provenance : noir = fournie, bleu = calculée, orange = à confirmer.
"""
from __future__ import annotations

import math

from html import escape

from . import shapes as S
from .geometry import part_primitives, placed_primitives
from .model import FEATURE_LABELS, OUVERTURE, PERCAGE, POCHE, RAINURE
from .provenance import A_CONFIRMER, CALCULE, FOURNI, LABELS, fmt

SRC_COLOR = {FOURNI: "#111827", CALCULE: "#1d4ed8", A_CONFIRMER: "#c2410c"}
KIND_STYLE = {
    RAINURE: ("#bfdbfe", "#1d4ed8"),
    POCHE: ("#bbf7d0", "#15803d"),
    PERCAGE: ("#ede9fe", "#6d28d9"),
    OUVERTURE: ("#ffffff", "#dc2626"),
    "contour": ("#fdf6e3", "#111827"),
}
FONT = "font-family=\"Segoe UI, Roboto, Helvetica, Arial, sans-serif\""


def _worst(*srcs):
    if A_CONFIRMER in srcs:
        return A_CONFIRMER
    if CALCULE in srcs:
        return CALCULE
    return FOURNI


class Svg:
    def __init__(self):
        self.items: list[str] = []

    def add(self, s: str):
        self.items.append(s)

    def text(self, x, y, s, size=12, color="#111827", anchor="start", weight="normal", rotate=None, title=None):
        tr = f' transform="rotate({rotate} {x:.1f} {y:.1f})"' if rotate else ""
        t = f"<title>{escape(title)}</title>" if title else ""
        self.add(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{color}" text-anchor="{anchor}" '
                 f'font-weight="{weight}"{tr}>{t}{escape(str(s))}</text>')

    def line(self, x1, y1, x2, y2, color="#111827", width=1, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{color}" '
                 f'stroke-width="{width}"{d}/>')

    def render(self, w, h, title="") -> str:
        defs = ('<defs>'
                '<marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" '
                'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>'
                '<pattern id="hatchR" width="6" height="6" patternUnits="userSpaceOnUse" '
                'patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#dc2626" '
                'stroke-width="1.5"/></pattern>'
                '<pattern id="hatchG" width="6" height="6" patternUnits="userSpaceOnUse" '
                'patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#9ca3af" '
                'stroke-width="1"/></pattern></defs>')
        t = f"<title>{escape(title)}</title>" if title else ""
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" width="{w:.0f}" '
                f'height="{h:.0f}" {FONT}>{t}{defs}<rect width="100%" height="100%" fill="#ffffff"/>'
                + "".join(self.items) + "</svg>")


def _dim_h(svg: Svg, x1, x2, y, value, src, formule="", above=False):
    c = SRC_COLOR[src]
    svg.add(f'<line x1="{x1:.1f}" y1="{y:.1f}" x2="{x2:.1f}" y2="{y:.1f}" stroke="{c}" stroke-width="1" '
            f'marker-start="url(#arr)" marker-end="url(#arr)"/>')
    label = fmt(value) + (" ?" if src == A_CONFIRMER else "")
    svg.text((x1 + x2) / 2, y + (-5 if above else 15), label, 13, c, "middle", "bold",
             title=f"{LABELS[src]}{' — ' + formule if formule else ''}")


def _dim_v(svg: Svg, x, y1, y2, value, src, formule=""):
    c = SRC_COLOR[src]
    svg.add(f'<line x1="{x:.1f}" y1="{y1:.1f}" x2="{x:.1f}" y2="{y2:.1f}" stroke="{c}" stroke-width="1" '
            f'marker-start="url(#arr)" marker-end="url(#arr)"/>')
    label = fmt(value) + (" ?" if src == A_CONFIRMER else "")
    svg.text(x - 6, (y1 + y2) / 2, label, 13, c, "middle", "bold", rotate=-90,
             title=f"{LABELS[src]}{' — ' + formule if formule else ''}")


def svg_path_d(points, X, Y, k) -> str:
    """Chemin SVG exact (arcs « A ») d'un contour [[x, y, bulge], ...]. Le dessin est affiché Y vers le haut :
    un arc trigonométrique (bulge > 0) reste anti-horaire à l'œil, soit sweep-flag = 0 en SVG."""
    d = [f"M{X(points[0][0]):.2f},{Y(points[0][1]):.2f}"]
    n = len(points)
    for i in range(n):
        p0, p1 = points[i], points[(i + 1) % n]
        if abs(p0[2]) < 1e-12:
            d.append(f"L{X(p1[0]):.2f},{Y(p1[1]):.2f}")
        else:
            _, _, r, _, th = S.arc_params(p0, p1, p0[2])
            large = 1 if abs(th) > math.pi + 1e-9 else 0
            sweep = 0 if th > 0 else 1
            d.append(f"A{r * k:.2f},{r * k:.2f} 0 {large} {sweep} {X(p1[0]):.2f},{Y(p1[1]):.2f}")
    return " ".join(d) + " Z"


def _shape(svg: Svg, prim: dict, X, Y, k, fill=None, stroke=None, width=1.2, extra=""):
    """Dessine une primitive (coordonnées mm) via les fonctions d'échelle X(x), Y(y)."""
    f, s = KIND_STYLE.get(prim["kind"], ("none", "#111"))
    f = fill or f
    s = stroke or s
    if prim["type"] == "path":
        dash = ' stroke-dasharray="6 3"' if prim["kind"] == OUVERTURE else ""
        svg.add(f'<path d="{svg_path_d(prim["points"], X, Y, k)}" fill="{f}" stroke="{s}" stroke-width="{width}"'
                f'{dash}{extra}/>')
        return
    if prim["type"] == "circle":
        cx, cy, r = X(prim["cx"]), Y(prim["cy"]), max(prim["r"] * k, 1.5)
        svg.add(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" fill="{s if prim["through"] else f}" '
                f'stroke="{s}" stroke-width="{width}"{extra}/>')
        cr = r + 3
        svg.line(cx - cr, cy, cx + cr, cy, s, 0.6)
        svg.line(cx, cy - cr, cx, cy + cr, s, 0.6)
    else:
        x, y = X(prim["x"]), Y(prim["y"] + prim["h"])
        w, h = prim["w"] * k, prim["h"] * k
        rr = prim.get("r", 0) * k
        dash = ' stroke-dasharray="6 3"' if prim["kind"] == OUVERTURE else ""
        svg.add(f'<rect x="{x:.2f}" y="{y:.2f}" width="{max(w, 0.5):.2f}" height="{max(h, 0.5):.2f}" '
                f'rx="{rr:.2f}" fill="{f}" stroke="{s}" stroke-width="{width}"{dash}{extra}/>')


def _size(f: dict) -> str:
    if f.get("shape") and f["shape"] not in ("rectangle",):
        return f"{S.SHAPES.get(f['shape'], f['shape']).split(' (')[0]} {fmt(f['w']['value'])} × {fmt(f['h']['value'])}"
    if "diameter" in f:
        return f"Ø {fmt(f['diameter']['value'])}"
    out = f"{fmt(f['w']['value'])} × {fmt(f['h']['value'])}"
    if f.get("corner_r"):
        out += f"  R{fmt(f['corner_r'])}"
    return out


# ---------------------------------------------------------------------------
# Dessin de pièce
# ---------------------------------------------------------------------------

def part_svg(part: dict, project_name: str = "", version: int | None = None) -> str:
    L, W = part["length"]["value"], part["width"]["value"]
    CW = 1180
    k = min(860 / L, 400 / W)
    vw, vh = L * k, W * k
    ox = 110 + (860 - vw) / 2
    oy = 236
    X = lambda x: ox + x * k  # noqa: E731
    Y = lambda y: oy + (W - y) * k  # noqa: E731
    svg = Svg()

    # Cartouche
    svg.add('<rect x="10" y="10" width="1160" height="96" fill="#f8fafc" stroke="#cbd5e1"/>')
    svg.text(24, 42, f"{part['ref']} — {part['name']}", 24, "#111827", weight="bold")
    svg.text(24, 68, f"Quantité : {part['qty']}   ·   {part['material_name']}   ·   Épaisseur "
             f"{fmt(part['thickness']['value'])} mm" + (" (à confirmer)" if part["thickness"]["source"] ==
                                                       A_CONFIRMER else ""), 15, "#334155")
    svg.text(24, 92, f"Débit : {fmt(L)} × {fmt(W)} mm   ·   Échelle adaptée — cotes en mm   ·   "
             f"DXF à l'échelle 1:1", 13, "#64748b")
    right = []
    if project_name:
        right.append(project_name)
    if version is not None:
        right.append(f"Version {version}")
    svg.text(1156, 42, " · ".join(right), 13, "#334155", "end")
    st = part["source"]
    svg.text(1156, 68, "STATUT DES COTES : " + LABELS[st].upper(), 13, SRC_COLOR[st], "end", "bold")
    if part.get("mirror_of"):
        svg.text(1156, 92, f"Symétrique de {part['mirror_of']}", 13, "#7c3aed", "end", "bold")

    # Vue
    prims = part_primitives(part)
    _shape(svg, prims[0], X, Y, k, width=2)
    for i, p in enumerate(prims[1:], 1):
        _shape(svg, p, X, Y, k)
    # Numéros d'usinage
    for i, p in enumerate(prims[1:], 1):
        if p["type"] == "circle":
            cx, cy = X(p["cx"]) + p["r"] * k + 7, Y(p["cy"]) - p["r"] * k - 4
        elif p["type"] == "path":
            bx0, by0, bx1, by1 = S.bbox(p["points"])
            cx, cy = X((bx0 + bx1) / 2), Y((by0 + by1) / 2)
        else:
            cx, cy = X(p["x"] + p["w"] / 2), Y(p["y"] + p["h"] / 2)
        svg.add(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="8" fill="#ffffff" stroke="#334155" stroke-width="0.8"/>')
        svg.text(cx, cy + 4, i, 10, "#334155", "middle", "bold")

    # Origine pièce et sens du fil
    svg.add(f'<circle cx="{X(0):.1f}" cy="{Y(0):.1f}" r="4" fill="#dc2626"/>')
    svg.text(X(0) + 6, Y(0) + 16, "Origine pièce (0,0)", 11, "#dc2626")
    svg.add(f'<line x1="{X(0):.1f}" y1="{Y(0):.1f}" x2="{X(0) + 40:.1f}" y2="{Y(0):.1f}" stroke="#dc2626" '
            f'stroke-width="2" marker-end="url(#arr)"/>')
    svg.add(f'<line x1="{X(0):.1f}" y1="{Y(0):.1f}" x2="{X(0):.1f}" y2="{Y(0) - 40:.1f}" stroke="#16a34a" '
            f'stroke-width="2" marker-end="url(#arr)"/>')
    svg.text(X(0) + 44, Y(0) + 4, "X", 11, "#dc2626", weight="bold")
    svg.text(X(0) - 4, Y(0) - 44, "Y", 11, "#16a34a", weight="bold")
    if part.get("grain_y"):
        gx = X(L) + 150
        svg.add(f'<line x1="{gx:.1f}" y1="{Y(W * 0.3):.1f}" x2="{gx:.1f}" y2="{Y(W * 0.7):.1f}" '
                f'stroke="#92400e" stroke-width="1.5" marker-start="url(#arr)" marker-end="url(#arr)"/>')
        svg.text(gx + 6, Y(W / 2), "FIL", 11, "#92400e", "start", "bold")
    if part["grain_x"]:
        gy = Y(0) + 62
        svg.add(f'<line x1="{X(L * 0.35):.1f}" y1="{gy:.1f}" x2="{X(L * 0.65):.1f}" y2="{gy:.1f}" '
                f'stroke="#92400e" stroke-width="1.5" marker-start="url(#arr)" marker-end="url(#arr)"/>')
        svg.text(X(L * 0.65) + 8, gy + 4, "SENS DU FIL — rotation interdite", 11, "#92400e", "start", "bold")

    # Cotes d'encombrement
    _dim_h(svg, X(0), X(L), Y(0) + 34, L, part["length"]["source"], part["length"].get("formule", ""))
    _dim_v(svg, X(0) - 34, Y(0), Y(W), W, part["width"]["source"], part["width"].get("formule", ""))
    svg.line(X(0), Y(0) + 4, X(0), Y(0) + 40, "#94a3b8", 0.6)
    svg.line(X(L), Y(0) + 4, X(L), Y(0) + 40, "#94a3b8", 0.6)
    svg.line(X(0) - 4, Y(0), X(0) - 40, Y(0), "#94a3b8", 0.6)
    svg.line(X(0) - 4, Y(W), X(0) - 40, Y(W), "#94a3b8", 0.6)

    # Cotation en coordonnées (ordonnées) des usinages
    xs, ys = {}, {}

    def put(dct, v, src):
        key = round(v, 1)
        dct[key] = _worst(dct.get(key, FOURNI), src)

    for f in part["features"]:
        if "diameter" in f:
            put(xs, f["x"]["value"], f["x"]["source"])
            put(ys, f["y"]["value"], f["y"]["source"])
        else:
            x0, y0 = f["x"]["value"], f["y"]["value"]
            put(xs, x0, f["x"]["source"])
            put(xs, x0 + f["w"]["value"], _worst(f["x"]["source"], f["w"]["source"]))
            put(ys, y0, f["y"]["source"])
            put(ys, y0 + f["h"]["value"], _worst(f["y"]["source"], f["h"]["source"]))
    if part.get("contour") and part["contour"].get("path"):
        csrc = part["contour"].get("source", part["source"])
        for px, py in S.extremes(part["contour"]["path"]):
            put(xs, px, csrc)
            put(ys, py, csrc)
    xs = {v: s for v, s in xs.items() if 0.05 < v < L - 0.05}
    ys = {v: s for v, s in ys.items() if 0.05 < v < W - 0.05}
    top = Y(W)
    last = -1e9
    lvl = 0
    for v in sorted(xs):
        sx = X(v)
        lvl = (lvl + 1) % 2 if sx - last < 13 else 0
        last = sx
        base = top - 22 - lvl * 40
        svg.line(sx, top, sx, base, SRC_COLOR[xs[v]], 0.6, "2 2")
        svg.text(sx + 4, base - 3, fmt(v) + (" ?" if xs[v] == A_CONFIRMER else ""), 11, SRC_COLOR[xs[v]],
                 rotate=-90)
    rx = X(L)
    last = -1e9
    lvl = 0
    for v in sorted(ys):
        sy = Y(v)
        lvl = (lvl + 1) % 2 if abs(sy - last) < 13 else 0
        last = sy
        end = rx + 18 + lvl * 46
        svg.line(rx, sy, end, sy, SRC_COLOR[ys[v]], 0.6, "2 2")
        svg.text(end + 3, sy + 4, fmt(v) + (" ?" if ys[v] == A_CONFIRMER else ""), 11, SRC_COLOR[ys[v]])
    if xs or ys:
        svg.text(ox + vw, top - 112 if xs else top - 10, "Cotes des usinages depuis l'origine pièce", 11,
                 "#64748b", "end")

    # Tableau des usinages
    y = oy + vh + 96
    cols = [(20, "N°"), (60, "Usinage"), (330, "X"), (420, "Y"), (510, "Dimensions"), (700, "Profondeur"),
            (840, "Provenance")]
    if part["features"]:
        svg.add(f'<rect x="10" y="{y - 18:.1f}" width="1160" height="24" fill="#e2e8f0"/>')
        for cx, t in cols:
            svg.text(cx, y, t, 12, "#0f172a", weight="bold")
        # Usinages identiques (même type, libellé, taille, profondeur) regroupés en une ligne à partir de 4
        groups: list[list[tuple[int, dict]]] = []
        for i, f in enumerate(part["features"], 1):
            key = (f["kind"], f["label"], _size(f), f["through"], None if f["through"] else f["depth"]["value"])
            if groups and groups[-1][0] == key:
                groups[-1][1].append((i, f))
            else:
                groups.append([key, [(i, f)]])
        rows = []
        for key, items in groups:
            if len(items) >= 4:
                rows.append(items)
            else:
                rows.extend([[it] for it in items])
        for row_i, items in enumerate(rows, 1):
            y += 22
            f = items[0][1]
            srcs = [g[k]["source"] for _, g in items for k in ("x", "y", "w", "h", "diameter", "depth") if k in g]
            ws = _worst(*srcs)
            dims = _size(f)
            depth = "Traversant" if f["through"] else fmt(f["depth"]["value"])
            if len(items) == 1:
                num, label = str(items[0][0]), f"{FEATURE_LABELS[f['kind']]} — {f['label']}"
                xs_, ys_ = fmt(f["x"]["value"]), fmt(f["y"]["value"])
            else:
                num = f"{items[0][0]}–{items[-1][0]}"
                label = f"{len(items)} × {FEATURE_LABELS[f['kind']].lower()} — {f['label']}"
                xv = sorted({g["x"]["value"] for _, g in items})
                yv = sorted({g["y"]["value"] for _, g in items})
                xs_ = fmt(xv[0]) if len(xv) == 1 else f"{fmt(xv[0])} → {fmt(xv[-1])}"
                ys_ = " / ".join(fmt(v) for v in yv) if len(yv) <= 3 else f"{fmt(yv[0])} → {fmt(yv[-1])}"
            vals = [num, label, xs_, ys_, dims, depth, LABELS[ws]]
            if row_i % 2 == 0:
                svg.add(f'<rect x="10" y="{y - 15:.1f}" width="1160" height="22" fill="#f8fafc"/>')
            for (cx, _), v in zip(cols, vals):
                svg.text(cx, y, v[:44], 12, SRC_COLOR[ws] if cx in (330, 420, 510, 700, 840) else "#111827")
        y += 14
    # Notes
    notes = [f"Face usinée : {part['face']}"]
    if part.get("contour"):
        notes.append(f"Contour : {part['contour'].get('label') or S.SHAPES.get(part['contour'].get('shape'), '')}")
        if S.has_concave_corner(part["contour"]["path"]):
            notes.append("Angles rentrants du contour arrondis au rayon de la fraise à l'usinage")
    if part["orientation"]:
        notes.append(f"Orientation : {part['orientation']}")
    if part["assembly"]:
        notes.append(f"Assemblage : {part['assembly']}")
    notes += part["edges"] + part["notes"]
    for f in part["features"]:
        if f.get("note"):
            notes.append(f"{f['label']} : {f['note']}")
    y += 16
    for n in dict.fromkeys(notes):
        y += 19
        svg.text(20, y, "• " + n, 12, "#334155")
    # Légende
    y += 34
    lx = 20
    for src in (FOURNI, CALCULE, A_CONFIRMER):
        svg.add(f'<rect x="{lx}" y="{y - 10}" width="12" height="12" fill="{SRC_COLOR[src]}"/>')
        svg.text(lx + 18, y, LABELS[src], 12, SRC_COLOR[src])
        lx += 190
    for kind in (RAINURE, POCHE, PERCAGE, OUVERTURE):
        f, s = KIND_STYLE[kind]
        svg.add(f'<rect x="{lx}" y="{y - 10}" width="14" height="12" fill="{f}" stroke="{s}"/>')
        svg.text(lx + 19, y, FEATURE_LABELS[kind], 12, s)
        lx += 120
    svg.text(20, y + 22, "Perçage plein = traversant · Perçage clair = borgne · Ouverture pointillée = découpe "
             "traversante · Survoler une cote pour voir sa règle de calcul.", 11, "#64748b")
    return svg.render(CW, y + 40, f"{part['ref']} {part['name']}")


# ---------------------------------------------------------------------------
# Calepinage
# ---------------------------------------------------------------------------

def sheet_svg(group: dict, sheet: dict, parts_by_ref: dict, total: int, origin: str = "avant_gauche",
              spacing: float = 0.0) -> str:
    ps = group["panel"]
    PL, PW, m = ps["length"], ps["width"], ps["margin"]
    k = 1080 / PL
    ox, oy = 70, 120
    X = lambda x: ox + x * k  # noqa: E731
    Y = lambda y: oy + (PW - y) * k  # noqa: E731
    svg = Svg()
    svg.text(20, 30, f"Panneau {sheet['index']} / {len(group['sheets'])} — {group['material_name']}", 20,
             weight="bold")
    svg.text(20, 54, f"Panneau {fmt(PL)} × {fmt(PW)} mm · épaisseur {fmt(group['thickness'])} mm · marge "
             f"{fmt(m)} mm · espacement mini entre pièces {fmt(spacing)} mm · {len(sheet['placements'])} pièce(s) "
             f"· utilisation {sheet['utilization']} %", 13, "#334155")
    svg.text(20, 74, f"Total projet : {total} panneau(x) toutes matières", 12, "#64748b")
    # Panneau, marges
    svg.add(f'<rect x="{X(0):.1f}" y="{Y(PW):.1f}" width="{PL * k:.1f}" height="{PW * k:.1f}" fill="#f3e2c0" '
            f'stroke="#78350f" stroke-width="1.5"/>')
    for rx, ry, rw, rh in [(0, 0, PL, m), (0, PW - m, PL, m), (0, 0, m, PW), (PL - m, 0, m, PW)]:
        svg.add(f'<rect x="{X(rx):.1f}" y="{Y(ry + rh):.1f}" width="{rw * k:.1f}" height="{rh * k:.1f}" '
                f'fill="url(#hatchG)" stroke="none"/>')
    for z in ps["zones"]:
        svg.add(f'<rect x="{X(z["x"]):.1f}" y="{Y(z["y"] + z["h"]):.1f}" width="{z["w"] * k:.1f}" '
                f'height="{z["h"] * k:.1f}" fill="url(#hatchR)" stroke="#dc2626"/>')
        svg.text(X(z["x"] + z["w"] / 2), Y(z["y"] + z["h"] / 2) + 4, z.get("label", "Fixation — ne pas usiner"),
                 10, "#b91c1c", "middle", "bold")
    if ps["grain"]:
        svg.add(f'<line x1="{X(PL * 0.42):.1f}" y1="{Y(PW) - 14:.1f}" x2="{X(PL * 0.58):.1f}" '
                f'y2="{Y(PW) - 14:.1f}" stroke="#92400e" stroke-width="1.5" marker-start="url(#arr)" '
                f'marker-end="url(#arr)"/>')
        svg.text(X(PL / 2), Y(PW) - 20, "Sens du fil du panneau", 11, "#92400e", "middle")
    # Pièces
    for pl in sheet["placements"]:
        part = parts_by_ref[pl["ref"]]
        prims = placed_primitives(part, pl)
        _shape(svg, prims[0], X, Y, k, fill="#fffaf0", stroke="#111827", width=1.4)
        for p in prims[1:]:
            _shape(svg, p, X, Y, k, width=0.8)
        cx, cy = X(pl["x"] + pl["w"] / 2), Y(pl["y"] + pl["h"] / 2)
        fs = max(9, min(18, pl["h"] * k / 3, pl["w"] * k / 4))
        svg.add(f'<rect x="{cx - fs * 1.6:.1f}" y="{cy - fs * 0.95:.1f}" width="{fs * 3.2:.1f}" '
                f'height="{fs * 1.3:.1f}" rx="3" fill="#111827" opacity="0.85"/>')
        svg.text(cx, cy + fs * 0.1, pl["ref"], fs, "#ffffff", "middle", "bold",
                 title=f"{pl['ref']} {part['name']} n°{pl['instance']} — {fmt(part['length']['value'])}×"
                       f"{fmt(part['width']['value'])}" + (" — tournée 90°" if pl["rotated"] else ""))
        small = max(8, fs * 0.6)
        if part.get("grain_y"):
            rot = "fil vertical : tournée obligatoirement"
        elif part["grain_x"]:
            rot = "fil : rotation interdite"
        else:
            rot = "rotation libre"
        tag = ("↻ 90° · " if pl["rotated"] else "") + rot
        svg.text(cx, cy + fs * 0.1 + small + 3, f"{part['name']} {pl['instance']}/{part['qty']}"[:28], small,
                 "#1f2937", "middle")
        if tag:
            svg.text(cx, cy + fs * 0.1 + 2 * small + 5, tag.strip(" ·"), small, "#7c3aed", "middle")
    # Cotes du panneau
    _dim_h(svg, X(0), X(PL), Y(PW) - 34, PL, FOURNI, above=True)
    _dim_v(svg, X(0) - 26, Y(0), Y(PW), PW, FOURNI)
    # Origine XY
    oxy = (0, 0) if origin == "avant_gauche" else (0, PW)
    sx, sy = X(oxy[0]), Y(oxy[1])
    ydir = -1 if origin == "avant_gauche" else 1
    svg.add(f'<circle cx="{sx:.1f}" cy="{sy:.1f}" r="6" fill="#dc2626" stroke="#fff" stroke-width="2"/>')
    svg.add(f'<line x1="{sx:.1f}" y1="{sy:.1f}" x2="{sx + 70:.1f}" y2="{sy:.1f}" stroke="#dc2626" '
            f'stroke-width="2.5" marker-end="url(#arr)"/>')
    svg.add(f'<line x1="{sx:.1f}" y1="{sy:.1f}" x2="{sx:.1f}" y2="{sy + ydir * 70:.1f}" stroke="#16a34a" '
            f'stroke-width="2.5" marker-end="url(#arr)"/>')
    svg.text(sx + 74, sy + 4, "X+", 12, "#dc2626", weight="bold")
    svg.text(sx + 6, sy + ydir * 74 + (0 if ydir < 0 else 10), "Y+" if ydir < 0 else "Y−", 12, "#16a34a",
             weight="bold")
    svg.text(sx + 10, sy + (18 if ydir < 0 else -10), "Origine X0 Y0", 12, "#dc2626", weight="bold")
    # Légende
    y = Y(0) + 54
    lx = 20
    items = [("#fffaf0", "#111827", "Pièce (contour extérieur)")] + [
        (KIND_STYLE[kd][0], KIND_STYLE[kd][1], FEATURE_LABELS[kd]) for kd in (RAINURE, POCHE, PERCAGE, OUVERTURE)]
    for f, s, t in items:
        svg.add(f'<rect x="{lx}" y="{y - 10}" width="14" height="12" fill="{f}" stroke="{s}"/>')
        svg.text(lx + 19, y, t, 12, s)
        lx += 190
    y += 22
    svg.add(f'<rect x="20" y="{y - 10}" width="14" height="12" fill="url(#hatchG)" stroke="#9ca3af"/>')
    svg.text(39, y, "Marge inutilisable", 12, "#4b5563")
    svg.add(f'<rect x="210" y="{y - 10}" width="14" height="12" fill="url(#hatchR)" stroke="#dc2626"/>')
    svg.text(229, y, "Zone de fixation à éviter", 12, "#b91c1c")
    svg.text(420, y, "↻ 90° = pièce tournée · rotation libre / interdite (sens du fil) indiquée sur chaque pièce",
             12, "#7c3aed")
    return svg.render(1220, y + 24, f"Panneau {sheet['index']} {group['material_name']}")


# ---------------------------------------------------------------------------
# Vue d'ensemble
# ---------------------------------------------------------------------------

def elevation_svg(elev: dict, parts: list[dict]) -> str:
    if not elev or not elev.get("rects"):
        return Svg().render(400, 60)
    Wm, Hm = elev["width"], elev["height"]
    k = min(700 / Wm, 520 / Hm)
    ox, oy = 90, 70
    X = lambda x: ox + x * k  # noqa: E731
    Y = lambda y: oy + (Hm - y) * k  # noqa: E731
    refs = {}
    for p in parts:
        refs.setdefault(p["name"], p["ref"])
    svg = Svg()
    svg.text(20, 32, elev.get("title", "Vue d'ensemble"), 18, weight="bold")
    for r in elev["rects"]:
        dash = ' stroke-dasharray="6 4"' if r.get("dashed") else ""
        if r.get("path"):
            pts = S.translate(r["path"], r.get("x", 0), r.get("y", 0))
            fill = "#ffffff" if r.get("hole") else "#fdf6e3"
            svg.add(f'<path d="{svg_path_d(pts, X, Y, k)}" fill="{fill}" stroke="#111827" stroke-width="1.2"{dash}/>')
            if r.get("hole"):
                continue
            x0, y0, x1, y1 = S.bbox(pts)
            ref = refs.get(r["name"], "")
            svg.text(X((x0 + x1) / 2), Y(y0 + (y1 - y0) * 0.8), f"{ref} {r.get('label', r['name'])}".strip(), 11,
                     "#1e3a8a", "middle")
            continue
        svg.add(f'<rect x="{X(r["x"]):.1f}" y="{Y(r["y"] + r["h"]):.1f}" width="{r["w"] * k:.1f}" '
                f'height="{r["h"] * k:.1f}" fill="#fdf6e3" stroke="#111827" stroke-width="1.2"{dash}/>')
        ref = refs.get(r["name"], "")
        label = f"{ref} {r.get('label', r['name'])}".strip()
        cx, cy = X(r["x"] + r["w"] / 2), Y(r["y"] + r["h"] / 2)
        vertical = r["h"] * k > r["w"] * k * 2
        svg.text(cx + (4 if vertical else 0), cy + 4, label, 11, "#1e3a8a", "middle", rotate=-90 if vertical else None)
    if not elev.get("flat"):
        _dim_h(svg, X(0), X(Wm), Y(0) + 30, Wm, FOURNI)
        _dim_v(svg, X(0) - 30, Y(0), Y(Hm), Hm, FOURNI)
        if elev.get("depth"):
            svg.text(X(Wm), Y(0) + 60, f"Profondeur {fmt(elev['depth'])} mm", 12, "#334155", "end")
    return svg.render(ox + Wm * k + 60, oy + Hm * k + 80, elev.get("title", ""))
