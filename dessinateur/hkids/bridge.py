"""Pont entre le cockpit H-KIDS (Node) et le moteur du dessinateur méthodes.

Le cockpit lance ``python -m hkids.bridge``, écrit une demande JSON sur l'entrée
standard et lit la réponse JSON sur la sortie standard. Rien n'est gardé ici :
le profil d'atelier est tenu par le cockpit et envoyé à chaque demande.

Demandes (champ ``action``) :

- ``profil_initial`` : le profil de départ (valeurs courantes, toutes à confirmer).
- ``lire_profil`` (``profil``) : matières, méthodes d'assemblage, espacement, et ce
  qui reste à confirmer.
- ``regler_profil`` (``profil``, ``question``, ``valeurs``) : applique une valeur
  relevée à l'atelier (épaisseur mesurée, jeu d'assemblage…) et la marque confirmée.
- ``dessiner`` (``profil``, ``meuble``, ``parametres``) : décompose le meuble, et
  quand plus rien n'est à confirmer, renvoie le DXF de chaque panneau calepiné
  (R2010, mm, 1:1, un calque par opération).
- ``pilote`` (``profil``, ``qualifications``) : le programme pilote, une petite
  pièce d'essai à usiner dans une chute pour qualifier le post-processeur sur
  la vraie machine, avec la simulation de son G-code.
- ``gcode`` (``profil``, ``qualifications``, ``meuble``, ``parametres``, ``titre``) :
  le G-code de chaque panneau (parcours 2,5D, un fichier par fraise sans
  changeur d'outils), relu par la simulation.

Règles de sûreté reprises du dessinateur : pas de DXF tant qu'une cote, une
matière ou une méthode est « à confirmer » ; pas de G-code tant que la CNC, les
fraises et la fixation ne sont pas confirmées, que le post-processeur n'a pas
passé le programme pilote sur cette machine (même signature) et que la
simulation d'un fichier produit signale une erreur.
"""
from __future__ import annotations

import base64
import json
import re
import sys

from .cam import build_programs, pilot_program
from .design import canonical_hash, compute, readiness
from .dxf_export import sheet_dxf
from .drawing import part_svg, sheet_svg
from .furniture import get_model, registry
from .postprocessors import get_post, list_posts
from .profile import (RULE_FIELDS, apply_profile_answer, cnc_questions, default_profile, machine_signature,
                      material_question, rule_question, usinage_question, with_defaults)
from .provenance import A_CONFIRMER, FOURNI, fmt
from .simulation import order_check, simulate

# Les réglages du profil que le cockpit peut confirmer : ceux du dessin, puis ceux
# de la CNC (machine, fraises, fixation).
PROFILE_QUESTIONS = re.compile(r"^profil\.(materiau\.\w+|assemblage\.\w+|usinage|machine|outil\.\w+|fixation)$")
CAM_SETTINGS = {"mode": "interne", "outils": {}, "notes": ""}


class BridgeError(Exception):
    pass


def _coerce(kind: str, value):
    if value in (None, ""):
        return None
    if kind == "mm":
        return float(str(value).replace(",", "."))
    if kind == "int":
        return int(float(str(value).replace(",", ".")))
    if kind == "list_mm":
        if isinstance(value, list):
            return [float(v) for v in value]
        tokens = re.split(r"[;\s]+", str(value).strip().replace(", ", " "))
        if len(tokens) == 1:
            tokens = str(value).split(",")
        return [float(t.replace(",", ".")) for t in tokens if t.strip()]
    if kind == "bool":
        return value if isinstance(value, bool) else str(value).lower() in ("1", "true", "oui")
    if kind == "pieces" and isinstance(value, str):
        return json.loads(value)
    return value


def _params(model, given: dict) -> dict:
    kinds = {pd.name: pd.type for pd in model.params}
    out = {}
    for name, entry in (given or {}).items():
        if name not in kinds:
            raise BridgeError(f"Paramètre inconnu pour « {model.name} » : {name}. "
                              f"Paramètres possibles : {', '.join(kinds)}.")
        raw = entry.get("value") if isinstance(entry, dict) else entry
        source = entry.get("source", FOURNI) if isinstance(entry, dict) else FOURNI
        try:
            value = _coerce(kinds[name], raw)
        except (TypeError, ValueError):
            raise BridgeError(f"Valeur invalide pour {name} : « {raw} ».")
        if value is not None:
            out[name] = {"value": value, "source": source if source in (FOURNI, A_CONFIRMER) else A_CONFIRMER}
    return out


