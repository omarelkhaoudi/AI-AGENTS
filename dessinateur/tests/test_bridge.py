"""Le pont du cockpit : pas de DXF tant qu'une valeur est à confirmer, puis un DXF
lisible par panneau, en millimètres, avec un calque par opération."""
import base64
import io
import json
import subprocess
import sys
from pathlib import Path

import ezdxf

ENGINE = Path(__file__).resolve().parent.parent

BOOKCASE = {"largeur": 800, "hauteur": 1100, "profondeur": 300, "quantite": 1, "nb_tablettes": 2,
            "repartition": "egale", "materiau_caisson": "mdf18", "assemblage": "embrevement", "fond": "rainure",
            "materiau_fond": "hdf3", "hauteur_socle": 60, "retrait_socle": 20, "chant_avant": "arrondi",
            "nb_tablettes_reglables": 0, "rainures": "traversantes"}
WORKSHOP = [("profil.materiau.mdf18", {"ep_reelle": "18,2"}), ("profil.materiau.hdf3", {"ep_reelle": 3.1}),
            ("profil.assemblage.embrevement", {}), ("profil.assemblage.rainure_fond", {}), ("profil.usinage", {})]


def call(request: dict) -> dict:
    done = subprocess.run([sys.executable, "-m", "hkids.bridge"], input=json.dumps(request).encode("utf-8"),
                          capture_output=True, cwd=ENGINE, check=True)
    return json.loads(done.stdout.decode("utf-8"))


def given(values: dict, source="fourni") -> dict:
    return {k: {"value": str(v), "source": source} for k, v in values.items()}


def confirmed_profile() -> dict:
    profile = call({"action": "profil_initial"})["profil"]
    for question, values in WORKSHOP:
        answer = call({"action": "regler_profil", "profil": profile, "question": question, "valeurs": values})
        assert answer["ok"], answer
        profile = answer["profil"]
    return profile


def test_no_dxf_while_the_workshop_values_are_to_confirm():
    profile = call({"action": "profil_initial"})["profil"]
    assert profile["materiaux"]["mdf18"]["panneau"]["longueur"] == 3660, "the workshop's panels, said by Hiba"
    drawing = call({"action": "dessiner", "profil": profile, "meuble": "bibliotheque", "parametres": given(BOOKCASE)})
    assert drawing["ok"] and drawing["decompose"] and not drawing["pret"]
    assert {q["id"] for q in drawing["questions"]} >= {"profil.materiau.mdf18", "profil.assemblage.embrevement"}
    assert drawing["panneaux"] and all("dxf_base64" not in sheet for sheet in drawing["panneaux"])


def test_a_dimension_to_confirm_blocks_the_dxf_too():
    values = given(BOOKCASE)
    values["largeur"]["source"] = "a_confirmer"
    drawing = call({"action": "dessiner", "profil": confirmed_profile(), "meuble": "bibliotheque", "parametres": values})
    assert not drawing["pret"]
    assert any(q["id"] == "projet.dimensions" for q in drawing["questions"])


def test_one_dxf_per_panel_once_everything_is_confirmed():
    drawing = call({"action": "dessiner", "profil": confirmed_profile(), "meuble": "bibliotheque",
                    "parametres": given(BOOKCASE)})
    assert drawing["pret"], drawing["raisons"]
    assert [p["ref"] for p in drawing["pieces"]][:2] == ["P01", "P02"]
    assert drawing["pieces"][0]["epaisseur"] == "18.2", "the measured thickness, not the nominal one"
    sheets = {sheet["matiere"]: sheet for sheet in drawing["panneaux"]}
    assert set(sheets) == {"mdf18", "hdf3"}
    doc = ezdxf.read(io.StringIO(base64.b64decode(sheets["mdf18"]["dxf_base64"]).decode("utf-8")))
    assert doc.header["$INSUNITS"] == 4, "millimetres"
    layers = {entity.dxf.layer for entity in doc.modelspace()}
    assert {"PANNEAU", "CONTOUR_EXT"} <= layers
    assert any(layer.startswith("RAINURE_P") for layer in layers), "the embrevement grooves on their own layer"
    again = call({"action": "dessiner", "profil": confirmed_profile(), "meuble": "bibliotheque",
                  "parametres": given(BOOKCASE)})
    assert again["empreinte"] == drawing["empreinte"], "the same design keeps the same fingerprint"


