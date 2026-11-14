"""Profil d'atelier H-KIDS : matières, panneaux, méthodes d'assemblage, CNC,
fraises et paramètres d'usinage.

Le profil est versionné en base (chaque modification crée une version
immuable). Les valeurs livrées ici sont des valeurs de départ courantes en
menuiserie : elles sont toutes marquées ``confirme: False`` et déclenchent une
question tant que l'atelier (menuisier / opérateur) ne les a pas validées.
Les champs machine sont vides : ils doivent être relevés sur la CNC réelle
(phase 1).
"""
from __future__ import annotations

import copy
import hashlib
import json

from .provenance import A_CONFIRMER, FOURNI, Dim

# Panneaux de l'atelier : 3660 × 2020 mm (Hiba, message audio du 22/10/2026). Marges, zones de
# fixation et épaisseurs réelles restent à relever.
DEFAULT_PROFILE: dict = {
    "atelier": "H-KIDS Marrakech",
    "materiaux": {
        "mdf18": {"nom": "MDF 18 mm", "type": "MDF", "ep_nominale": 18, "ep_reelle": None, "fil": False,
                  "panneau": {"longueur": 3660, "largeur": 2020, "marge": 10, "zones_exclues": []},
                  "confirme": False},
        "cp18": {"nom": "Contreplaqué bouleau 18 mm", "type": "Contreplaqué", "ep_nominale": 18,
                 "ep_reelle": None, "fil": True,
                 "panneau": {"longueur": 3660, "largeur": 2020, "marge": 10, "zones_exclues": []},
                 "confirme": False},
        "cp15": {"nom": "Contreplaqué bouleau 15 mm", "type": "Contreplaqué", "ep_nominale": 15,
                 "ep_reelle": None, "fil": True,
                 "panneau": {"longueur": 3660, "largeur": 2020, "marge": 10, "zones_exclues": []},
                 "confirme": False},
        "hdf3": {"nom": "HDF 3 mm (fond)", "type": "HDF", "ep_nominale": 3, "ep_reelle": None, "fil": False,
                 "panneau": {"longueur": 3660, "largeur": 2020, "marge": 10, "zones_exclues": []},
                 "confirme": False},
        "cp5": {"nom": "Contreplaqué 5 mm (fond)", "type": "Contreplaqué", "ep_nominale": 5, "ep_reelle": None,
                "fil": True,
                "panneau": {"longueur": 3660, "largeur": 2020, "marge": 10, "zones_exclues": []},
                "confirme": False},
    },
    "assemblages": {
        "embrevement": {"nom": "Embrèvement (rainure CNC + colle)", "profondeur": 6, "jeu_largeur": 0.4,
                        "jeu_longueur": 0.5, "confirme": False},
        "rainure_fond": {"nom": "Fond en rainure", "profondeur": 8, "retrait_arriere": 10, "jeu_largeur": 0.5,
                         "jeu_fond": 1.0, "confirme": False},
        "confirmat": {"nom": "Vis confirmat 7×50", "d_traversant": 7, "d_chant": 5, "prof_chant": 45,
                      "entraxe_bord": 50, "entraxe_max": 250, "confirme": False},
        "vis_fond": {"nom": "Fond vissé en applique", "pas": 150, "confirme": False},
        "rainure_arretee": {"nom": "Rainure arrêtée à l'avant", "arret_avant": 12, "confirme": False},
        "taquets": {"nom": "Tablettes réglables sur taquets", "diametre": 5, "profondeur": 12, "pas": 32,
                    "retrait_avant": 37, "retrait_arriere": 37, "marge": 64, "jeu_longueur": 1,
                    "jeu_largeur": 2, "confirme": False},
    },
    "machine": {
        "modele": None, "controleur": None, "course_x": None, "course_y": None, "course_z": None,
        "vitesse_broche_max": None, "changeur_outils": None, "post_processeur": None,
        "origine_xy": "avant_gauche", "origine_z": "dessus_matiere", "confirme": False,
    },
    "outils": [
        {"id": "T1", "nom": "Fraise compression 2 dents Ø6", "type": "droite", "diametre": 6,
         "longueur_utile": 22, "rpm": 18000, "avance": 3000, "plongee": 800, "passe_max": 6,
         "avance_max": 6000, "confirme": False},
        {"id": "T2", "nom": "Fraise droite Ø3", "type": "droite", "diametre": 3, "longueur_utile": 12,
         "rpm": 18000, "avance": 1200, "plongee": 400, "passe_max": 2, "avance_max": 2500, "confirme": False},
        {"id": "T3", "nom": "Fraise droite Ø5 (perçage)", "type": "droite", "diametre": 5, "longueur_utile": 20,
         "rpm": 16000, "avance": 1500, "plongee": 600, "passe_max": 5, "avance_max": 3000, "confirme": False},
    ],
    "usinage": {
        "outil_contour": "T1", "espacement_pieces": 12, "hauteur_securite": 5, "hauteur_degagement": 20,
        "depassement_martyr": 0.3, "fixation": "vis", "sens_coupe": "avalant", "recouvrement": 0.4,
        "onglets": {"actifs": True, "hauteur": 3, "largeur": 8, "longueur_mini_cote": 150},
        "confirme": False,
    },
}