def _question(q: dict) -> dict:
    return {
        "id": q["id"],
        "titre": q["title"],
        "texte": q.get("text", ""),
        "champs": [{k: v for k, v in {
            "cle": f["key"], "libelle": f["label"], "type": f["type"], "statut": f.get("status"),
            "valeur": f.get("value"), "proposition": f.get("proposal"),
            "choix": [c[0] for c in f["choices"]] if f.get("choices") else None,
        }.items() if v not in (None, "")} for f in q.get("fields", [])],
    }


def models() -> list[dict]:
    return [{"id": m.id, "nom": m.name, "description": m.description} for m in registry().values()]


def draw(profile: dict, furniture: str, given: dict) -> dict:
    try:
        model = get_model(furniture)
    except KeyError:
        raise BridgeError(f"Meuble inconnu : « {furniture} ». Modèles : "
                          + ", ".join(f"{m['id']} ({m['nom']})" for m in models()) + ".")
    params = _params(model, given)
    res = compute({"type": furniture, "params": params}, profile)
    ready = readiness(res)
    out = {
        "ok": True,
        "meuble": furniture,
        "nom_meuble": model.name,
        "decompose": res["built"],
        "pret": ready["ready"],
        "raisons": ready["reasons"],
        "erreurs": res["errors"],
        "questions": [_question(q) for q in res["questions"] if q["stage"] == "dessin"],
        "avertissements": [w["text"] for w in res["warnings"] if w["level"] != "bloquant"],
        "pieces": [{
            "ref": r["ref"], "designation": r["designation"], "dimensions": r["dimensions"],
            "epaisseur": fmt(r["thickness"]["value"]), "quantite": r["qty"], "matiere": r["material"],
            "a_confirmer": r["source"] == A_CONFIRMER, "observations": r["observations"],
        } for r in res["cutlist"]],
        "complements": [{"designation": x["designation"], "quantite": x.get("qty"),
                         "a_confirmer": x["source"] == A_CONFIRMER} for x in res["extras"]],
        "empreinte": res.get("design_hash"),
        "panneaux": [],
        "plans_pieces": [],
    }
    if ready["ready"]:
        out["plans_pieces"] = [{"ref": part["ref"], "svg_base64": base64.b64encode(part_svg(part).encode("utf-8")).decode("ascii")}
                               for part in res["parts"]]
    nesting = res.get("nesting")
    if nesting:
        for group in nesting["groups"]:
            for sheet in group["sheets"]:
                entry = {"matiere": group["material_id"], "nom_matiere": group["material_name"],
                         "numero": sheet["index"], "sur": len(group["sheets"]),
                         "pieces": len(sheet["placements"]), "utilisation": sheet["utilization"]}
                if ready["ready"]:
                    data = sheet_dxf(group, sheet, {p["ref"]: p for p in res["parts"]})
                    entry["dxf_base64"] = base64.b64encode(data).decode("ascii")
                    svg = sheet_svg(group, sheet, {p["ref"]: p for p in res["parts"]}, len(group["sheets"]))
                    entry["svg_base64"] = base64.b64encode(svg.encode("utf-8")).decode("ascii")
                    entry["placements"] = sheet["placements"]
                out["panneaux"].append(entry)
    return out


