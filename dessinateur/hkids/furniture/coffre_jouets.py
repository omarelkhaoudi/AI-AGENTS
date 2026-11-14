"""Coffre à jouets : deux faces, deux côtés à poignées découpées, fond en
rainure ou sur tasseaux, couvercle facultatif.

Repère des faces et des côtés : X = longueur de la pièce, Y = hauteur
(Y = 0 en bas), face intérieure usinée vers le haut. Les côtés s'insèrent
entre les faces.
"""
from __future__ import annotations

import math

from ..model import OUVERTURE, PERCAGE, RAINURE, Extra, Feature, Part
from ..profile import material, rule, thickness, tool
from ..provenance import A_CONFIRMER, CALCULE, Dim, calc, fmt, worst_source
from . import Design, FurnitureModel, ParamDef, pdim, pval


def _poignees(p):
    return pval(p, "poignees") == "decoupees"


def _couvercle(p):
    return pval(p, "couvercle") == "pose"


def _rainure(p):
    return pval(p, "fond") == "rainure"


class CoffreJouets(FurnitureModel):
    id = "coffre_jouets"
    name = "Coffre à jouets"
    description = ("Caisse à deux faces et deux côtés (embrèvement ou confirmat), fond en rainure ou sur "
                   "tasseaux, poignées découpées et couvercle facultatifs.")
    params = [
        ParamDef("longueur", "Longueur hors tout de la caisse", "mm", group="dimensions",
                 group_title="Dimensions", min=300, max=1600),
        ParamDef("profondeur", "Profondeur hors tout de la caisse", "mm", group="dimensions", min=250, max=900),
        ParamDef("hauteur", "Hauteur de la caisse (sans couvercle)", "mm", group="dimensions", min=150, max=800),
        ParamDef("quantite", "Nombre de coffres identiques", "int", group="dimensions", min=1, max=50, proposal=1),
        ParamDef("materiau", "Matière de la caisse", "material", group="construction",
                 group_title="Matière et construction"),
        ParamDef("assemblage", "Assemblage des angles", "choice", group="construction",
                 choices=[["embrevement", "Embrèvement (feuillures CNC + colle)"],
                          ["confirmat", "Vis confirmat (perçages)"]]),
        ParamDef("fond", "Fond", "choice", group="fond", group_title="Fond",
                 choices=[["rainure", "Fond en rainure"], ["tasseaux", "Fond posé sur tasseaux"]]),
        ParamDef("materiau_fond", "Matière du fond", "material", group="fond"),
        ParamDef("hauteur_rainure_fond", "Hauteur du bas de la rainure de fond depuis le bas", "mm", group="fond",
                 proposal=10, min=5, max=100, when=_rainure),
        ParamDef("poignees", "Poignées", "choice", group="poignees", group_title="Poignées",
                 choices=[["aucune", "Aucune"], ["decoupees", "Découpées dans les côtés"]]),
        ParamDef("largeur_poignee", "Largeur de la découpe de poignée", "mm", group="poignees", proposal=120,
                 min=60, max=300, when=_poignees),
        ParamDef("hauteur_poignee", "Hauteur de la découpe de poignée", "mm", group="poignees", proposal=30,
                 min=20, max=60, when=_poignees),
        ParamDef("bord_poignee", "Distance poignée / bord supérieur du côté", "mm", group="poignees",
                 proposal=40, min=20, max=200, when=_poignees),
        ParamDef("couvercle", "Couvercle", "choice", group="couvercle", group_title="Couvercle et finition",
                 choices=[["aucun", "Sans couvercle (bac ouvert)"], ["pose", "Couvercle sur charnières"]]),
        ParamDef("debord_couvercle", "Débord du couvercle sur chaque côté", "mm", group="couvercle", proposal=10,
                 min=0, max=60, when=_couvercle),
        ParamDef("rayon_couvercle", "Rayon des angles du couvercle", "mm", group="couvercle", proposal=15, min=0,
                 max=100, when=_couvercle),
        ParamDef("finition", "Finition des arêtes", "choice", group="couvercle",
                 choices=[["arrondi", "Arêtes arrondies et poncées"], ["aucune", "Arêtes vives poncées"]]),
    ]

    def build(self, params: dict, profile: dict) -> Design:
        d = Design()
        L, P, H = pdim(params, "longueur"), pdim(params, "profondeur"), pdim(params, "hauteur")
        qty = int(pval(params, "quantite"))
        mat_id = pval(params, "materiau")
        mat = material(profile, mat_id)
        d.used_materials.add(mat_id)
        e = thickness(profile, mat_id)
        grain = bool(mat["fil"])
        assemblage = pval(params, "assemblage")
        fond = pval(params, "fond")
        fmat_id = pval(params, "materiau_fond")
        fmat = material(profile, fmat_id)
        d.used_materials.add(fmat_id)
        ef = thickness(profile, fmat_id)
        t_cont = tool(profile, profile["usinage"]["outil_contour"])
        D = Dim(float(t_cont["diametre"]), "fourni" if t_cont.get("confirme") else A_CONFIRMER, "Ø fraise")

        if P.value <= 4 * e.value + 50 or L.value <= 4 * e.value + 50:
            d.block("Caisse trop petite pour l'épaisseur de la matière.")
            return d

        # --- Longueur des côtés (entre les faces) -------------------------
        Pi = calc(P.value - 2 * e.value, f"P − 2×ép = {fmt(P.value)} − 2×{fmt(e.value)}", P, e)
        Li = calc(L.value - 2 * e.value, f"L − 2×ép = {fmt(L.value)} − 2×{fmt(e.value)}", L, e)
        if assemblage == "embrevement":
            d.used_rules.add("embrevement")
            dp = rule(profile, "embrevement", "profondeur")
            jw = rule(profile, "embrevement", "jeu_largeur")
            jl = rule(profile, "embrevement", "jeu_longueur")
            if dp.value >= e.value / 2:
                d.block("Profondeur d'embrèvement supérieure à la moitié de l'épaisseur.")
            Lc = calc(Pi.value + 2 * dp.value - 2 * jl.value,
                      f"P.int + 2×emb − 2×jeu = {fmt(Pi.value)} + 2×{fmt(dp.value)} − 2×{fmt(jl.value)}",
                      Pi, dp, jl)
        else:
            d.used_rules.add("confirmat")
            Lc = Dim(Pi.value, Pi.source, Pi.formule)

        # --- Rainure de fond (sur les 4 panneaux) --------------------------
        def fond_groove(length: Dim) -> list[Feature]:
            if fond != "rainure":
                return []
            return [Feature(RAINURE, "Rainure de fond", Dim(0, CALCULE), hr,
                            w=Dim(length.value, length.source), h=slot, depth=df, note="Traversante")]

        if fond == "rainure":
            d.used_rules.add("rainure_fond")
            df = rule(profile, "rainure_fond", "profondeur")
            jf = rule(profile, "rainure_fond", "jeu_largeur")
            jfd = rule(profile, "rainure_fond", "jeu_fond")
            hr = pdim(params, "hauteur_rainure_fond")
            slot = calc(ef.value + jf.value, f"ép.fond + jeu = {fmt(ef.value)} + {fmt(jf.value)}", ef, jf)
            if df.value >= e.value / 2:
                d.block("Rainure de fond plus profonde que la moitié de l'épaisseur.")

        # --- Faces avant / arrière -----------------------------------------
        face_feats = []
        if assemblage == "embrevement":
            w_end = calc(e.value + jw.value / 2, f"ép + jeu/2 = {fmt(e.value)} + {fmt(jw.value / 2)}", e, jw)
            face_feats.append(Feature(RAINURE, "Feuillure côté gauche", Dim(0, CALCULE), Dim(0, CALCULE),
                                      w=w_end, h=Dim(H.value, H.source), depth=dp,
                                      note="Feuillure en bout, sur toute la hauteur"))
            face_feats.append(Feature(RAINURE, "Feuillure côté droit",
                                      calc(L.value - w_end.value, "L − (ép + jeu/2)", L, w_end), Dim(0, CALCULE),
                                      w=w_end, h=Dim(H.value, H.source), depth=dp,
                                      note="Feuillure en bout, sur toute la hauteur"))
        else:
            ent = rule(profile, "confirmat", "entraxe_bord")
            emax = rule(profile, "confirmat", "entraxe_max")
            dtr = rule(profile, "confirmat", "d_traversant")
            ys = _positions(H.value, ent.value, emax.value)
            for side, x in (("gauche", e.value / 2), ("droit", L.value - e.value / 2)):
                for y in ys:
                    face_feats.append(Feature(
                        PERCAGE, f"Confirmat côté {side}",
                        calc(x, "ép/2" if side == "gauche" else "L − ép/2", e, L),
                        Dim(y, worst_source(ent, emax, H), "répartition confirmat"), diameter=dtr, through=True))
        face_feats += fond_groove(L)
        d.parts.append(Part("", "Face avant / arrière", 2 * qty, material_id=mat_id, material_name=mat["nom"],
                            thickness=e, length=L, width=H, grain_x=grain, rotation_allowed=not grain,
                            features=face_feats, face="Face intérieure vers le haut",
                            orientation="X = longueur du coffre, Y = 0 en bas",
                            assembly="Avant et arrière identiques, face usinée vers l'intérieur."))

        # --- Côtés -------------------------------------------------------------
        side_feats = fond_groove(Lc)
        if _poignees(params):
            lp, hp, bp = (pdim(params, k) for k in ("largeur_poignee", "hauteur_poignee", "bord_poignee"))
            px = calc((Lc.value - lp.value) / 2, "centrée", Lc, lp)
            py = calc(H.value - bp.value - hp.value, "H − bord − haut.poignée", H, bp, hp)
            low = (hr.value + slot.value + 30) if fond == "rainure" else 60
            if py.value < low:
                d.block("Poignée trop basse : elle rejoint la zone du fond.")
            if px.value < 40:
                d.block("Poignée trop large pour le côté (moins de 40 mm de chaque côté).")
            if hp.value < D.value:
                d.block(f"Poignée moins haute que le Ø de la fraise ({fmt(D.value)} mm).")
            side_feats.append(Feature(OUVERTURE, "Poignée découpée", px, py, w=lp, h=hp, through=True,
                                      corner_r=max(hp.value / 2, D.value / 2),
                                      note="Découpe oblongue, arêtes à arrondir (mains d'enfant)"))
        d.parts.append(Part("", "Côté", 2 * qty, material_id=mat_id, material_name=mat["nom"], thickness=e,
                            length=Lc, width=H, grain_x=grain, rotation_allowed=not grain, features=side_feats,
                            face="Face intérieure vers le haut", orientation="X = profondeur du coffre, Y = 0 en bas",
                            assembly=("Emboîté dans les feuillures des faces, collé." if assemblage == "embrevement"
                                      else "Vissé par confirmat au travers des faces (perçages en bout hors CNC).")))

        # --- Fond ----------------------------------------------------------------
        if fond == "rainure":
            fl = calc(Li.value + 2 * (df.value - jfd.value),
                      f"L.int + 2×(prof.rainure − jeu) = {fmt(Li.value)} + 2×({fmt(df.value)} − {fmt(jfd.value)})",
                      Li, df, jfd)
            fw = calc(Pi.value + 2 * (df.value - jfd.value),
                      f"P.int + 2×(prof.rainure − jeu) = {fmt(Pi.value)} + 2×({fmt(df.value)} − {fmt(jfd.value)})",
                      Pi, df, jfd)
            assy = "Glissé dans les rainures avant de fermer la caisse. Ne pas coller."
        else:
            d.used_rules.add("embrevement")
            jl2 = rule(profile, "embrevement", "jeu_longueur")
            fl = calc(Li.value - 2 * jl2.value, f"L.int − 2×jeu = {fmt(Li.value)} − 2×{fmt(jl2.value)}", Li, jl2)
            fw = calc(Pi.value - 2 * jl2.value, f"P.int − 2×jeu = {fmt(Pi.value)} − 2×{fmt(jl2.value)}", Pi, jl2)
            assy = "Posé sur les tasseaux, collé-vissé par-dessous."
            d.extras.append(Extra("element", "Tasseau de fond 20×20 (bois massif)", 4 * qty, "u", A_CONFIRMER,
                                  f"2 × {fmt(Li.value)} mm + 2 × {fmt(Pi.value - 40)} mm, collés-vissés en bas "
                                  "à l'intérieur — proposition"))
        if ef.value < 5:
            d.warn("Fond de moins de 5 mm : vérifier la solidité (un enfant peut monter dans le coffre).")
        d.parts.append(Part("", "Fond", qty, material_id=fmat_id, material_name=fmat["nom"], thickness=ef,
                            length=fl, width=fw, grain_x=bool(fmat["fil"]), rotation_allowed=not fmat["fil"],
                            face="Indifférente", orientation="X = longueur du coffre", assembly=assy))

        # --- Couvercle ---------------------------------------------------------
        if _couvercle(params):
            deb, rc = pdim(params, "debord_couvercle"), pdim(params, "rayon_couvercle")
            cl = calc(L.value + 2 * deb.value, f"L + 2×débord = {fmt(L.value)} + 2×{fmt(deb.value)}", L, deb)
            cw = calc(P.value + 2 * deb.value, f"P + 2×débord = {fmt(P.value)} + 2×{fmt(deb.value)}", P, deb)
            d.parts.append(Part("", "Couvercle", qty, material_id=mat_id, material_name=mat["nom"], thickness=e,
                                length=cl, width=cw, grain_x=grain, rotation_allowed=not grain, corner_r=rc.value,
                                face="Face supérieure vers le haut", orientation="X = longueur du coffre",
                                assembly="Fixé sur la face arrière par charnières ; retenu par un compas de sécurité.",
                                notes=[f"Angles arrondis R{fmt(rc.value)}"]))
            n_ch = 3 if L.value > 900 else 2
            d.extras += [
                Extra("quincaillerie", "Charnière de coffre (acier, vis fournies)", n_ch * qty, "u", A_CONFIRMER,
                      "Nombre proposé selon la longueur — modèle à choisir"),
                Extra("securite", "Compas / support de couvercle à retenue (anti-chute, anti-pincement)", 2 * qty,
                      "u", A_CONFIRMER, "Indispensable sur un coffre à jouets : le couvercle doit rester ouvert "
                                        "en toute position et ne jamais retomber"),
                Extra("securite", "Aération : jeu sous le couvercle ou trous d'aération", qty, "coffre", A_CONFIRMER,
                      "Un enfant ne doit jamais pouvoir s'enfermer sans air — solution à valider"),
            ]
        # --- Compléments ---------------------------------------------------------
        if assemblage == "confirmat":
            n = sum(1 for f in face_feats if f.kind == PERCAGE)
            d.extras += [
                Extra("quincaillerie", "Vis confirmat 7×50", 2 * n * qty, "u", CALCULE),
                Extra("operation", "Perçage en bout des côtés Ø5 × 45 mm", 2 * n * qty, "trou", CALCULE,
                      "Hors CNC : gabarit de perçage"),
                Extra("operation", "Fraisage des têtes confirmat (face extérieure des faces)", 2 * n * qty, "trou",
                      CALCULE, "Hors CNC : fraisoir à main"),
            ]
        else:
            d.extras.append(Extra("quincaillerie", "Colle vinylique D3", "selon besoin", "", CALCULE))
        d.extras.append(Extra("quincaillerie", "Patins de protection sous la caisse", 4 * qty, "u", A_CONFIRMER))
        if pval(params, "finition") == "arrondi":
            d.extras.append(Extra("operation", "Arrondi R3 et ponçage de toutes les arêtes et des poignées", qty,
                                  "coffre", A_CONFIRMER, "Défonceuse à main — rayon à confirmer"))
        d.extras.append(Extra("operation", "Finition adaptée au mobilier enfant (à confirmer)", qty, "coffre",
                              A_CONFIRMER))

        # --- Vue de face -------------------------------------------------------
        rects = [{"name": "Face avant / arrière", "x": 0, "y": 0, "w": L.value, "h": H.value}]
        if fond == "rainure":
            rects.append({"name": "Fond", "x": e.value, "y": hr.value, "w": Li.value, "h": ef.value, "dashed": True})
        else:
            rects.append({"name": "Fond", "x": e.value, "y": 20, "w": Li.value, "h": ef.value, "dashed": True})
        height = H.value
        if _couvercle(params):
            rects.append({"name": "Couvercle", "x": -deb.value, "y": H.value, "w": L.value + 2 * deb.value,
                          "h": e.value})
            height += e.value
        d.elevation = {"title": f"Vue de face — {self.name}", "width": L.value, "height": height, "depth": P.value,
                       "rects": rects}
        d.number_parts()
        return d


def _positions(height: float, edge: float, max_pitch: float) -> list[float]:
    if height <= 2 * edge:
        return [height / 2]
    span = height - 2 * edge
    k = max(1, math.ceil(span / max_pitch))
    return [edge + i * span / k for i in range(k + 1)]