MACHINE_FIELDS = [
    ("modele", "Modèle de la CNC", "text"),
    ("controleur", "Contrôleur (ex. Mach3, NC Studio, DSP Richauto, GRBL)", "text"),
    ("course_x", "Course utile X", "mm"),
    ("course_y", "Course utile Y", "mm"),
    ("course_z", "Course utile Z", "mm"),
    ("vitesse_broche_max", "Vitesse de broche maximale", "tr/min"),
    ("changeur_outils", "Changeur d'outils automatique (oui/non)", "bool"),
    ("post_processeur", "Post-processeur à utiliser", "post"),
]


def default_profile() -> dict:
    return copy.deepcopy(DEFAULT_PROFILE)


def with_defaults(profile: dict) -> dict:
    """Complète un profil enregistré avant l'ajout de nouvelles méthodes : seules les méthodes absentes
    sont ajoutées, avec leurs valeurs de départ « à confirmer » (rien de confirmé n'est modifié)."""
    p = copy.deepcopy(profile)
    for k, v in DEFAULT_PROFILE["assemblages"].items():
        p["assemblages"].setdefault(k, copy.deepcopy(v))
    return p


def profile_hash(profile: dict) -> str:
    return hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest()[:16]


def machine_signature(profile: dict) -> str:
    m = {k: v for k, v in profile["machine"].items() if k != "confirme"}
    return hashlib.sha256(json.dumps(m, sort_keys=True).encode()).hexdigest()[:16]


def material(profile: dict, mat_id: str) -> dict:
    if mat_id not in profile["materiaux"]:
        raise KeyError(f"Matière inconnue dans le profil : {mat_id}")
    return profile["materiaux"][mat_id]


def thickness(profile: dict, mat_id: str) -> Dim:
    """Épaisseur réelle mesurée ; à défaut, nominale « à confirmer »."""
    m = material(profile, mat_id)
    if m.get("ep_reelle"):
        return Dim(float(m["ep_reelle"]), FOURNI if m.get("confirme") else A_CONFIRMER)
    return Dim(float(m["ep_nominale"]), A_CONFIRMER, "épaisseur nominale, réelle non mesurée")


def rule(profile: dict, method: str, key: str) -> Dim:
    """Valeur d'une règle d'assemblage, à confirmer tant que l'atelier ne l'a pas validée."""
    r = profile["assemblages"][method]
    return Dim(float(r[key]), FOURNI if r.get("confirme") else A_CONFIRMER, f"règle {method}.{key}")


def tool(profile: dict, tool_id: str) -> dict | None:
    return next((t for t in profile["outils"] if t["id"] == tool_id), None)


# ---------------------------------------------------------------------------
# Questions issues du profil
# ---------------------------------------------------------------------------

def material_question(profile: dict, mat_id: str) -> dict | None:
    m = material(profile, mat_id)
    if m.get("ep_reelle") and m.get("confirme"):
        return None
    p = m["panneau"]
    return {
        "id": f"profil.materiau.{mat_id}", "scope": "profil", "stage": "dessin",
        "title": f"Matière « {m['nom']} »",
        "text": "Mesurer l'épaisseur réelle au pied à coulisse (plusieurs points) et confirmer les dimensions "
                "utiles du panneau, la marge périphérique et le sens du fil.",
        "fields": [
            {"key": "ep_reelle", "label": "Épaisseur réelle mesurée", "type": "mm", "value": m.get("ep_reelle"),
             "proposal": None},
            {"key": "longueur", "label": "Longueur utile du panneau", "type": "mm", "value": p["longueur"]},
            {"key": "largeur", "label": "Largeur utile du panneau", "type": "mm", "value": p["largeur"]},
            {"key": "marge", "label": "Marge périphérique inutilisable", "type": "mm", "value": p["marge"]},
            {"key": "fil", "label": "Matière avec sens du fil", "type": "bool", "value": m["fil"]},
        ],
    }


