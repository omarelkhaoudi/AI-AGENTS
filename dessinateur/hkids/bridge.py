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

Règle de sûreté reprise du dessinateur : pas de DXF tant qu'une cote, une
matière ou une méthode est « à confirmer ».
"""
from __future__ import annotations

import base64
import json
import re
import sys

from .design import compute, readiness
from .dxf_export import sheet_dxf
from .furniture import get_model, registry
from .profile import (RULE_FIELDS, apply_profile_answer, default_profile, material_question, rule_question,
                      usinage_question, with_defaults)
from .provenance import A_CONFIRMER, FOURNI, fmt

# Seules les questions de profil du dessin passent par ici (la CNC et ses fraises
# restent au programme pilote de l'atelier).
DRAWING_PROFILE_QUESTIONS = re.compile(r"^profil\.(materiau\.\w+|assemblage\.\w+|usinage)$")


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
    }
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
                out["panneaux"].append(entry)
    return out


def profile_summary(profile: dict) -> dict:
    questions = [material_question(profile, m) for m in profile["materiaux"]]
    questions += [rule_question(profile, r) for r in profile["assemblages"] if r in RULE_FIELDS]
    questions.append(usinage_question(profile))
    return {
        "ok": True,
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
        if not DRAWING_PROFILE_QUESTIONS.match(question):
            raise BridgeError(f"Réglage inconnu : « {question} ». Réglages du dessin : "
                              "profil.materiau.<matière>, profil.assemblage.<méthode>, profil.usinage.")
        # « 18,2 » comme on l'écrit à l'atelier.
        values = {k: v.replace(",", ".") if isinstance(v, str) and re.fullmatch(r"\s*\d+,\d+\s*", v) else v
                  for k, v in (request.get("valeurs") or {}).items()}
        try:
            return {"ok": True, "profil": apply_profile_answer(profile, question, values)}
        except (KeyError, ValueError, TypeError) as exc:
            raise BridgeError(f"Réglage refusé : {exc}")
    if action == "dessiner":
        return draw(profile, str(request.get("meuble", "")), request.get("parametres") or {})
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
