"""Maisonnette de jeu (module « House » de KIDISENS) : façade en pignon avec
porte en plein cintre et fenêtres, façade arrière, deux côtés, deux pans de toit.
Les façades peuvent aussi être des cadres assemblés (montants, traverses, arbalétriers).

Repère des façades : X = largeur (0 à gauche vu de face), Y = hauteur (0 au sol).
Repère des côtés : X = profondeur, Y = hauteur. Pans de toit : X = rampant.
"""
from __future__ import annotations

import math

from .. import shapes as S
from ..model import OUVERTURE, PERCAGE, Extra, Feature, Part
from ..profile import material, rule, thickness
from ..provenance import A_CONFIRMER, CALCULE, Dim, calc, fmt, worst_source
from . import Design, FurnitureModel, ParamDef, pdim, pval
from .coffre_jouets import _positions


def _cadre(p):
    return pval(p, "facades") == "cadre"


def _pleine(p):
    return not _cadre(p)


def _porte(p):
    return _pleine(p) and pval(p, "porte") in ("arc", "rectangle")


def _fen_facade(p):
    return _pleine(p) and pval(p, "fenetres_facade") == "deux"


def _fen(p):
    return _fen_facade(p) or pval(p, "fenetres_cotes") == "une"


class Maisonnette(FurnitureModel):
    id = "maisonnette"
    name = "Maisonnette de jeu (House)"
    description = ("Façade en pignon avec porte en plein cintre et fenêtres, façade arrière, deux côtés et deux "
                   "pans de toit. Formes exactes (arcs, pentes) pour dessins, DXF et usinage.")
    params = [
        ParamDef("largeur", "Largeur de la façade", "mm", group="dimensions", group_title="Dimensions",
                 min=600, max=3000),
        ParamDef("profondeur", "Profondeur hors tout (façades comprises)", "mm", group="dimensions", min=400,
                 max=3000),
        ParamDef("hauteur_egout", "Hauteur des murs sous le toit (égout)", "mm", group="dimensions", min=600,
                 max=2500),
        ParamDef("hauteur_faitage", "Hauteur au faîtage (sommet du pignon)", "mm", group="dimensions", min=700,
                 max=3000),
        ParamDef("quantite", "Nombre de maisonnettes", "int", group="dimensions", min=1, max=20, proposal=1),
        ParamDef("materiau", "Matière des murs", "material", group="construction",
                 group_title="Matière et construction"),
        ParamDef("materiau_toit", "Matière du toit", "material", group="construction"),
        ParamDef("assemblage", "Assemblage des angles", "choice", group="construction",
                 choices=[["tasseaux", "Tasseaux d'angle collés-vissés"], ["confirmat", "Vis confirmat"]]),
        ParamDef("sens_fil_murs", "Sens du fil des murs (bois à fil)", "choice", group="construction",
                 choices=[["vertical", "Vertical (aspect lames, pièces tournées sur le panneau)"],
                          ["horizontal", "Horizontal"]], proposal="vertical",
                 help="Sans effet pour une matière sans fil (MDF)."),
        ParamDef("facades", "Fabrication des façades", "choice", group="construction",
                 choices=[["entieres", "D'une seule pièce"],
                          ["deux", "En deux moitiés jointes dans l'axe du faîtage (grandes façades)"],
                          ["cadre", "En cadre assemblé : montants, traverses et arbalétriers (façade ouverte)"]],
                 help="Une façade plus grande que le panneau doit être faite en deux moitiés ou en cadre."),
        ParamDef("largeur_cadre", "Largeur des montants, traverses et arbalétriers du cadre", "mm",
                 group="construction", when=_cadre, min=30, max=300,
                 help="Largeur des bandes, à relever sur les cadres de l'atelier."),
        ParamDef("assemblage_cadre", "Assemblage des angles du cadre", "choice", group="construction",
                 when=_cadre, choices=[["tourillons", "Tourillons collés"], ["vis", "Collé-vissé en bout"]]),
        ParamDef("porte", "Porte de la façade", "choice", group="porte", group_title="Porte", when=_pleine,
                 choices=[["arc", "Plein cintre (arrondie en haut)"], ["rectangle", "Rectangulaire"],
                          ["aucune", "Pas de porte"]]),
        ParamDef("largeur_porte", "Largeur de la porte", "mm", group="porte", when=_porte, min=300, max=1500),
        ParamDef("hauteur_porte", "Hauteur de la porte (sommet de l'arc)", "mm", group="porte", when=_porte,
                 min=400, max=2200),
        ParamDef("fenetres_facade", "Fenêtres de la façade", "choice", group="fenetres", group_title="Fenêtres",
                 when=_pleine,
                 choices=[["aucune", "Aucune"], ["deux", "Deux, symétriques de part et d'autre de la porte"]]),
        ParamDef("fenetres_cotes", "Fenêtres des côtés", "choice", group="fenetres",
                 choices=[["aucune", "Aucune"], ["une", "Une au milieu de chaque côté"]]),
        ParamDef("forme_fenetre", "Forme des fenêtres", "choice", group="fenetres", when=_fen,
                 choices=[["arc", "Plein cintre"], ["rectangle", "Rectangulaire"]]),
        ParamDef("largeur_fenetre", "Largeur des fenêtres", "mm", group="fenetres", when=_fen, min=100, max=1000),
        ParamDef("hauteur_fenetre", "Hauteur des fenêtres", "mm", group="fenetres", when=_fen, min=100, max=1200),
        ParamDef("allege_fenetre", "Hauteur du bas des fenêtres depuis le sol", "mm", group="fenetres", when=_fen,
                 min=100, max=1500),
        ParamDef("debord_pignons", "Débord du toit au-delà des façades (avant et arrière)", "mm", group="toit",
                 group_title="Toit et finition", proposal=30, min=0, max=300),
        ParamDef("debord_egout", "Débord du toit au bas des pentes", "mm", group="toit", proposal=30, min=0,
                 max=300),
        ParamDef("finition", "Finition des arêtes et des ouvertures", "choice", group="toit",
                 choices=[["arrondi", "Arrondies et poncées"], ["aucune", "Vives poncées"]]),
    ]

    def build(self, params: dict, profile: dict) -> Design:
        d = Design()
        W, P = pdim(params, "largeur"), pdim(params, "profondeur")
        he, hf = pdim(params, "hauteur_egout"), pdim(params, "hauteur_faitage")
        qty = int(pval(params, "quantite"))
        mat_id, tmat_id = pval(params, "materiau"), pval(params, "materiau_toit")
        mat, tmat = material(profile, mat_id), material(profile, tmat_id)
        d.used_materials.update({mat_id, tmat_id})
        e, et = thickness(profile, mat_id), thickness(profile, tmat_id)
        grain, tgrain = bool(mat["fil"]), bool(tmat["fil"])
        if hf.value <= he.value + 50:
            d.block("La hauteur au faîtage doit dépasser la hauteur sous égout d'au moins 50 mm.")
            return d
        geo_src = worst_source(W, he, hf)

        # --- Pente et rampant ---------------------------------------------------
        demi = W.value / 2
        rampant = calc(math.hypot(demi, hf.value - he.value),
                       f"√((L/2)² + (H.faîtage − H.égout)²) = √({fmt(demi)}² + {fmt(hf.value - he.value)}²)",
                       W, he, hf)
        pente = math.degrees(math.atan2(hf.value - he.value, demi))

        # --- Façade avant : pignon + porte + fenêtres ---------------------------
        front_feats = []
        door = None
        if _porte(params):
            lp, hp = pdim(params, "largeur_porte"), pdim(params, "hauteur_porte")
            xp = calc((W.value - lp.value) / 2, f"(L − larg.porte) / 2 = ({fmt(W.value)} − {fmt(lp.value)}) / 2",
                      W, lp)
            door = (xp, lp, hp)
        try:
            if door:
                fpath = S.pignon_porte(W.value, he.value, hf.value, door[0].value, door[1].value, door[2].value,
                                       "arc" if pval(params, "porte") == "arc" else "rectangle")
            else:
                fpath = S.pignon(W.value, he.value, hf.value)
        except S.ShapeError as exc:
            d.block(f"Façade avant : {exc}")
            return d
        win = None
        if _fen(params):
            win = (pval(params, "forme_fenetre"), pdim(params, "largeur_fenetre"), pdim(params, "hauteur_fenetre"),
                   pdim(params, "allege_fenetre"))
        if win and _fen_facade(params):
            forme, lf, hfw, al = win
            if door:
                xl = calc((door[0].value - lf.value) / 2, "centrée entre le bord et la porte", door[0], lf)
            else:
                xl = calc(W.value / 4 - lf.value / 2, "centrée sur le quart de la façade", W, lf)
            xr = calc(W.value - xl.value - lf.value, "symétrique de la fenêtre gauche", W, xl, lf)
            for side, x in (("gauche", xl), ("droite", xr)):
                front_feats.append(_window(forme, f"Fenêtre {side}", x, al, lf, hfw))
            if door and xl.value + lf.value > door[0].value - 40:
                d.block("Fenêtres trop près de la porte (40 mm de matière minimum).")
        front_contour = {"shape": "pignon_porte" if door else "pignon",
                         "label": ("Pignon avec porte " + ("en plein cintre" if pval(params, "porte") == "arc"
                                                           else "rectangulaire")) if door else "Pignon",
                         "path": fpath, "source": worst_source(geo_src, *(door or ()))}
        corner_feats = self._corner_holes(params, profile, W, he, e, d)
        vertical = pval(params, "sens_fil_murs") == "vertical"
        wall_grain = dict(grain_x=grain and not vertical, grain_y=grain and vertical, rotation_allowed=not grain)
        wall = dict(material_id=mat_id, material_name=mat["nom"], thickness=e, face="Face intérieure vers le haut")
        back_corner = [Feature(f.kind, f.label, f.x, f.y, diameter=f.diameter, through=True) for f in corner_feats]
        pente_note = f"Pente du toit : {pente:.1f}°"
        if _cadre(params):
            if not self._cadre_parts(d, params, profile, qty, W, he, hf, e, wall, grain, pente):
                return d
        elif pval(params, "facades") != "deux":
            d.parts.append(Part("", "Façade avant", qty, length=W, width=hf, features=front_feats + corner_feats,
                                contour=front_contour, orientation="X = largeur (gauche vu de face à X=0), "
                                "Y = hauteur (sol à Y=0)",
                                assembly="Les côtés viennent entre les façades ; les pans de toit reposent sur les "
                                         "pentes.", notes=[pente_note], **wall, **wall_grain))
            d.parts.append(Part("", "Façade arrière", qty, length=W, width=hf, features=back_corner,
                                contour={"shape": "pignon", "label": "Pignon",
                                         "path": S.pignon(W.value, he.value, hf.value), "source": geo_src},
                                orientation="X = largeur, Y = hauteur",
                                assembly="Même pignon que la façade avant, sans ouverture.", **wall, **wall_grain))
        else:
            Wh = calc(W.value / 2, f"L / 2 = {fmt(W.value)} / 2", W)
            forme_p = "arc" if pval(params, "porte") == "arc" else "rectangle"
            try:
                lpath = S.demi_pignon(Wh.value, he.value, hf.value, door[0].value if door else None,
                                      door[2].value if door else None, forme_p)
                bpath = S.demi_pignon(Wh.value, he.value, hf.value)
            except S.ShapeError as exc:
                d.block(f"Demi-façade : {exc}")
                return d
            fl, fr, err = _split(front_feats + corner_feats, Wh)
            bl, br, err2 = _split(back_corner, Wh)
            for msg in err + err2:
                d.block(msg)
            src = front_contour["source"]
            lbl = "Demi-pignon gauche" + (" avec demi-porte" if door else "")
            common = dict(length=Wh, width=hf, orientation="X = demi-largeur (axe du faîtage à droite pour la "
                          "moitié gauche), Y = hauteur", **wall, **wall_grain)
            d.parts.append(Part("", "Demi-façade avant gauche", qty, features=fl,
                                contour={"shape": "demi_pignon", "label": lbl, "path": lpath, "source": src},
                                assembly="Jointe à la moitié droite dans l'axe du faîtage (tasseau + couvre-joint).",
                                notes=[pente_note], **common))
            d.parts.append(Part("", "Demi-façade avant droite", qty, features=fr,
                                contour={"shape": "demi_pignon", "label": lbl.replace("gauche", "droit"),
                                         "path": S.mirror_x(lpath, Wh.value), "source": src},
                                assembly="Symétrique de la moitié gauche.", mirror_of="Demi-façade avant gauche",
                                notes=[pente_note], **common))
            d.parts.append(Part("", "Demi-façade arrière gauche", qty, features=bl,
                                contour={"shape": "demi_pignon", "label": "Demi-pignon gauche", "path": bpath,
                                         "source": geo_src},
                                assembly="Jointe à la moitié droite dans l'axe du faîtage.", **common))
            d.parts.append(Part("", "Demi-façade arrière droite", qty, features=br,
                                contour={"shape": "demi_pignon", "label": "Demi-pignon droit",
                                         "path": S.mirror_x(bpath, Wh.value), "source": geo_src},
                                assembly="Symétrique de la moitié gauche.", mirror_of="Demi-façade arrière gauche",
                                **common))
            joint_h = hf.value - (door[2].value if door else 0)
            d.extras += [
                Extra("element", f"Tasseau de jonction des demi-façades, longueur ≈ {fmt(joint_h - 40)} mm",
                      2 * qty, "u", A_CONFIRMER, "Collé-vissé à l'intérieur, dans l'axe du faîtage"),
                Extra("element", f"Couvre-joint décoratif vertical, longueur ≈ {fmt(joint_h)} mm", 2 * qty, "u",
                      A_CONFIRMER, "Masque le joint côté extérieur — à valider esthétiquement"),
            ]

        # --- Côtés ------------------------------------------------------------------
        Lc = calc(P.value - 2 * e.value, f"profondeur − 2×ép = {fmt(P.value)} − 2×{fmt(e.value)}", P, e)
        side_feats = []
        if win and pval(params, "fenetres_cotes") == "une":
            forme, lf, hfw, al = win
            xs = calc((Lc.value - lf.value) / 2, "centrée", Lc, lf)
            if xs.value < 40:
                d.block("Fenêtre de côté trop large pour la profondeur.")
            if al.value + hfw.value > he.value - 40:
                d.block("Fenêtre de côté trop haute (40 mm sous le haut du côté).")
            side_feats.append(_window(forme, "Fenêtre de côté", xs, al, lf, hfw))
        d.parts.append(Part("", "Côté", 2 * qty, length=Lc, width=he, features=side_feats,
                            orientation="X = profondeur, Y = hauteur", **wall, **wall_grain,
                            assembly="Entre les deux façades, chant supérieur sous le pan de toit."))

        # --- Pans de toit ---------------------------------------------------------
        dbp, dbe = pdim(params, "debord_pignons"), pdim(params, "debord_egout")
        Lt = calc(rampant.value + dbe.value,
                  f"rampant + débord bas = √({fmt(demi)}² + {fmt(hf.value - he.value)}²) + {fmt(dbe.value)}",
                  rampant, dbe)
        Wt = calc(P.value + 2 * dbp.value, f"profondeur + 2×débord = {fmt(P.value)} + 2×{fmt(dbp.value)}", P, dbp)
        d.parts.append(Part("", "Pan de toit", 2 * qty, material_id=tmat_id, material_name=tmat["nom"],
                            thickness=et, length=Lt, width=Wt, grain_x=tgrain, rotation_allowed=not tgrain,
                            face="Face extérieure vers le haut", orientation="X = le long de la pente (faîtage à X=0)",
                            assembly="Posé sur les pentes des façades et le chant des côtés, jonction bord à bord au "
                                     "faîtage (onglet hors CNC).",
                            notes=[f"Pente {pente:.1f}° — longueur sans recouvrement au faîtage"]))
        real_top = hf.value + et.value / math.cos(math.radians(pente))
        d.warn(f"Hauteur hors tout réelle avec le toit ≈ {fmt(real_top)} mm (faîtage + épaisseur du toit).")

        # --- Compléments ------------------------------------------------------------
        if pval(params, "assemblage") == "tasseaux":
            d.extras += [
                Extra("element", f"Tasseau d'angle 30×30, longueur {fmt(he.value - 20)} mm", 4 * qty, "u",
                      A_CONFIRMER, "Collé-vissé dans chaque angle intérieur — section à confirmer"),
                Extra("element", f"Tasseau sous toit le long des pentes, longueur ≈ {fmt(rampant.value - 60)} mm",
                      4 * qty, "u", A_CONFIRMER, "Un par pente et par façade, pour visser les pans de toit"),
                Extra("quincaillerie", "Vis 4×40", 40 * qty, "u", A_CONFIRMER, "Ordre de grandeur"),
            ]
        else:
            n = sum(1 for f in corner_feats if f.kind == PERCAGE)
            d.extras += [
                Extra("quincaillerie", "Vis confirmat 7×50", 2 * n * qty, "u", CALCULE),
                Extra("operation", "Perçage en bout des côtés Ø5 × 45 mm", 2 * n * qty, "trou", CALCULE,
                      "Hors CNC : gabarit de perçage"),
                Extra("element", f"Tasseau sous toit le long des pentes, longueur ≈ {fmt(rampant.value - 60)} mm",
                      4 * qty, "u", A_CONFIRMER, "Pour visser les pans de toit"),
            ]
        d.extras += [
            Extra("operation", f"Coupe d'onglet du faîtage : chant des pans biseauté à {pente:.1f}° hors équerre",
                  2 * qty, "pan", A_CONFIRMER, "Scie plongeante / scie sur table inclinable — hors CNC 3 axes"),
            Extra("operation", f"Chanfrein du haut des côtés à {pente:.1f}° (appui du toit)", 2 * qty, "côté",
                  A_CONFIRMER, "Ou cale biseautée — à confirmer"),
            Extra("securite", "Fixation au sol ou au mur (anti-basculement)", qty, "maison", A_CONFIRMER,
                  "Indispensable en aire de jeux collective"),
            Extra("securite", "Ouvertures et arêtes arrondies, contrôle des risques de coincement (doigts, tête)",
                  qty, "maison", A_CONFIRMER, "Norme applicable à vérifier (EN 1176 pour les aires de jeux)"),
            Extra("element", "Décor non dessiné : cheminée, jardinières, suspension, croisillons de fenêtres",
                  qty, "lot", A_CONFIRMER, "À définir avec Hiba"),
        ]
        if pval(params, "finition") == "arrondi":
            d.extras.append(Extra("operation", "Arrondi R3 et ponçage des arêtes, de la porte et des fenêtres", qty,
                                  "maison", A_CONFIRMER))

        # --- Vue de face ------------------------------------------------------------
        u = (demi / rampant.value, (hf.value - he.value) / rampant.value)
        n_l = (-u[1], u[0])
        A = (-u[0] * dbe.value, he.value - u[1] * dbe.value)
        B = (demi, hf.value)
        left = [[A[0], A[1], 0], [B[0], B[1], 0], [B[0] + n_l[0] * et.value, B[1] + n_l[1] * et.value, 0],
                [A[0] + n_l[0] * et.value, A[1] + n_l[1] * et.value, 0]]
        right = [[W.value - x, y, 0] for x, y, _ in left][::-1]
        rects = [{"name": "Façade avant", "path": fpath},
                 {"name": "Pan de toit", "path": left, "label": "Toit"},
                 {"name": "Pan de toit", "path": right, "label": "Toit"}]
        for f in front_feats:
            rects.append({"name": f.label, "path": f.path, "hole": True})
        if _cadre(params):
            b = pdim(params, "largeur_cadre").value
            pied, chute = _arbaletrier_cotes(b, pente)
            rects.append({"name": "Vide du cadre", "hole": True,
                          "path": [[b, b, 0], [W.value - b, b, 0], [W.value - b, he.value - b, 0],
                                   [b, he.value - b, 0]]})
            rects.append({"name": "Vide du pignon", "hole": True,
                          "path": [[pied, he.value, 0], [W.value - pied, he.value, 0], [demi, hf.value - chute, 0]]})
        d.elevation = {"title": f"Vue de face — {self.name}", "width": W.value, "height": real_top,
                       "depth": P.value, "rects": rects}
        d.number_parts()
        return d

    def _cadre_parts(self, d, params, profile, qty, W, he, hf, e, wall, grain, pente) -> bool:
        """Façades en cadre : chaque façade = 2 montants, une traverse basse, une traverse haute (entrait)
        à l'égout et 2 arbalétriers le long des pentes. Les traverses viennent entre les montants, les
        arbalétriers reposent sur le haut des montants et de l'entrait et se rejoignent dans l'axe du faîtage."""
        b = pdim(params, "largeur_cadre")
        demi = W.value / 2
        pied, chute = _arbaletrier_cotes(b.value, pente)
        if he.value - 2 * b.value < 100:
            d.block("Cadre : les montants et traverses sont trop larges pour la hauteur des murs.")
            return False
        if pied > demi - 20 or hf.value - chute < he.value + 20:
            d.block(f"Cadre : arbalétriers de {fmt(b.value)} mm impossibles avec une pente de {pente:.1f}° "
                    "(réduire la largeur du cadre ou augmenter la hauteur au faîtage).")
            return False
        if pval(params, "assemblage") == "confirmat" and b.value < e.value + 20:
            d.block("Cadre : montants trop étroits pour recevoir les côtés et les vis confirmat.")
        strip = dict(grain_x=grain, rotation_allowed=not grain, **wall)
        n = 2 * qty   # façade avant + façade arrière, identiques
        feats = []
        if pval(params, "assemblage") == "confirmat":
            d.used_rules.add("confirmat")
            ent = rule(profile, "confirmat", "entraxe_bord")
            emax = rule(profile, "confirmat", "entraxe_max")
            dtr = rule(profile, "confirmat", "d_traversant")
            for x in _positions(he.value, ent.value, emax.value):
                feats.append(Feature(PERCAGE, "Confirmat côté", Dim(x, worst_source(ent, emax, he),
                                                                     "répartition confirmat"),
                                     calc(e.value / 2, "ép/2", e), diameter=dtr, through=True))
        d.parts.append(Part("", "Montant de façade", 2 * n, length=he, width=b, features=feats,
                            orientation="X = hauteur (sol à X=0), Y = largeur (bord extérieur à Y=0)",
                            assembly="Un à chaque angle des deux façades, sur toute la hauteur des murs ; les "
                                     "côtés viennent contre sa face intérieure. Retourner la pièce pour l'angle "
                                     "opposé.", **strip))
        Lt = calc(W.value - 2 * b.value, f"L − 2×larg.cadre = {fmt(W.value)} − 2×{fmt(b.value)}", W, b)
        d.parts.append(Part("", "Traverse basse de façade", n, length=Lt, width=b, orientation="X = largeur",
                            assembly="Entre les deux montants, au sol.", **strip))
        d.parts.append(Part("", "Traverse haute de façade (entrait)", n, length=Lt, width=b,
                            orientation="X = largeur",
                            assembly="Entre les deux montants, dessus aligné sur le haut des montants (égout) ; "
                                     "reçoit le pied des arbalétriers.", **strip))
        Wa = calc(demi, f"L / 2 = {fmt(W.value)} / 2", W)
        Ha = calc(hf.value - he.value, f"H.faîtage − H.égout = {fmt(hf.value)} − {fmt(he.value)}", hf, he)
        path = [[0, 0, 0], [pied, 0, 0], [Wa.value, Ha.value - chute, 0], [Wa.value, Ha.value, 0]]
        d.parts.append(Part("", "Arbalétrier", 2 * n, length=Wa, width=Ha,
                            contour={"shape": "libre", "label": f"Bande en pente {pente:.1f}°, largeur "
                                     f"{fmt(b.value)}", "path": path, "source": worst_source(W, he, hf, b)},
                            orientation="X = demi-largeur (pied à X=0), Y = hauteur au-dessus de l'égout",
                            assembly="Pied posé sur le haut du montant et de l'entrait, coupe verticale dans "
                                     "l'axe du faîtage contre l'arbalétrier opposé. Retourner la pièce pour "
                                     "l'autre pente.",
                            notes=[f"Pointe de {pente:.1f}° au pied (fragile : manipuler avec soin)",
                                   f"Pied {fmt(pied)} mm à plat, coupe du faîtage {fmt(chute)} mm",
                                   "Placée par son encombrement : imbrication tête-bêche possible dans Aspire"],
                            **strip))
        k = 7 * n  # jonctions par façade : 2 montant/traverse basse, 2 montant/entrait, 2 pieds, 1 faîtage
        if pval(params, "assemblage_cadre") == "tourillons":
            d.extras.append(Extra("quincaillerie", "Tourillons Ø8×40 (2 par jonction)", 2 * k, "u", A_CONFIRMER,
                                  "7 jonctions par façade — perçage en chant hors CNC, au gabarit"))
        else:
            d.extras.append(Extra("quincaillerie", "Vis 4×50 (2 par jonction)", 2 * k, "u", A_CONFIRMER,
                                  "7 jonctions par façade — avant-trou et fraisure hors CNC"))
        d.extras.append(Extra("operation", "Collage et équerrage des cadres de façade sur gabarit", n, "cadre",
                              A_CONFIRMER))
        d.warn("Façades en cadre : façades ouvertes, sans porte ni fenêtre dessinée. Remplissage éventuel "
               "(panneau, barreaux) à définir avec Hiba.")
        return True

    def _corner_holes(self, params, profile, W, he, e, d) -> list[Feature]:
        if pval(params, "assemblage") != "confirmat":
            return []
        d.used_rules.add("confirmat")
        ent = rule(profile, "confirmat", "entraxe_bord")
        emax = rule(profile, "confirmat", "entraxe_max")
        dtr = rule(profile, "confirmat", "d_traversant")
        out = []
        for side, x in (("gauche", e.value / 2), ("droit", W.value - e.value / 2)):
            for y in _positions(he.value, ent.value, emax.value):
                out.append(Feature(PERCAGE, f"Confirmat côté {side}",
                                   calc(x, "ép/2" if side == "gauche" else "L − ép/2", e, W),
                                   Dim(y, worst_source(ent, emax, he), "répartition confirmat"), diameter=dtr,
                                   through=True))
        return out