RULE_FIELDS = {
    "embrevement": [("profondeur", "Profondeur de l'embrèvement"), ("jeu_largeur", "Jeu en largeur (total)"),
                    ("jeu_longueur", "Jeu en longueur (par côté)")],
    "rainure_fond": [("profondeur", "Profondeur de la rainure de fond"),
                     ("retrait_arriere", "Distance rainure / chant arrière"),
                     ("jeu_largeur", "Jeu en largeur de rainure"), ("jeu_fond", "Jeu en fond de rainure")],
    "confirmat": [("d_traversant", "Ø perçage traversant (pièce vissée)"), ("d_chant", "Ø perçage en bout"),
                  ("prof_chant", "Profondeur perçage en bout"), ("entraxe_bord", "Distance au bord"),
                  ("entraxe_max", "Entraxe maximal")],
    "vis_fond": [("pas", "Pas de vissage du fond")],
    "rainure_arretee": [("arret_avant", "Distance entre l'arrêt de la rainure et le chant avant")],
    "taquets": [("diametre", "Ø des trous de taquets"), ("profondeur", "Profondeur des trous"),
                ("pas", "Pas vertical entre trous"), ("retrait_avant", "Rangée avant : distance au bord de la tablette"),
                ("retrait_arriere", "Rangée arrière : distance au bord de la tablette"),
                ("marge", "Pas de trou à moins de … des panneaux fixes"),
                ("jeu_longueur", "Jeu en longueur de la tablette (par côté)"),
                ("jeu_largeur", "Jeu en largeur de la tablette")],
}


def rule_question(profile: dict, method: str) -> dict | None:
    r = profile["assemblages"][method]
    if r.get("confirme"):
        return None
    return {
        "id": f"profil.assemblage.{method}", "scope": "profil", "stage": "dessin",
        "title": f"Méthode H-KIDS : {r['nom']}",
        "text": "Valeurs de départ à valider avec le menuisier (tolérances réellement utilisées à l'atelier).",
        "fields": [{"key": k, "label": lbl, "type": "mm", "value": r[k]} for k, lbl in RULE_FIELDS[method]],
    }


def usinage_question(profile: dict) -> dict | None:
    u = profile["usinage"]
    if u.get("confirme"):
        return None
    return {
        "id": "profil.usinage", "scope": "profil", "stage": "dessin",
        "title": "Espacement des pièces sur le panneau",
        "text": "Espace minimal entre pièces (doit dépasser le Ø de la fraise de contour) et fraise de contour.",
        "fields": [
            {"key": "espacement_pieces", "label": "Espacement entre pièces", "type": "mm",
             "value": u["espacement_pieces"]},
            {"key": "outil_contour", "label": "Fraise de contour", "type": "tool", "value": u["outil_contour"]},
        ],
    }


def cnc_questions(profile: dict) -> list[dict]:
    """Questions bloquantes pour la préparation CNC (validation opérateur)."""
    qs = []
    m = profile["machine"]
    if not m.get("confirme") or any(m.get(k) in (None, "") for k, _, _ in MACHINE_FIELDS):
        qs.append({
            "id": "profil.machine", "scope": "profil", "stage": "cnc", "title": "CNC de l'atelier",
            "text": "À relever sur la machine réelle (plaque, documentation, contrôleur). Sans ces données, "
                    "aucun G-code ne peut être exporté.",
            "fields": [{"key": k, "label": lbl, "type": t, "value": m.get(k)} for k, lbl, t in MACHINE_FIELDS]
            + [{"key": "origine_xy", "label": "Origine XY", "type": "choice", "value": m.get("origine_xy"),
                "choices": [["avant_gauche", "Coin avant gauche du panneau"],
                            ["arriere_gauche", "Coin arrière gauche du panneau"]]},
               {"key": "origine_z", "label": "Origine Z", "type": "choice", "value": m.get("origine_z"),
                "choices": [["dessus_matiere", "Dessus de la matière"], ["dessus_martyr", "Dessus du martyr"]]}],
        })
    for t in profile["outils"]:
        if not t.get("confirme"):
            qs.append({
                "id": f"profil.outil.{t['id']}", "scope": "profil", "stage": "cnc",
                "title": f"Fraise {t['id']} — {t['nom']}",
                "text": "Vérifier la fraise réellement montée et les paramètres de coupe validés par l'opérateur.",
                "fields": [{"key": k, "label": lbl, "type": "mm" if k in ("diametre", "longueur_utile", "passe_max")
                            else "num", "value": t[k]}
                           for k, lbl in [("diametre", "Diamètre"), ("longueur_utile", "Longueur utile"),
                                          ("rpm", "Vitesse de broche (tr/min)"), ("avance", "Avance (mm/min)"),
                                          ("plongee", "Vitesse de plongée (mm/min)"),
                                          ("passe_max", "Profondeur de passe max"),
                                          ("avance_max", "Avance max admissible (mm/min)")]],
            })
    u = profile["usinage"]
    if not u.get("confirme_cnc"):
        qs.append({
            "id": "profil.fixation", "scope": "profil", "stage": "cnc", "title": "Fixation et dégagements",
            "text": "Mode de fixation des panneaux et hauteurs de dégagement.",
            "fields": [
                {"key": "fixation", "label": "Fixation", "type": "choice", "value": u["fixation"],
                 "choices": [["vis", "Vis dans le martyr"], ["depression", "Table à dépression"],
                             ["brides", "Brides / serre-joints"]]},
                {"key": "hauteur_securite", "label": "Hauteur de sécurité (au-dessus matière)", "type": "mm",
                 "value": u["hauteur_securite"]},
                {"key": "hauteur_degagement", "label": "Hauteur de dégagement (déplacements)", "type": "mm",
                 "value": u["hauteur_degagement"]},
                {"key": "depassement_martyr", "label": "Dépassement dans le martyr (coupes traversantes)",
                 "type": "mm", "value": u["depassement_martyr"]},
                {"key": "onglets_actifs", "label": "Onglets de maintien", "type": "bool",
                 "value": u["onglets"]["actifs"]},
                {"key": "onglets_hauteur", "label": "Hauteur des onglets", "type": "mm",
                 "value": u["onglets"]["hauteur"]},
            ],
        })
    return qs