def profile_summary(profile: dict) -> dict:
    questions = [material_question(profile, m) for m in profile["materiaux"]]
    questions += [rule_question(profile, r) for r in profile["assemblages"] if r in RULE_FIELDS]
    questions.append(usinage_question(profile))
    return {
        "ok": True,
        "machine": dict(profile["machine"]),
        "fraises": [{k: t[k] for k in ("id", "nom", "diametre", "rpm", "avance", "plongee", "passe_max", "confirme")}
                    for t in profile["outils"]],
        "post_processeurs": list_posts(),
        "a_confirmer_cnc": [_question(q) for q in cnc_questions(profile)],
        "materiaux": [{"id": k, "nom": m["nom"], "epaisseur_nominale": m["ep_nominale"],
                       "epaisseur_reelle": m.get("ep_reelle"), "panneau": f"{fmt(m['panneau']['longueur'])} × "
                       f"{fmt(m['panneau']['largeur'])} mm, marge {fmt(m['panneau']['marge'])} mm",
                       "confirme": bool(m.get("confirme"))} for k, m in profile["materiaux"].items()],
        "assemblages": [{"id": k, "nom": r["nom"], "confirme": bool(r.get("confirme")),
                         "valeurs": {f: r[f] for f, _ in RULE_FIELDS.get(k, [])}}
                        for k, r in profile["assemblages"].items()],
        "espacement_pieces": profile["usinage"]["espacement_pieces"],
        "a_confirmer": [_question(q) for q in questions if q],
    }


def cam_blockers(profile: dict) -> tuple[list[str], object]:
    """Ce qui empêche tout G-code sur cette machine, avant même le meuble."""
    reasons = [f"{q['title']} : à confirmer." for q in cnc_questions(profile)]
    post_id = profile["machine"].get("post_processeur")
    post = get_post(post_id)
    known = ", ".join(p["id"] for p in list_posts())
    if not post_id:
        reasons.append(f"Aucun post-processeur choisi pour la machine (profil.machine, post_processeur : {known}).")
    elif not post:
        reasons.append(f"Post-processeur inconnu « {post_id} » ({known}).")
    return reasons, post


def qualified(profile: dict, post, qualifications: list) -> bool:
    """Le post-processeur a passé le programme pilote sur cette machine, avec ces réglages."""
    signature = machine_signature(profile)
    return any(q.get("post_id") == post.id and str(q.get("post_version")) == str(post.version)
               and q.get("machine_signature") == signature and q.get("statut") == "qualifie"
               for q in qualifications)


def _emit(post, program: dict, file: dict, profile: dict, meta: dict) -> dict:
    tools = {t["id"]: t for t in profile["outils"]}
    origin = profile["machine"].get("origine_xy") or "avant_gauche"
    text = post.emit(program, file, tools, meta, origin)
    sim = simulate(text, {"z_top": program["z_top"], "z_through": program["z_through"], "z_safe": program["z_safe"],
                          "panel": program["panel"], "origin": origin, "tools": tools, "expected_tools": file["tools"],
                          "machine": profile["machine"]})
    stats = sim.get("stats") or {}
    return {"nom": f"{file['name']}.nc", "fraises": file["tools"], "operations": len(file["ops"]), "gcode": text,
            "simulation": {"ok": sim["ok"], "erreurs": sim["errors"], "avertissements": sim["warnings"],
                           "duree_min": stats.get("time_min")}}


def pilot(profile: dict, qualifications: list, thickness: float = 18.0) -> dict:
    reasons, post = cam_blockers(profile)
    if reasons:
        return {"ok": True, "pret": False, "raisons": reasons, "fichiers": []}
    program = pilot_program(profile, CAM_SETTINGS, thickness)
    meta = {"title": "PROGRAMME PILOTE - qualification post-processeur - chute uniquement", "kind": "PILOTE"}
    files = [_emit(post, program, f, profile, {**meta, "file": f["name"]}) for f in program["files"]]
    problems = program["errors"] + [e for f in files for e in f["simulation"]["erreurs"]]
    return {"ok": True, "pret": not problems, "raisons": problems, "fichiers": files,
            "chute": "250 × 180 mm, épaisseur 18 mm ; pièce d'essai 120 × 80 mm avec un perçage Ø10, "
                     "une poche 40 × 20 profondeur 3 et une ouverture 30 × 18",
            "empreinte_pilote": canonical_hash({"files": [f["gcode"] for f in files],
                                                "machine": machine_signature(profile)}),
            "post": {"id": post.id, "version": post.version, "nom": post.name},
            "signature_machine": machine_signature(profile), "qualifie": qualified(profile, post, qualifications)}