def test_errors_are_said_in_words():
    profile = call({"action": "profil_initial"})["profil"]
    assert "Modèles" in call({"action": "dessiner", "profil": profile, "meuble": "lit", "parametres": {}})["erreur"]
    unknown = call({"action": "dessiner", "profil": profile, "meuble": "bibliotheque", "parametres": given({"couleur": "rose"})})
    assert "couleur" in unknown["erreur"] and "largeur" in unknown["erreur"]
    assert not call({"action": "regler_profil", "profil": profile, "question": "profil.machine", "valeurs": {}})["ok"]
    assert "obligatoire" in call({"action": "regler_profil", "profil": profile, "question": "profil.materiau.mdf18",
                                  "valeurs": {}})["erreur"]


MACHINE = {"modele": "CNC exemple 1325", "controleur": "GRBL 1.1", "course_x": 3700, "course_y": 2100, "course_z": 150,
           "vitesse_broche_max": 24000, "changeur_outils": False, "post_processeur": "grbl_mm",
           "origine_xy": "avant_gauche", "origine_z": "dessus_matiere"}


def machine_profile() -> dict:
    profile = confirmed_profile()
    for question, values in [("profil.machine", MACHINE), ("profil.outil.T1", {}), ("profil.outil.T2", {}),
                             ("profil.outil.T3", {}), ("profil.fixation", {})]:
        answer = call({"action": "regler_profil", "profil": profile, "question": question, "valeurs": values})
        assert answer["ok"], answer
        profile = answer["profil"]
    return profile


def test_no_gcode_before_the_machine_is_known_and_the_pilot_passed():
    blocked = call({"action": "gcode", "profil": confirmed_profile(), "meuble": "bibliotheque",
                    "parametres": given(BOOKCASE)})
    assert not blocked["pret"] and not blocked["programmes"]
    assert any("CNC de l'atelier" in reason for reason in blocked["raisons"])

    profile = machine_profile()
    pilot = call({"action": "pilote", "profil": profile})
    assert pilot["pret"] and not pilot["qualifie"], pilot["raisons"]
    assert pilot["fichiers"][0]["gcode"].startswith("(H-KIDS - PROGRAMME PILOTE")
    unqualified = call({"action": "gcode", "profil": profile, "meuble": "bibliotheque", "parametres": given(BOOKCASE)})
    assert not unqualified["pret"] and "non qualifié" in unqualified["raisons"][0]

    passed = [{"post_id": "grbl_mm", "post_version": pilot["post"]["version"],
               "machine_signature": pilot["signature_machine"], "statut": "qualifie"}]
    made = call({"action": "gcode", "profil": profile, "meuble": "bibliotheque", "parametres": given(BOOKCASE),
                 "qualifications": passed, "titre": "BC 171"})
    assert made["pret"], made["raisons"]
    files = [f for program in made["programmes"] for f in program["fichiers"]]
    assert {program["matiere"] for program in made["programmes"]} == {"mdf18", "hdf3"}
    assert all(f["simulation"]["ok"] and f["gcode"].rstrip().endswith("M30") for f in files)
    assert any(f["fraises"] == ["T2"] for f in files), "no tool changer: one file per cutter"

    # Another machine (other signature) is not qualified by this pilot.
    other = dict(MACHINE, course_x=2500)
    moved = call({"action": "regler_profil", "profil": profile, "question": "profil.machine", "valeurs": other})["profil"]
    again = call({"action": "gcode", "profil": moved, "meuble": "bibliotheque", "parametres": given(BOOKCASE),
                  "qualifications": passed})
    assert not again["pret"] and "non qualifié" in again["raisons"][0]