def apply_profile_answer(profile: dict, qid: str, values: dict) -> dict:
    """Applique une réponse à une question de profil et retourne le nouveau profil."""
    p = copy.deepcopy(profile)
    parts = qid.split(".")

    def num(v):
        return None if v in (None, "") else float(v)

    if parts[1] == "materiau":
        m = p["materiaux"][parts[2]]
        if num(values.get("ep_reelle")) is None:
            raise ValueError("L'épaisseur réelle mesurée est obligatoire.")
        m["ep_reelle"] = num(values["ep_reelle"])
        for k in ("longueur", "largeur", "marge"):
            if values.get(k) not in (None, ""):
                m["panneau"][k] = num(values[k])
        if "fil" in values:
            m["fil"] = bool(values["fil"])
        m["confirme"] = True
    elif parts[1] == "assemblage":
        r = p["assemblages"][parts[2]]
        for k, _ in RULE_FIELDS[parts[2]]:
            if values.get(k) not in (None, ""):
                r[k] = num(values[k])
        r["confirme"] = True
    elif parts[1] == "usinage":
        u = p["usinage"]
        if values.get("espacement_pieces") not in (None, ""):
            u["espacement_pieces"] = num(values["espacement_pieces"])
        if values.get("outil_contour"):
            if tool(p, values["outil_contour"]) is None:
                raise ValueError("Fraise inconnue.")
            u["outil_contour"] = values["outil_contour"]
        u["confirme"] = True
    elif parts[1] == "machine":
        m = p["machine"]
        for k, _, t in MACHINE_FIELDS + [("origine_xy", "", "choice"), ("origine_z", "", "choice")]:
            if k in values:
                v = values[k]
                if t == "mm" or k == "vitesse_broche_max":
                    v = num(v)
                elif t == "bool":
                    v = bool(v) if not isinstance(v, str) else v.lower() in ("oui", "true", "1")
                m[k] = v if v != "" else None
        missing = [lbl for k, lbl, _ in MACHINE_FIELDS if m.get(k) in (None, "")]
        if missing:
            raise ValueError("Champs machine manquants : " + ", ".join(missing))
        m["confirme"] = True
    elif parts[1] == "outil":
        t = tool(p, parts[2])
        for k in ("diametre", "longueur_utile", "rpm", "avance", "plongee", "passe_max", "avance_max"):
            if values.get(k) not in (None, ""):
                t[k] = num(values[k])
        t["confirme"] = True
    elif parts[1] == "fixation":
        u = p["usinage"]
        if values.get("fixation"):
            u["fixation"] = values["fixation"]
        for k in ("hauteur_securite", "hauteur_degagement", "depassement_martyr"):
            if values.get(k) not in (None, ""):
                u[k] = num(values[k])
        if "onglets_actifs" in values:
            u["onglets"]["actifs"] = bool(values["onglets_actifs"])
        if values.get("onglets_hauteur") not in (None, ""):
            u["onglets"]["hauteur"] = num(values["onglets_hauteur"])
        u["confirme_cnc"] = True
    else:
        raise ValueError(f"Question de profil inconnue : {qid}")
    return p
