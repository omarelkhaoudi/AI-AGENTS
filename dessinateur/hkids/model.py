"""Structures de données du dossier de fabrication.

Repère pièce : origine au coin inférieur gauche de la face usinée, X le long
de la longueur de débit, Y le long de la largeur, Z vers le haut (profondeurs
positives mesurées depuis la face usinée). Unités : millimètres.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .provenance import A_CONFIRMER, CALCULE, FOURNI, Dim, r1

# Types d'usinage, volontairement distincts (test de réception n°5)
PERCAGE = "percage"        # trou rond, borgne ou traversant
RAINURE = "rainure"        # entaille rectangulaire longue (embrèvement, fond)
POCHE = "poche"            # évidement rectangulaire borgne
OUVERTURE = "ouverture"    # découpe intérieure traversante (rectangle ou cercle)

FEATURE_LABELS = {PERCAGE: "Perçage", RAINURE: "Rainure", POCHE: "Poche", OUVERTURE: "Ouverture"}


@dataclass
class Feature:
    kind: str
    label: str
    x: Dim                      # rectangle : coin bas-gauche ; cercle : centre
    y: Dim
    w: Dim | None = None        # rectangle
    h: Dim | None = None
    diameter: Dim | None = None  # cercle / perçage
    depth: Dim | None = None    # None = traversant
    through: bool = False
    corner_r: float = 0.0       # rayon des angles (ouverture rectangulaire)
    note: str = ""
    shape: str = ""             # forme (voir shapes.SHAPES) ; x, y, w, h = encombrement
    path: list | None = None    # contour exact [[x, y, bulge], ...] dans le repère pièce

    @property
    def is_circle(self) -> bool:
        return self.diameter is not None

    def bbox(self) -> tuple[float, float, float, float]:
        if self.path:
            from .shapes import bbox
            return bbox(self.path)
        if self.is_circle:
            r = self.diameter.value / 2
            return (self.x.value - r, self.y.value - r, self.x.value + r, self.y.value + r)
        return (self.x.value, self.y.value, self.x.value + self.w.value, self.y.value + self.h.value)

    def dims(self) -> list[Dim]:
        return [d for d in (self.x, self.y, self.w, self.h, self.diameter, self.depth) if d is not None]

    def to_dict(self) -> dict:
        d = {"kind": self.kind, "label": self.label, "x": self.x.to_dict(), "y": self.y.to_dict(),
             "through": self.through}
        for k in ("w", "h", "diameter", "depth"):
            v = getattr(self, k)
            if v is not None:
                d[k] = v.to_dict()
        if self.corner_r:
            d["corner_r"] = r1(self.corner_r)
        if self.note:
            d["note"] = self.note
        if self.path:
            d["shape"] = self.shape or "libre"
            d["path"] = [[round(x, 4), round(y, 4), round(b, 9)] for x, y, b in self.path]
        return d


@dataclass
class Part:
    ref: str
    name: str
    qty: int
    material_id: str
    material_name: str
    thickness: Dim
    length: Dim                 # X, dimension de débit
    width: Dim                  # Y, dimension de débit
    grain_x: bool = False       # fil du bois parallèle à X
    grain_y: bool = False       # fil du bois parallèle à Y (pièce tournée de 90° sur le panneau)
    rotation_allowed: bool = True
    corner_r: float = 0.0       # angles arrondis du contour extérieur
    features: list[Feature] = field(default_factory=list)
    face: str = "Face usinée vers le haut"
    orientation: str = ""
    assembly: str = ""
    edges: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    mirror_of: str = ""
    contour: dict | None = None  # {"shape", "label", "path"} si le contour n'est pas un rectangle
    cnc: bool = True

    def all_dims(self) -> list[Dim]:
        out = [self.thickness, self.length, self.width]
        for f in self.features:
            out.extend(f.dims())
        return out

    def worst_source(self) -> str:
        srcs = {d.source for d in self.all_dims()}
        if A_CONFIRMER in srcs:
            return A_CONFIRMER
        if CALCULE in srcs:
            return CALCULE
        return FOURNI

    def to_dict(self) -> dict:
        return {
            "ref": self.ref, "name": self.name, "qty": self.qty,
            "material_id": self.material_id, "material_name": self.material_name,
            "thickness": self.thickness.to_dict(), "length": self.length.to_dict(),
            "width": self.width.to_dict(), "grain_x": self.grain_x, "grain_y": self.grain_y,
            "rotation_allowed": self.rotation_allowed, "corner_r": r1(self.corner_r),
            "features": [f.to_dict() for f in self.features], "face": self.face,
            "orientation": self.orientation, "assembly": self.assembly, "edges": self.edges,
            "notes": self.notes, "mirror_of": self.mirror_of, "cnc": self.cnc,
            "contour": self.contour,
            "source": self.worst_source(),
        }


@dataclass
class Extra:
    """Élément complémentaire (non découpé à la CNC) ou opération hors CNC."""
    category: str     # quincaillerie | chant | element | operation | securite
    designation: str
    qty: float | str
    unit: str = "u"
    source: str = CALCULE
    note: str = ""

    def to_dict(self) -> dict:
        return {"category": self.category, "designation": self.designation, "qty": self.qty,
                "unit": self.unit, "source": self.source, "note": self.note}


EXTRA_CATEGORIES = {
    "quincaillerie": "Quincaillerie",
    "chant": "Chants",
    "element": "Éléments non découpés à la CNC (poutres, poteaux, renforts, tasseaux…)",
    "operation": "Opérations hors CNC",
    "securite": "Sécurité enfant",
}
