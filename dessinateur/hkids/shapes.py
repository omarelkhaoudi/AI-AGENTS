"""Formes H-KIDS : contours fermés exacts (segments droits et arcs de cercle).

Un contour (« path ») est une liste de sommets ``[x, y, bulge]`` parcourue dans
le sens trigonométrique. ``bulge`` décrit l'arc qui part du sommet vers le
suivant : 0 = segment droit, tan(angle/4) sinon (1 = demi-cercle, positif =
sens trigo). C'est le format des LWPOLYLINE DXF : dessins, DXF, Rhino et
parcours d'usinage utilisent exactement la même géométrie.

Formes disponibles (cotes en mm, repère : coin inférieur gauche de l'encombrement) :
- ``rectangle``      largeur × hauteur
- ``arrondi``        rectangle à angles arrondis (rayon)
- ``arc``            porte / fenêtre en plein cintre : largeur × hauteur totale (sommet de l'arc)
- ``pignon``         façade de maison : largeur, hauteur sous égout, hauteur au faîtage
- ``pignon_porte``   pignon avec porte en plein cintre découpée depuis le bas
- ``feston``         bandeau de lambrequin : largeur, hauteur totale, nombre de festons
- ``disque``         diamètre
"""
from __future__ import annotations

import math

Path = list  # [[x, y, bulge], ...]


class ShapeError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Géométrie des arcs
# ---------------------------------------------------------------------------

def arc_params(p0, p1, b):
    """Centre, rayon, angle de départ et balayage (signé) de l'arc p0→p1 de bulge b."""
    (x0, y0), (x1, y1) = p0[:2], p1[:2]
    c = math.hypot(x1 - x0, y1 - y0)
    theta = 4 * math.atan(b)
    r = c * (1 + b * b) / (4 * abs(b))
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    ux, uy = (x1 - x0) / c, (y1 - y0) / c
    d = c * (1 - b * b) / (4 * b)          # distance signée milieu → centre sur la normale gauche
    cx, cy = mx - uy * d, my + ux * d
    a0 = math.atan2(y0 - cy, x0 - cx)
    return cx, cy, r, a0, theta


def segments(path: Path):
    n = len(path)
    for i in range(n):
        yield path[i], path[(i + 1) % n]


def discretize(path: Path, tol: float = 0.05) -> list[tuple[float, float]]:
    """Polygone approché (écart de corde ≤ tol mm), sans répéter le premier point."""
    pts = []
    for p0, p1 in segments(path):
        pts.append((p0[0], p0[1]))
        b = p0[2]
        if abs(b) < 1e-12:
            continue
        cx, cy, r, a0, th = arc_params(p0, p1, b)
        step = 2 * math.acos(max(-1.0, 1 - tol / r)) if r > tol else abs(th)
        n = max(2, math.ceil(abs(th) / max(step, 1e-6)))
        for k in range(1, n):
            a = a0 + th * k / n
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def bbox(path: Path) -> tuple[float, float, float, float]:
    """Encombrement exact (extrêmes des arcs compris)."""
    xs, ys = [p[0] for p in path], [p[1] for p in path]
    for p0, p1 in segments(path):
        b = p0[2]
        if abs(b) < 1e-12:
            continue
        cx, cy, r, a0, th = arc_params(p0, p1, b)
        for k in range(-8, 9):
            a = k * math.pi / 2
            rel = (a - a0) / th if th else -1
            if 0 < rel < 1:
                xs.append(cx + r * math.cos(a))
                ys.append(cy + r * math.sin(a))
    return min(xs), min(ys), max(xs), max(ys)


def extremes(path: Path) -> list[tuple[float, float]]:
    """Sommets + points extrêmes des arcs (servent à la cotation)."""
    out = [(p[0], p[1]) for p in path]
    for p0, p1 in segments(path):
        if abs(p0[2]) < 1e-12:
            continue
        cx, cy, r, a0, th = arc_params(p0, p1, p0[2])
        for k in range(-8, 9):
            a = k * math.pi / 2
            rel = (a - a0) / th
            if 0 < rel < 1:
                out.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return out


def area(path: Path) -> float:
    pts = discretize(path, 0.01)
    return 0.5 * sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))


def perimeter(path: Path) -> float:
    total = 0.0
    for p0, p1 in segments(path):
        if abs(p0[2]) < 1e-12:
            total += math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        else:
            _, _, r, _, th = arc_params(p0, p1, p0[2])
            total += r * abs(th)
    return total


