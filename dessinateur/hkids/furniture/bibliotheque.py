"""Bibliothèque / étagère à caisson (meuble pilote recommandé par Hiba)."""
from __future__ import annotations

import math

from ..model import PERCAGE, RAINURE, Extra, Feature, Part
from ..profile import material, rule, thickness
from ..provenance import A_CONFIRMER, CALCULE, FOURNI, Dim, calc, fmt, worst_source
from . import Design, FurnitureModel, ParamDef, pdim, psrc, pval

CHANTS = [["aucun", "Aucun chant"], ["pvc1", "Chant PVC 1 mm"], ["pvc2", "Chant PVC 2 mm"],
          ["arrondi", "Sans chant — arêtes arrondies et poncées"]]
CHANT_EP = {"aucun": 0.0, "pvc1": 1.0, "pvc2": 2.0, "arrondi": 0.0}


def _fond(p):
    return pval(p, "fond") in ("rainure", "applique")


class Bibliotheque(FurnitureModel):
    id = "bibliotheque"
    name = "Bibliothèque à caisson"
    description = ("Deux côtés, dessus, dessous, tablettes fixes, fond optionnel et socle optionnel. "
                   "Assemblage par embrèvement (rainures CNC) ou vis confirmat.")
    params = [
        ParamDef("largeur", "Largeur hors tout", "mm", group="dimensions", group_title="Dimensions du meuble",
                 min=200, max=2400),
        ParamDef("hauteur", "Hauteur hors tout", "mm", group="dimensions", min=200, max=2400),
        ParamDef("profondeur", "Profondeur hors tout", "mm", group="dimensions", min=120, max=800),
        ParamDef("quantite", "Nombre de meubles identiques", "int", group="dimensions", min=1, max=50,
                 proposal=1),
        ParamDef("nb_tablettes", "Nombre de tablettes fixes (hors dessus et dessous)", "int",
                 group="tablettes", group_title="Tablettes", min=0, max=12),
        ParamDef("repartition", "Répartition des tablettes", "choice", group="tablettes",
                 choices=[["egale", "Espaces égaux"], ["personnalisee", "Hauteurs imposées"]],
                 when=lambda p: (pval(p, "nb_tablettes") or 0) > 0),
        ParamDef("positions_tablettes", "Hauteur du dessous de chaque tablette depuis le sol", "list_mm",
                 group="tablettes", help="Une valeur par tablette, séparées par des virgules, ex. 380, 720",
                 when=lambda p: (pval(p, "nb_tablettes") or 0) > 0 and pval(p, "repartition") == "personnalisee"),
        ParamDef("nb_tablettes_reglables", "Nombre de tablettes réglables (posées sur taquets)", "int",
                 group="tablettes", min=0, max=12, proposal=0,
                 help="0 = aucune. Les côtés reçoivent alors des rangées de trous de taquets au pas de 32 mm."),
        ParamDef("materiau_caisson", "Matière du caisson", "material", group="construction",
                 group_title="Matière et construction"),
        ParamDef("assemblage", "Assemblage dessus / dessous / tablettes", "choice", group="construction",
                 choices=[["embrevement", "Embrèvement (rainures CNC + colle)"],
                          ["confirmat", "Vis confirmat (perçages)"]]),
        ParamDef("rainures", "Rainures des côtés", "choice", group="construction", proposal="traversantes",
                 choices=[["traversantes", "Traversantes (visibles sur le chant avant)"],
                          ["arretees", "Arrêtées à l'avant — panneaux horizontaux en retrait"]],
                 when=lambda p: pval(p, "assemblage") == "embrevement"),
        ParamDef("fond", "Fond", "choice", group="construction",
                 choices=[["rainure", "Fond en rainure"], ["applique", "Fond vissé en applique"],
                          ["aucun", "Sans fond"]]),
        ParamDef("materiau_fond", "Matière du fond", "material", group="construction", when=_fond),
        ParamDef("hauteur_socle", "Hauteur du socle (0 = pas de socle)", "mm", group="socle",
                 group_title="Socle et finition", min=0, max=300),
        ParamDef("retrait_socle", "Retrait de la plinthe depuis l'avant", "mm", group="socle", proposal=20,
                 min=0, max=200, when=lambda p: (pval(p, "hauteur_socle") or 0) > 0),
        ParamDef("chant_avant", "Finition des chants avant", "choice", group="socle", choices=CHANTS),
    ]

    def build(self, params: dict, profile: dict) -> Design:
        d = Design()
        L, H, P = pdim(params, "largeur"), pdim(params, "hauteur"), pdim(params, "profondeur")
        qty = int(pval(params, "quantite"))
        n = int(pval(params, "nb_tablettes"))
        mat_id = pval(params, "materiau_caisson")
        mat = material(profile, mat_id)
        e = thickness(profile, mat_id)
        e.formule = e.formule or f"épaisseur réelle {mat['nom']}"
        d.used_materials.add(mat_id)
        assemblage = pval(params, "assemblage")
        fond = pval(params, "fond")
        hs = pdim(params, "hauteur_socle")
        chant = pval(params, "chant_avant")
        tc = Dim(CHANT_EP[chant], psrc(params, "chant_avant"))
        grain = bool(mat["fil"])
        qsrc = psrc(params, "quantite")

        # --- Fond -------------------------------------------------------
        ef = df = ro = jf = jfd = None
        if fond in ("rainure", "applique"):
            fmat_id = pval(params, "materiau_fond")
            fmat = material(profile, fmat_id)
            ef = thickness(profile, fmat_id)
            d.used_materials.add(fmat_id)
        if fond == "rainure":
            d.used_rules.add("rainure_fond")
            df = rule(profile, "rainure_fond", "profondeur")
            ro = rule(profile, "rainure_fond", "retrait_arriere")
            jf = rule(profile, "rainure_fond", "jeu_largeur")
            jfd = rule(profile, "rainure_fond", "jeu_fond")
        if fond == "applique":
            d.used_rules.add("vis_fond")

        # Profondeur du caisson (le fond en applique s'ajoute derrière)
        if fond == "applique":
            Pc = calc(P.value - ef.value, f"P − ép.fond = {fmt(P.value)} − {fmt(ef.value)}", P, ef)
        else:
            Pc = P
        Wside = calc(Pc.value - tc.value, f"prof. caisson − chant = {fmt(Pc.value)} − {fmt(tc.value)}", Pc, tc) \
            if tc.value else Pc

        # --- Hauteurs des panneaux horizontaux (dessous de chaque panneau) ---
        if hs.value + 2 * e.value >= H.value:
            d.block("Hauteur insuffisante : socle + dessus + dessous dépassent la hauteur totale.")
            return d
        Hi = calc(H.value - hs.value - 2 * e.value,
                  f"H − socle − 2×ép = {fmt(H.value)} − {fmt(hs.value)} − 2×{fmt(e.value)}", H, hs, e)
        levels = [("Dessous", hs)]  # (nom, cote du dessous du panneau depuis le sol)
        if n:
            if pval(params, "repartition") == "egale":
                s = (Hi.value - n * e.value) / (n + 1)
                if s < 50:
                    d.block(f"Espace entre tablettes trop faible ({fmt(s)} mm).")
                s_dim = calc(s, f"(H.int − {n}×ép) / {n + 1} = ({fmt(Hi.value)} − {n}×{fmt(e.value)}) / {n + 1}",
                             Hi, e)
                for k in range(1, n + 1):
                    z = hs.value + e.value + k * s + (k - 1) * e.value
                    levels.append((f"Tablette {k}", calc(z, f"socle + ép + {k}×espace + {k - 1}×ép", hs, e, s_dim)))
                d.elevation["espace_tablettes"] = s_dim.to_dict()
            else:
                pos = pval(params, "positions_tablettes") or []
                if len(pos) != n:
                    d.block(f"{len(pos)} hauteur(s) de tablette fournie(s) pour {n} tablette(s).")
                    return d
                src = psrc(params, "positions_tablettes")
                prev_top = hs.value + e.value
                for k, z in enumerate(sorted(float(v) for v in pos), 1):
                    if z < prev_top + 30:
                        d.block(f"Tablette {k} à {fmt(z)} mm : trop proche du panneau inférieur.")
                    prev_top = z + e.value
                    levels.append((f"Tablette {k}", Dim(z, src)))
                if prev_top > H.value - e.value - 30:
                    d.block("Dernière tablette trop proche du dessus.")
        z_top = calc(H.value - e.value, f"H − ép = {fmt(H.value)} − {fmt(e.value)}", H, e)
        levels.append(("Dessus", z_top))

        # --- Longueur des panneaux horizontaux ------------------------------
        Li = calc(L.value - 2 * e.value, f"L − 2×ép = {fmt(L.value)} − 2×{fmt(e.value)}", L, e)
        if assemblage == "embrevement":
            d.used_rules.add("embrevement")
            dp = rule(profile, "embrevement", "profondeur")
            jw = rule(profile, "embrevement", "jeu_largeur")
            jl = rule(profile, "embrevement", "jeu_longueur")
            if dp.value >= e.value / 2:
                d.block("Profondeur d'embrèvement supérieure à la moitié de l'épaisseur.")
            Lh = calc(Li.value + 2 * dp.value - 2 * jl.value,
                      f"L.int + 2×emb − 2×jeu = {fmt(Li.value)} + 2×{fmt(dp.value)} − 2×{fmt(jl.value)}",
                      Li, dp, jl)
        else:
            d.used_rules.add("confirmat")
            Lh = Dim(Li.value, Li.source, Li.formule)

        # Largeur des panneaux horizontaux
        Wh = Wside
        if fond == "rainure":
            back_slot = ef.value + jf.value
            Wt = calc(Wside.value - ro.value - back_slot,
                      f"larg.côté − retrait − (ép.fond + jeu) = {fmt(Wside.value)} − {fmt(ro.value)} − "
                      f"({fmt(ef.value)} + {fmt(jf.value)})", Wside, ro, ef, jf)
        else:
            Wt = Wh

        # Rainures arrêtées : elles s'arrêtent avant le chant avant ; les panneaux horizontaux sont en
        # retrait de l'arrêt + le rayon de la plus grosse fraise capable d'usiner la rainure.
        stopped = assemblage == "embrevement" and pval(params, "rainures") == "arretees"
        ra = Dim(0.0, CALCULE)
        if stopped:
            d.used_rules.add("rainure_arretee")
            arr = rule(profile, "rainure_arretee", "arret_avant")
            fits = [t for t in profile["outils"] if t["diametre"] <= e.value + jw.value + 1e-6]
            if not fits:
                d.block("Aucune fraise ne peut usiner la rainure arrêtée.")
                return d
            big = max(fits, key=lambda t: t["diametre"])
            rf = Dim(big["diametre"] / 2, FOURNI if all(t.get("confirme") for t in fits) else A_CONFIRMER,
                     f"rayon de la fraise {big['id']}")
            ra = calc(arr.value + rf.value, f"arrêt + rayon fraise = {fmt(arr.value)} + {fmt(rf.value)}", arr, rf)
            Wh = calc(Wh.value - ra.value, f"larg.côté − retrait avant = {fmt(Wh.value)} − {fmt(ra.value)}", Wh, ra)
            Wt = calc(Wt.value - ra.value, f"larg.tablette − retrait avant = {fmt(Wt.value)} − {fmt(ra.value)}",
                      Wt, ra)

        # --- Côtés --------------------------------------------------------------
        side_feats = []
        if assemblage == "embrevement":
            for name, z in levels:
                x0 = max(0.0, z.value - jw.value / 2)
                x1 = min(H.value, z.value + e.value + jw.value / 2)
                src = worst_source(z, e, jw)
                side_feats.append(Feature(
                    RAINURE, f"Embrèvement {name.lower()}",
                    Dim(x0, src, f"cote {name.lower()} − jeu/2"),
                    Dim(arr.value, arr.source, "arrêt avant") if stopped else Dim(0, CALCULE),
                    w=Dim(x1 - x0, src, f"ép + jeu = {fmt(e.value)} + {fmt(jw.value)}"
                          if 0 < x0 and x1 < H.value else "feuillure en bout"),
                    h=calc(Wside.value - arr.value, "larg.côté − arrêt", Wside, arr) if stopped
                    else Dim(Wside.value, Wside.source), depth=dp,
                    note=(f"Rainure arrêtée à {fmt(arr.value)} mm du chant avant, débouchant à l'arrière"
                          if stopped else "Rainure traversante (débouche sur le chant avant)")))
        else:
            ent = rule(profile, "confirmat", "entraxe_bord")
            emax = rule(profile, "confirmat", "entraxe_max")
            dtr = rule(profile, "confirmat", "d_traversant")
            for name, z in levels:
                x = z.value + e.value / 2
                w_level = Wt if name.startswith("Tablette") else Wh
                for y in _hole_positions(w_level.value, ent.value, emax.value):
                    side_feats.append(Feature(
                        PERCAGE, f"Confirmat {name.lower()}", calc(x, f"cote {name.lower()} + ép/2", z, e),
                        Dim(y, worst_source(ent, emax, Wh), "répartition confirmat"),
                        diameter=dtr, through=True))
        if fond == "rainure":
            gy0 = Wside.value - ro.value - (ef.value + jf.value)
            src = worst_source(Wside, ro, ef, jf)
            side_feats.append(Feature(
                RAINURE, "Rainure de fond", Dim(0, CALCULE), Dim(gy0, src, "larg − retrait − (ép.fond + jeu)"),
                w=Dim(H.value, H.source), h=Dim(ef.value + jf.value, worst_source(ef, jf), "ép.fond + jeu"),
                depth=df, note="Traversante sur toute la hauteur"))

        # --- Tablettes réglables : rangées de trous de taquets ---------------------
        nr = int(pval(params, "nb_tablettes_reglables") or 0)
        if nr:
            d.used_rules.add("taquets")
            tq = {k: rule(profile, "taquets", k) for k in ("diametre", "profondeur", "pas", "retrait_avant",
                                                          "retrait_arriere", "marge", "jeu_longueur",
                                                          "jeu_largeur")}
            if tq["profondeur"].value > e.value - 4:
                d.block("Trous de taquets trop profonds pour l'épaisseur des côtés (4 mm de matière minimum).")
            Wr = calc(Wt.value - tq["jeu_largeur"].value,
                      f"larg.tablette − jeu = {fmt(Wt.value)} − {fmt(tq['jeu_largeur'].value)}", Wt, tq["jeu_largeur"])
            Lr = calc(Li.value - 2 * tq["jeu_longueur"].value,
                      f"L.int − 2×jeu = {fmt(Li.value)} − 2×{fmt(tq['jeu_longueur'].value)}", Li, tq["jeu_longueur"])
            yf = ra.value + tq["retrait_avant"].value
            yb = ra.value + Wr.value - tq["retrait_arriere"].value
            if yb - yf < 50:
                d.block("Tablettes réglables trop peu profondes pour deux rangées de taquets.")
            m, pas = tq["marge"].value, tq["pas"].value
            fixed = [(z.value, z.value + e.value) for _, z in levels[1:-1]]
            zs, z = [], hs.value + e.value + m
            while z <= H.value - e.value - m + 1e-6:
                if all(not (lo - m < z < hi + m) for lo, hi in fixed):
                    zs.append(z)
                z += pas
            if not zs:
                d.block("Aucune place pour des trous de taquets (compartiments trop bas).")
            src = worst_source(*tq.values(), hs, e, Wr)
            for z in zs:
                for y in (yf, yb):
                    side_feats.append(Feature(PERCAGE, "Trou de taquet", Dim(z, src, f"pas de {fmt(pas)} mm"),
                                              Dim(y, src, "retrait de la rangée"), diameter=tq["diametre"],
                                              depth=tq["profondeur"]))
            d.extras.append(Extra("quincaillerie", f"Taquet de tablette Ø{fmt(tq['diametre'].value)}",
                                  4 * nr * qty, "u", src, f"4 par tablette réglable · {len(zs)} positions possibles"))

        side_common = dict(material_id=mat_id, material_name=mat["nom"], thickness=e, length=H, width=Wside,
                           grain_x=grain, rotation_allowed=not grain)
        edge_front = _edges_h(chant)
        d.parts.append(Part("", "Côté gauche", qty, features=side_feats,
                            face="Face intérieure vers le haut",
                            orientation="X = hauteur (bas du meuble à X=0), Y=0 = chant avant",
                            assembly="Monté à gauche, face usinée vers l'intérieur du meuble.",
                            edges=edge_front, **side_common))
        right_feats = [_mirror_y(f, Wside.value) for f in side_feats]
        d.parts.append(Part("", "Côté droit", qty, features=right_feats, face="Face intérieure vers le haut",
                            orientation="X = hauteur (bas du meuble à X=0), Y=0 = chant arrière",
                            assembly="Symétrique du côté gauche. Monté à droite, face usinée vers l'intérieur.",
                            edges=[e_.replace("Y=0", f"Y={fmt(Wside.value)}") for e_ in edge_front],
                            mirror_of="Côté gauche", **side_common))

        # --- Panneaux horizontaux ----------------------------------------------
        def back_groove(width: Dim) -> list[Feature]:
            if fond != "rainure":
                return []
            gy0 = width.value - ro.value - (ef.value + jf.value)
            return [Feature(RAINURE, "Rainure de fond", Dim(0, CALCULE),
                            Dim(gy0, worst_source(width, ro, ef, jf), "larg − retrait − (ép.fond + jeu)"),
                            w=Dim(Lh.value, Lh.source), h=Dim(ef.value + jf.value, worst_source(ef, jf)),
                            depth=df, note="Traversante")]

        horiz_common = dict(material_id=mat_id, material_name=mat["nom"], thickness=e, length=Lh,
                            grain_x=grain, rotation_allowed=not grain)
        assy = ("Glissé dans les embrèvements des côtés, collé." if assemblage == "embrevement"
                else "Vissé par confirmat au travers des côtés (perçages en bout hors CNC).")
        if stopped:
            assy += f" En retrait de {fmt(ra.value)} mm du chant avant des côtés (rainures arrêtées)."
        d.parts.append(Part("", "Dessous", qty, width=Wh, features=back_groove(Wh),
                            face="Face supérieure (intérieure) vers le haut", orientation="X = largeur du meuble",
                            assembly=assy, edges=_edges_h(chant), **horiz_common))
        d.parts.append(Part("", "Dessus", qty, width=Wh, features=back_groove(Wh),
                            face="Face inférieure (intérieure) vers le haut", orientation="X = largeur du meuble",
                            assembly=assy, edges=_edges_h(chant), **horiz_common))
        if n:
            d.parts.append(Part("", "Tablette fixe", qty * n, width=Wt, face="Indifférente",
                                orientation="X = largeur du meuble",
                                assembly=assy + (" Chant arrière contre le fond." if fond == "rainure" else ""),
                                edges=_edges_h(chant), **horiz_common))
        if nr:
            d.parts.append(Part("", "Tablette réglable", qty * nr, material_id=mat_id, material_name=mat["nom"],
                                thickness=e, length=Lr, width=Wr, grain_x=grain, rotation_allowed=not grain,
                                face="Indifférente", orientation="X = largeur du meuble",
                                assembly="Posée sur 4 taquets, déplaçable.", edges=_edges_h(chant)))

        # --- Fond ---------------------------------------------------------------
        if fond == "rainure":
            bw = calc(Li.value + 2 * (df.value - jfd.value),
                      f"L.int + 2×(prof.rainure − jeu) = {fmt(Li.value)} + 2×({fmt(df.value)} − {fmt(jfd.value)})",
                      Li, df, jfd)
            bh = calc(Hi.value + 2 * (df.value - jfd.value),
                      f"H.int + 2×(prof.rainure − jeu) = {fmt(Hi.value)} + 2×({fmt(df.value)} − {fmt(jfd.value)})",
                      Hi, df, jfd)
            d.parts.append(Part("", "Fond", qty, material_id=fmat_id, material_name=fmat["nom"], thickness=ef,
                                length=bw, width=bh, grain_x=bool(fmat["fil"]), rotation_allowed=not fmat["fil"],
                                face="Indifférente", orientation="X = largeur du meuble",
                                assembly="Glissé dans les rainures avant collage du dernier côté. Ne pas coller."))
            if ef.value + jf.value < 3.0:
                d.warn("Rainure de fond de moins de 3 mm : vérifier qu'une fraise adaptée existe.")
        elif fond == "applique":
            bh = calc(H.value - hs.value, f"H − socle = {fmt(H.value)} − {fmt(hs.value)}", H, hs)
            d.parts.append(Part("", "Fond", qty, material_id=fmat_id, material_name=fmat["nom"], thickness=ef,
                                length=L, width=bh, grain_x=bool(fmat["fil"]), rotation_allowed=not fmat["fil"],
                                face="Indifférente", orientation="X = largeur du meuble",
                                assembly="Vissé à l'arrière du caisson (vérifier l'équerrage avant vissage)."))
            pas = rule(profile, "vis_fond", "pas")
            perim = 2 * (L.value + bh.value) + (n * L.value)
            d.extras.append(Extra("quincaillerie", "Vis de fond 3×16 (tête plate)",
                                  qty * math.ceil(perim / pas.value), source=worst_source(pas, L, bh),
                                  note=f"Périmètre + tablettes ÷ pas {fmt(pas.value)} mm"))

        # --- Socle --------------------------------------------------------------
        if hs.value > 0:
            rs = pdim(params, "retrait_socle")
            d.parts.append(Part("", "Plinthe", qty, material_id=mat_id, material_name=mat["nom"], thickness=e,
                                length=Li, width=hs, grain_x=grain, rotation_allowed=not grain,
                                face="Indifférente", orientation="X = largeur du meuble",
                                assembly=f"Entre les côtés, en retrait de {fmt(rs.value)} mm depuis l'avant, "
                                         "fixée par tasseaux collés-vissés (voir éléments complémentaires).",
                                notes=["Retrait à confirmer" if rs.source == A_CONFIRMER else ""]))
            d.extras.append(Extra("element", "Tasseau de fixation de plinthe 20×20 (bois massif)", 2 * qty, "u",
                                  A_CONFIRMER, f"Longueur = hauteur du socle ({fmt(hs.value)} mm) — proposition"))
            if hs.value > e.value and assemblage == "confirmat":
                d.warn("Socle : vérifier que le dessous repose bien sur un appui (tasseaux ou plinthe arrière).")

        # --- Éléments complémentaires ----------------------------------------
        if assemblage == "confirmat":
            n_holes = sum(1 for f in side_feats if f.kind == PERCAGE)
            d.extras.append(Extra("quincaillerie", "Vis confirmat 7×50", 2 * n_holes * qty,
                                  source=worst_source(*(f.y for f in side_feats if f.kind == PERCAGE))))
            pc = rule(profile, "confirmat", "prof_chant")
            dc = rule(profile, "confirmat", "d_chant")
            d.extras.append(Extra("operation", f"Perçage en bout Ø{fmt(dc.value)} × {fmt(pc.value)} mm "
                                  "(chants des panneaux horizontaux)", 2 * n_holes * qty, "trou",
                                  worst_source(pc, dc), "Hors CNC : gabarit de perçage ou perceuse à colonne"))
            d.extras.append(Extra("operation", "Fraisage des têtes confirmat (face extérieure des côtés)",
                                  2 * n_holes * qty, "trou", CALCULE, "Hors CNC : fraisoir à main"))
        else:
            d.extras.append(Extra("quincaillerie", "Colle vinylique D3", "selon besoin", "", CALCULE))
            d.extras.append(Extra("operation", "Serrage au serre-joint pendant le collage (vérifier l'équerre)",
                                  qty, "meuble", CALCULE))
        if chant in ("pvc1", "pvc2"):
            lengths = 2 * H.value + (2 + n) * Lh.value
            if hs.value > 0:
                lengths += Li.value
            d.extras.append(Extra("chant", f"{dict(CHANTS)[chant]} — chants avant",
                                  round(qty * lengths * 1.1 / 1000, 2), "m", worst_source(H, Lh, tc),
                                  "Longueur nette + 10 % de chute (proposition). Débit déjà réduit de "
                                  f"l'épaisseur du chant ({fmt(tc.value)} mm)."))
        if chant == "arrondi":
            d.extras.append(Extra("operation", "Arrondi R3 et ponçage des arêtes visibles", qty, "meuble",
                                  A_CONFIRMER, "Défonceuse à main ou ponceuse — rayon à confirmer"))
        d.extras.append(Extra("operation", "Ponçage, finition adaptée au mobilier enfant (à confirmer)", qty,
                              "meuble", A_CONFIRMER))
        if H.value >= 600:
            d.extras.append(Extra("securite", "Fixation murale anti-basculement (équerre + vis + cheville)",
                                  qty, "kit", A_CONFIRMER,
                                  "Recommandée pour tout meuble haut destiné aux enfants — à confirmer"))

        # --- Vue de face d'ensemble ------------------------------------------
        rects = [{"name": "Côté gauche", "x": 0, "y": 0, "w": e.value, "h": H.value},
                 {"name": "Côté droit", "x": L.value - e.value, "y": 0, "w": e.value, "h": H.value}]
        for name, z in levels:
            nm = "Tablette fixe" if name.startswith("Tablette") else name
            rects.append({"name": nm, "x": e.value, "y": z.value, "w": Li.value, "h": e.value, "label": name})
        if hs.value > 0:
            rects.append({"name": "Plinthe", "x": e.value, "y": 0, "w": Li.value, "h": hs.value, "dashed": True})
        d.elevation.update({"width": L.value, "height": H.value, "depth": P.value, "rects": rects,
                            "levels": [{"name": nm, "z": z.to_dict()} for nm, z in levels],
                            "title": f"Vue de face — {self.name}"})
        if qsrc == A_CONFIRMER:
            d.warn("Quantité de meubles à confirmer.")
        for p in d.parts:
            p.notes = [x for x in p.notes if x]
        d.number_parts()
        for p in d.parts:
            if p.mirror_of:
                ref = next(q.ref for q in d.parts if q.name == p.mirror_of)
                p.mirror_of = ref
                p.notes.append(f"Pièce symétrique de {ref} (usinages en miroir).")
        return d


def _hole_positions(width: float, edge: float, max_pitch: float) -> list[float]:
    if width <= 2 * edge:
        return [width / 2]
    span = width - 2 * edge
    k = max(1, math.ceil(span / max_pitch))
    return [edge + i * span / k for i in range(k + 1)]


def _mirror_y(f: Feature, width: float) -> Feature:
    """Miroir d'un usinage selon Y (côté droit = symétrique du côté gauche)."""
    if f.is_circle:
        y = Dim(width - f.y.value, f.y.source, f.y.formule)
    else:
        y = Dim(width - f.y.value - f.h.value, f.y.source, f.y.formule)
    return Feature(f.kind, f.label, f.x, y, f.w, f.h, f.diameter, f.depth, f.through, f.corner_r, f.note)


def _edges_h(chant: str) -> list[str]:
    if chant in ("pvc1", "pvc2"):
        return [f"Chant avant (le long de X, Y=0) : {dict(CHANTS)[chant]}"]
    return []