def gcode(profile: dict, qualifications: list, furniture: str, given: dict, title: str) -> dict:
    drawing = draw(profile, furniture, given)
    out = {k: drawing[k] for k in ("ok", "meuble", "nom_meuble", "pret", "raisons", "questions", "empreinte")}
    out["programmes"] = []
    if not drawing["pret"]:
        out["raisons"] = ["Le dessin n'est pas prêt : pas de G-code."] + drawing["raisons"]
        return out
    reasons, post = cam_blockers(profile)
    if post and not reasons and not qualified(profile, post, qualifications):
        reasons.append(f"Post-processeur « {post.name} » non qualifié sur cette machine : le programme pilote doit "
                       "être usiné dans une chute et déclaré conforme d'abord.")
    if reasons:
        return {**out, "pret": False, "raisons": reasons}
    model = get_model(furniture)
    res = compute({"type": furniture, "params": _params(model, given)}, profile)
    texts = []
    for program in build_programs(res, profile, CAM_SETTINGS):
        meta = {"title": f"{title or model.name} - {program['material_name']} - panneau {program['sheet']}",
                "project": title, "design_hash": res["design_hash"], "sheet": program["sheet"], "kind": "PRODUCTION"}
        files = [_emit(post, program, f, profile, {**meta, "file": f["name"]}) for f in program["files"]]
        texts += [f["gcode"] for f in files]
        problems = program["errors"] + order_check(program)
        problems += [f"{f['nom']} : {e}" for f in files for e in f["simulation"]["erreurs"]]
        out["programmes"].append({"matiere": program["material_id"], "nom_matiere": program["material_name"],
                                  "panneau": program["sheet"], "fichiers": files, "erreurs": problems})
    blocking = [f"Panneau {p['panneau']} ({p['nom_matiere']}) : {e}" for p in out["programmes"] for e in p["erreurs"]]
    out["pret"] = not blocking
    out["raisons"] = blocking
    out["post"] = {"id": post.id, "version": post.version, "nom": post.name}
    out["empreinte_cam"] = canonical_hash({"design": res["design_hash"], "machine": profile["machine"],
                                           "tools": profile["outils"], "usinage": profile["usinage"],
                                           "post": [post.id, post.version], "gcode": texts})
    return out


def handle(request: dict) -> dict:
    action = request.get("action")
    if action == "profil_initial":
        return {"ok": True, "profil": default_profile()}
    profile = request.get("profil")
    if not isinstance(profile, dict):
        raise BridgeError("Profil d'atelier manquant.")
    profile = with_defaults(profile)
    if action == "lire_profil":
        return profile_summary(profile)
    if action == "regler_profil":
        question = str(request.get("question", ""))
        if not PROFILE_QUESTIONS.match(question):
            raise BridgeError(f"Réglage inconnu : « {question} ». Réglages : profil.materiau.<matière>, "
                              "profil.assemblage.<méthode>, profil.usinage, profil.machine, "
                              "profil.outil.<fraise>, profil.fixation.")
        # « 18,2 » comme on l'écrit à l'atelier.
        values = {k: v.replace(",", ".") if isinstance(v, str) and re.fullmatch(r"\s*\d+,\d+\s*", v) else v
                  for k, v in (request.get("valeurs") or {}).items()}
        try:
            return {"ok": True, "profil": apply_profile_answer(profile, question, values)}
        except (KeyError, ValueError, TypeError) as exc:
            raise BridgeError(f"Réglage refusé : {exc}")
    if action == "dessiner":
        return draw(profile, str(request.get("meuble", "")), request.get("parametres") or {})
    qualifications = request.get("qualifications") or []
    if action == "pilote":
        return pilot(profile, qualifications)
    if action == "gcode":
        return gcode(profile, qualifications, str(request.get("meuble", "")), request.get("parametres") or {},
                     str(request.get("titre", "")))
    raise BridgeError(f"Action inconnue : {action}")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        answer = handle(request)
    except BridgeError as exc:
        answer = {"ok": False, "erreur": str(exc)}
    except json.JSONDecodeError:
        answer = {"ok": False, "erreur": "Demande illisible (JSON attendu)."}
    sys.stdout.write(json.dumps(answer, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