def translate(path: Path, dx: float, dy: float) -> Path:
    return [[x + dx, y + dy, b] for x, y, b in path]


def rotate90(path: Path, part_width: float) -> Path:
    """Même rotation que les pièces sur le panneau : (x, y) → (largeur − y, x). Le sens est conservé."""
    return [[part_width - y, x, b] for x, y, b in path]


def normalize(path: Path) -> Path:
    """Ramène l'encombrement à l'origine et force le sens trigonométrique."""
    x0, y0, _, _ = bbox(path)
    p = translate(path, -x0, -y0)
    if area(p) < 0:
        p = reverse(p)
    return [[round(x, 6), round(y, 6), round(b, 9)] for x, y, b in p]


def reverse(path: Path) -> Path:
    n = len(path)
    out = []
    for i in range(n - 1, -1, -1):
        prev_b = path[i - 1][2]  # l'arc qui arrivait au sommet i part maintenant de i, en sens inverse
        out.append([path[i][0], path[i][1], -prev_b])
    return out


def is_simple_rect(path: Path) -> bool:
    return len(path) == 4 and all(abs(p[2]) < 1e-12 for p in path)


# ---------------------------------------------------------------------------
# Formes
# ---------------------------------------------------------------------------

def rectangle(w: float, h: float) -> Path:
    _pos(w=w, h=h)
    return [[0, 0, 0], [w, 0, 0], [w, h, 0], [0, h, 0]]


def arrondi(w: float, h: float, r: float) -> Path:
    _pos(w=w, h=h)
    r = max(0.0, min(r, w / 2, h / 2))
    if r <= 1e-9:
        return rectangle(w, h)
    b = math.tan(math.pi / 8)
    return [[r, 0, 0], [w - r, 0, b], [w, r, 0], [w, h - r, b], [w - r, h, 0], [r, h, b], [0, h - r, 0], [0, r, b]]


def arc(w: float, h: float) -> Path:
    """Plein cintre : rectangle surmonté d'un demi-cercle de diamètre w ; h = hauteur au sommet."""
    _pos(w=w, h=h)
    r = w / 2
    if h < r - 1e-9:
        raise ShapeError(f"Arc plein cintre : la hauteur ({h:g}) doit être au moins la moitié de la largeur ({r:g}).")
    if abs(h - r) < 1e-9:
        return [[0, 0, 0], [w, 0, 1.0]]
    return [[0, 0, 0], [w, 0, 0], [w, h - r, 1.0], [0, h - r, 0]]


def pignon(w: float, h_egout: float, h_faitage: float) -> Path:
    _pos(w=w, h_egout=h_egout, h_faitage=h_faitage)
    if h_faitage <= h_egout:
        raise ShapeError("Pignon : la hauteur au faîtage doit dépasser la hauteur sous égout.")
    return [[0, 0, 0], [w, 0, 0], [w, h_egout, 0], [w / 2, h_faitage, 0], [0, h_egout, 0]]


def pignon_porte(w: float, h_egout: float, h_faitage: float, x_porte: float, l_porte: float, h_porte: float,
                 forme: str = "arc") -> Path:
    """Pignon dont la porte est découpée depuis le bas (le contour extérieur contourne la porte)."""
    pignon(w, h_egout, h_faitage)
    if x_porte < 1 or x_porte + l_porte > w - 1:
        raise ShapeError("Porte hors de la façade.")
    r = l_porte / 2
    top_allowed = h_egout + (h_faitage - h_egout) * (1 - abs(2 * (x_porte + r) / w - 1))
    if h_porte >= top_allowed - 20:
        raise ShapeError("Porte trop haute : elle touche le toit (garder 20 mm au moins).")
    pts = [[0, 0, 0], [x_porte, 0, 0]]
    if forme == "arc":
        if h_porte < r:
            raise ShapeError("Porte en arc : la hauteur doit être au moins la moitié de la largeur.")
        pts += [[x_porte, h_porte - r, -1.0], [x_porte + l_porte, h_porte - r, 0]]
    else:
        pts += [[x_porte, h_porte, 0], [x_porte + l_porte, h_porte, 0]]
    pts += [[x_porte + l_porte, 0, 0], [w, 0, 0], [w, h_egout, 0], [w / 2, h_faitage, 0], [0, h_egout, 0]]
    return pts