def _arbaletrier_cotes(b: float, pente: float) -> tuple[float, float]:
    """Arbalétrier de largeur b (perpendiculaire à la pente) : longueur à plat du pied (coupe horizontale)
    et hauteur de la coupe verticale au faîtage."""
    a = math.radians(pente)
    return b / math.sin(a), b / math.cos(a)


def _split(features: list, Wh: Dim):
    """Répartit les usinages d'une façade entière entre ses deux moitiés (repère de chaque moitié)."""
    left, right, err = [], [], []
    for f in features:
        x0, _, x1, _ = f.bbox()
        if x1 <= Wh.value + 1e-6:
            left.append(f)
        elif x0 >= Wh.value - 1e-6:
            nx = Dim(f.x.value - Wh.value, f.x.source, (f.x.formule + " − L/2") if f.x.formule else "− L/2")
            right.append(Feature(f.kind, f.label, nx, f.y, f.w, f.h, f.diameter, f.depth, f.through, f.corner_r,
                                 f.note, f.shape, S.translate(f.path, -Wh.value, 0) if f.path else None))
        else:
            err.append(f"{f.label} coupé(e) par le joint des demi-façades : déplacer l'usinage.")
    return left, right, err


def _window(forme: str, label: str, x: Dim, y: Dim, w: Dim, h: Dim) -> Feature:
    path = S.arc(w.value, h.value) if forme == "arc" else S.rectangle(w.value, h.value)
    return Feature(OUVERTURE, label, x, y, w=w, h=h, through=True, shape="arc" if forme == "arc" else "rectangle",
                   path=S.translate(path, x.value, y.value),
                   note="Plein cintre" if forme == "arc" else "")
