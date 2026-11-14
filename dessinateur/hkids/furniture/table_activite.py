"""Table d'activité enfant : plateau aux angles arrondis, deux piètements
panneaux reliés par une traverse en embrèvement, ouverture et range-crayons
optionnels."""
from __future__ import annotations

from ..model import OUVERTURE, PERCAGE, POCHE, Extra, Feature, Part
from ..profile import material, rule, thickness, tool
from ..provenance import A_CONFIRMER, CALCULE, Dim, calc, fmt, worst_source
from . import Design, FurnitureModel, ParamDef, pdim, pval


def _ouv(p):
    return pval(p, "ouverture") == "rectangle"


def _poche(p):
    return pval(p, "range_crayons") == "poche"


class TableActivite(FurnitureModel):
    id = "table_activite"
    name = "Table d'activité enfant"
    description = ("Plateau à angles arrondis, deux piètements panneaux et une traverse en embrèvement. "
                   "Ouverture décorative et range-crayons optionnels.")
    params = [
        ParamDef("longueur", "Longueur du plateau", "mm", group="dimensions", group_title="Dimensions",
                 min=400, max=2200),
        ParamDef("largeur", "Largeur (profondeur) du plateau", "mm", group="dimensions", min=300, max=1200),
        ParamDef("hauteur", "Hauteur totale", "mm", group="dimensions", min=300, max=800,
                 help="Repères usuels : 460 à 590 mm selon l'âge — à fixer par Hiba"),
        ParamDef("quantite", "Nombre de tables identiques", "int", group="dimensions", min=1, max=50, proposal=1),
        ParamDef("materiau", "Matière", "material", group="construction", group_title="Matière et construction"),
        ParamDef("rayon_angles", "Rayon des angles du plateau", "mm", group="construction", proposal=30,
                 min=0, max=200),
        ParamDef("debord", "Débord du plateau au-delà de chaque piètement", "mm", group="construction",
                 proposal=60, min=0, max=400),
        ParamDef("retrait_pied", "Retrait du piètement par rapport aux chants du plateau", "mm",
                 group="construction", proposal=40, min=0, max=200),
        ParamDef("hauteur_traverse", "Hauteur de la traverse", "mm", group="traverse", group_title="Traverse",
                 proposal=120, min=40, max=400),
        ParamDef("position_traverse", "Hauteur du dessous de la traverse depuis le sol", "mm", group="traverse",
                 proposal=150, min=0, max=700),
        ParamDef("ouverture", "Ouverture dans les piètements", "choice", group="ouverture",
                 group_title="Ouverture des piètements",
                 choices=[["aucune", "Aucune"], ["rectangle", "Rectangle à angles arrondis"]]),
        ParamDef("largeur_ouverture", "Largeur de l'ouverture", "mm", group="ouverture", when=_ouv, min=20),
        ParamDef("hauteur_ouverture", "Hauteur de l'ouverture", "mm", group="ouverture", when=_ouv, min=20),
        ParamDef("bas_ouverture", "Hauteur du bas de l'ouverture depuis le sol", "mm", group="ouverture",
                 when=_ouv, min=0),
        ParamDef("rayon_ouverture", "Rayon des angles de l'ouverture", "mm", group="ouverture", when=_ouv,
                 proposal=30, min=0),
        ParamDef("range_crayons", "Range-crayons dans le plateau", "choice", group="crayons",
                 group_title="Range-crayons", choices=[["aucun", "Aucun"], ["poche", "Poche usinée"]]),
        ParamDef("longueur_poche", "Longueur de la poche", "mm", group="crayons", when=_poche, min=30),
        ParamDef("largeur_poche", "Largeur de la poche", "mm", group="crayons", when=_poche, min=10),
        ParamDef("profondeur_poche", "Profondeur de la poche", "mm", group="crayons", when=_poche, min=1),
        ParamDef("bord_poche", "Distance poche / chant arrière du plateau", "mm", group="crayons", when=_poche,
                 proposal=40, min=10),
    ]

    def build(self, params: dict, profile: dict) -> Design:
        d = Design()
        L, P, H = pdim(params, "longueur"), pdim(params, "largeur"), pdim(params, "hauteur")
        qty = int(pval(params, "quantite"))
        mat_id = pval(params, "materiau")
        mat = material(profile, mat_id)
        d.used_materials.add(mat_id)
        e = thickness(profile, mat_id)
        grain = bool(mat["fil"])
        rc, deb, rp = pdim(params, "rayon_angles"), pdim(params, "debord"), pdim(params, "retrait_pied")
        ht, zt = pdim(params, "hauteur_traverse"), pdim(params, "position_traverse")
        d.used_rules.update({"embrevement", "confirmat"})
        dp = rule(profile, "embrevement", "profondeur")
        jw = rule(profile, "embrevement", "jeu_largeur")
        jl = rule(profile, "embrevement", "jeu_longueur")
        dtr = rule(profile, "confirmat", "d_traversant")
        t_cont = tool(profile, profile["usinage"]["outil_contour"])
        D = Dim(float(t_cont["diametre"]), "fourni" if t_cont.get("confirme") else A_CONFIRMER, "Ø fraise")

        Hp = calc(H.value - e.value, f"H − ép = {fmt(H.value)} − {fmt(e.value)}", H, e)
        Wp = calc(P.value - 2 * rp.value, f"larg. plateau − 2×retrait = {fmt(P.value)} − 2×{fmt(rp.value)}", P, rp)
        between = L.value - 2 * deb.value - 2 * e.value
        if between < 150:
            d.block("Écart entre piètements trop faible : réduire le débord ou augmenter la longueur.")
            return d
        if zt.value + ht.value > Hp.value - 40:
            d.block("La traverse arrive trop près du plateau (moins de 40 mm).")
        if rc.value * 2 > min(L.value, P.value):
            d.block("Rayon des angles du plateau trop grand.")

        # --- Plateau -------------------------------------------------------------
        top_feats = []
        if _poche(params):
            lp, wpk, pp, bp = (pdim(params, k) for k in ("longueur_poche", "largeur_poche", "profondeur_poche",
                                                        "bord_poche"))
            if pp.value >= e.value - 4:
                d.block("Poche trop profonde : il doit rester au moins 4 mm de matière.")
            x0 = calc((L.value - lp.value) / 2, "(L − long.poche) / 2 — centrée", L, lp)
            y0 = calc(P.value - bp.value - wpk.value, "larg − bord − larg.poche", P, bp, wpk)
            top_feats.append(Feature(POCHE, "Range-crayons", x0, y0, w=lp, h=wpk, depth=pp,
                                     corner_r=D.value / 2,
                                     note=f"Angles intérieurs R{fmt(D.value / 2)} (rayon de la fraise)"))
        d.parts.append(Part("", "Plateau", qty, material_id=mat_id, material_name=mat["nom"], thickness=e,
                            length=L, width=P, grain_x=grain, rotation_allowed=not grain, corner_r=rc.value,
                            features=top_feats, face="Face supérieure vers le haut",
                            orientation="X = longueur de la table, Y=0 = chant avant (côté enfant)",
                            assembly="Posé sur les piètements, fixé par tasseaux vissés par-dessous.",
                            notes=[f"Angles extérieurs arrondis R{fmt(rc.value)}"
                                   + (" (à confirmer)" if rc.source == A_CONFIRMER else "")]))

        # --- Piètements ------------------------------------------------------------
        leg_feats = []
        pocket_w = calc(ht.value + D.value, f"haut.traverse + Ø fraise = {fmt(ht.value)} + {fmt(D.value)}", ht, D)
        pocket_x = calc(zt.value - D.value / 2, "pos.traverse − Ø/2", zt, D)
        slot = calc(e.value + jw.value, f"ép + jeu = {fmt(e.value)} + {fmt(jw.value)}", e, jw)
        pocket_y = calc((Wp.value - slot.value) / 2, "centrée", Wp, slot)
        leg_feats.append(Feature(POCHE, "Embrèvement traverse (arrêté)", pocket_x, pocket_y, w=pocket_w, h=slot,
                                 depth=dp, corner_r=D.value / 2,
                                 note="Longueur augmentée du Ø fraise pour dégager les angles de la traverse"))
        yc = Dim(Wp.value / 2, worst_source(Wp), "axe du piètement")
        for k, frac in enumerate((0.3, 0.7), 1):
            leg_feats.append(Feature(PERCAGE, f"Confirmat traverse {k}",
                                     calc(zt.value + ht.value * frac, f"pos.traverse + {frac}×haut.traverse", zt, ht),
                                     yc, diameter=dtr, through=True))
        if _ouv(params):
            lo, ho, bo, ro = (pdim(params, k) for k in ("largeur_ouverture", "hauteur_ouverture",
                                                       "bas_ouverture", "rayon_ouverture"))
            if ro.value < D.value / 2:
                d.warn(f"Rayon d'ouverture inférieur au rayon de la fraise : porté à R{fmt(D.value / 2)}.")
            oy = calc((Wp.value - lo.value) / 2, "centrée", Wp, lo)
            if oy.value < 40:
                d.block("Ouverture trop large : il reste moins de 40 mm de montant de chaque côté.")
            overlap = not (bo.value + ho.value + 20 <= pocket_x.value or bo.value >= pocket_x.value
                           + pocket_w.value + 20)
            if overlap:
                d.block("L'ouverture chevauche l'embrèvement de la traverse (garder 20 mm).")
            if bo.value < 40 or bo.value + ho.value > Hp.value - 40:
                d.block("Ouverture trop proche du sol ou du plateau (40 mm minimum).")
            leg_feats.append(Feature(OUVERTURE, "Ouverture décorative", bo, oy, w=ho, h=lo, through=True,
                                     corner_r=max(ro.value, D.value / 2)))
        d.parts.append(Part("", "Piètement", 2 * qty, material_id=mat_id, material_name=mat["nom"], thickness=e,
                            length=Hp, width=Wp, grain_x=grain, rotation_allowed=not grain, features=leg_feats,
                            face="Face intérieure vers le haut", orientation="X = hauteur (sol à X=0)",
                            assembly=f"Face usinée vers l'intérieur, à {fmt(deb.value)} mm du bout du plateau."))

        # --- Traverse --------------------------------------------------------------
        Lt = calc(between + 2 * dp.value - 2 * jl.value,
                  f"écart piètements + 2×emb − 2×jeu = {fmt(between)} + 2×{fmt(dp.value)} − 2×{fmt(jl.value)}",
                  L, deb, e, dp, jl)
        d.parts.append(Part("", "Traverse", qty, material_id=mat_id, material_name=mat["nom"], thickness=e,
                            length=Lt, width=ht, grain_x=grain, rotation_allowed=not grain, face="Indifférente",
                            orientation="X = longueur de la table",
                            assembly="Emboîtée dans les embrèvements des piètements, collée et vissée (confirmat)."))

        # --- Compléments -------------------------------------------------------------
        d.extras += [
            Extra("element", f"Tasseau de fixation du plateau 20×20, longueur {fmt(Wp.value - 40)} mm",
                  2 * qty, "u", A_CONFIRMER, "Bois massif, collé-vissé en haut de chaque piètement — proposition"),
            Extra("quincaillerie", "Vis 4×30 (tasseaux → plateau et piètements)", 8 * qty, "u", A_CONFIRMER),
            Extra("quincaillerie", "Vis confirmat 7×50 (traverse)", 4 * qty, "u", CALCULE),
            Extra("operation", "Perçage en bout de traverse Ø5 × 45 mm", 4 * qty, "trou", CALCULE,
                  "Hors CNC : gabarit de perçage"),
            Extra("quincaillerie", "Patins de protection sous piètements", 4 * qty, "u", A_CONFIRMER),
            Extra("securite", "Arrondir et poncer toutes les arêtes accessibles (R3 proposé)", qty, "table",
                  A_CONFIRMER, "Mobilier enfant"),
            Extra("operation", "Finition adaptée au mobilier enfant (à confirmer)", qty, "table", A_CONFIRMER),
        ]
        d.elevation = {
            "title": f"Vue de face — {self.name}", "width": L.value, "height": H.value, "depth": P.value,
            "rects": [
                {"name": "Plateau", "x": 0, "y": Hp.value, "w": L.value, "h": e.value},
                {"name": "Piètement", "x": deb.value, "y": 0, "w": e.value, "h": Hp.value},
                {"name": "Piètement", "x": L.value - deb.value - e.value, "y": 0, "w": e.value, "h": Hp.value},
                {"name": "Traverse", "x": deb.value + e.value, "y": zt.value, "w": between, "h": ht.value},
            ],
        }
        d.number_parts()
        return d