def feston(w: float, h: float, n: int) -> Path:
    """Bandeau à festons (demi-cercles) sur le bord inférieur ; h = hauteur totale, festons compris."""
    _pos(w=w, h=h)
    n = int(n)
    if n < 1:
        raise ShapeError("Feston : au moins un feston.")
    r = w / (2 * n)
    if h <= r + 5:
        raise ShapeError(f"Feston : hauteur insuffisante (il faut plus de {r + 5:g} mm pour {n} festons).")
    pts = [[2 * r * i, r, 1.0] for i in range(n)]
    pts += [[w, r, 0], [w, h, 0], [0, h, 0]]
    return pts


def disque(d: float) -> Path:
    _pos(d=d)
    r = d / 2
    return [[r, 0, 1.0], [r, d, 1.0]]


def _pos(**vals):
    for k, v in vals.items():
        if v is None or float(v) <= 0:
            raise ShapeError(f"Forme : « {k} » doit être positif.")


SHAPES = {
    "rectangle": "Rectangle",
    "arrondi": "Rectangle à angles arrondis",
    "arc": "Plein cintre (porte, fenêtre, arche)",
    "pignon": "Pignon (façade à deux pentes)",
    "pignon_porte": "Pignon avec porte découpée",
    "feston": "Bandeau à festons (lambrequin)",
    "disque": "Disque",
    "libre": "Forme libre (DXF / Rhino)",
}


def build(shape: str, w: float, h: float, params: dict | None = None) -> Path:
    """Construit une forme dans son encombrement w × h (utilisé par les pièces libres)."""
    p = params or {}
    if shape == "rectangle":
        return rectangle(w, h)
    if shape == "arrondi":
        return arrondi(w, h, float(p.get("rayon", 0)))
    if shape == "arc":
        return arc(w, h)
    if shape == "pignon":
        return pignon(w, float(p["h_egout"]), h)
    if shape == "feston":
        return feston(w, h, int(p.get("n", 6)))
    if shape == "disque":
        if abs(w - h) > 0.01:
            raise ShapeError("Disque : longueur et largeur doivent être égales au diamètre.")
        return disque(w)
    raise ShapeError(f"Forme inconnue : {shape}")


def has_concave_corner(path: Path) -> bool:
    """Vrai si le contour a des angles rentrants (arrondis au rayon de la fraise à l'usinage)."""
    pts = discretize(path, 0.5)
    n = len(pts)
    for i in range(n):
        (ax, ay), (bx, by), (cx, cy) = pts[i - 1], pts[i], pts[(i + 1) % n]
        if (bx - ax) * (cy - by) - (by - ay) * (cx - bx) < -1e-6:
            return True
    return False


def demi_pignon(wh: float, h_egout: float, h_faitage: float, x_porte: float | None = None,
                h_porte: float | None = None, forme: str = "arc") -> Path:
    """Moitié gauche d'un pignon coupé dans l'axe du faîtage (façade trop grande pour un panneau).

    ``wh`` = demi-largeur ; la porte est centrée sur l'axe : ``x_porte`` = son bord gauche, elle va jusqu'à wh.
    La moitié droite s'obtient avec ``mirror_x``.
    """
    _pos(wh=wh, h_egout=h_egout, h_faitage=h_faitage)
    if h_faitage <= h_egout:
        raise ShapeError("Pignon : la hauteur au faîtage doit dépasser la hauteur sous égout.")
    pts = [[0, 0, 0]]
    if x_porte is None:
        pts.append([wh, 0, 0])
    else:
        r = wh - x_porte
        if r <= 0:
            raise ShapeError("Porte hors de la demi-façade.")
        if forme == "arc":
            if h_porte < r:
                raise ShapeError("Porte en arc : la hauteur doit être au moins la moitié de la largeur.")
            pts += [[x_porte, 0, 0], [x_porte, h_porte - r, -math.tan(math.pi / 8)], [wh, h_porte, 0]]
        else:
            pts += [[x_porte, 0, 0], [x_porte, h_porte, 0], [wh, h_porte, 0]]
    pts += [[wh, h_faitage, 0], [0, h_egout, 0]]
    return pts


def mirror_x(path: Path, w: float) -> Path:
    """Symétrique d'un contour par rapport à l'axe vertical x = w/2 (résultat remis en sens trigo)."""
    return normalize([[w - x, y, -b] for x, y, b in path])
