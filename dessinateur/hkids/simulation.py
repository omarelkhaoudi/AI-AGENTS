"""Simulation et contrôle du G-code réellement produit (relu depuis le texte).

Le contrôle porte sur le fichier exporté lui-même, pas sur les données
intermédiaires : unités, origines, broche, profondeurs, passes, dégagements,
limites de course, zones de fixation, avances, cohérence des arcs, ordre
des opérations. Il produit un compte rendu et une vue SVG des parcours.
"""
from __future__ import annotations

import math
import re
from html import escape

from .drawing import FONT

WORD = re.compile(r"([A-Z])\s*(-?\d+(?:\.\d*)?)")
RAPID_SPEED = 5000.0  # mm/min — à remplacer par la valeur réelle de la machine (phase 1)


def parse(gcode: str) -> list[dict]:
    out = []
    for n, raw in enumerate(gcode.splitlines(), 1):
        line = re.sub(r"\(.*?\)", "", raw).split(";")[0].strip().upper()
        if not line and "(" in raw:
            out.append({"line": n, "words": [], "raw": raw, "comment": True})
            continue
        if not line or line == "%":
            continue
        words = WORD.findall(line)
        out.append({"line": n, "words": [(w, float(v)) for w, v in words], "raw": raw})
    return out


def _arc_points(x0, y0, x1, y1, cx, cy, ccw, n=24):
    a0 = math.atan2(y0 - cy, x0 - cx)
    a1 = math.atan2(y1 - cy, x1 - cx)
    if ccw:
        while a1 <= a0 + 1e-9:
            a1 += 2 * math.pi
    else:
        while a1 >= a0 - 1e-9:
            a1 -= 2 * math.pi
    r = math.hypot(x0 - cx, y0 - cy)
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n))
            for i in range(1, n + 1)], abs(a1 - a0) * r


def simulate(gcode: str, ctx: dict) -> dict:
    """``ctx`` : z_top, z_through, z_safe, panel {length,width,zones}, origin, tools {id: tool},
    expected_tools (liste), machine {course_x, course_y, course_z, vitesse_broche_max}, fixation."""
    errors, warnings = [], []
    st = {"x": None, "y": None, "z": None, "units": None, "abs": None, "spindle": 0, "f": None, "tool": None}
    segs = []
    zmin = math.inf
    cut_len = rapid_len = time_min = 0.0
    tool_seq = []
    expected = list(ctx.get("expected_tools", []))
    cur_tool = expected[0] if expected else None
    if cur_tool:
        tool_seq.append(cur_tool)
    oy = -ctx["panel"]["width"] if ctx.get("origin") == "arriere_gauche" else 0.0
    zones = ctx["panel"].get("zones", [])
    last_cut_z = ctx["z_top"]
    machine = ctx.get("machine", {})
    for b in parse(gcode):
        if b.get("comment"):
            last_cut_z = ctx["z_top"]  # nouvelle opération
            continue
        g = None
        vals = {}
        for w, v in b["words"]:
            if w == "G":
                if v in (20, 21):
                    st["units"] = "mm" if v == 21 else "inch"
                    if v == 20:
                        errors.append(f"Ligne {b['line']} : unités en pouces (G20).")
                elif v in (90, 91):
                    st["abs"] = v == 90
                    if v == 91:
                        errors.append(f"Ligne {b['line']} : mode relatif G91 non attendu.")
                elif v in (0, 1, 2, 3):
                    g = int(v)
            elif w == "M":
                if v in (3, 4):
                    st["spindle"] = vals.get("S", st.get("s", 0)) or st.get("s", 0)
                elif v == 5:
                    st["spindle"] = 0
                elif v == 6:
                    pass
                elif v == 0 and len(expected) > len(tool_seq):
                    cur_tool = expected[len(tool_seq)]
                    tool_seq.append(cur_tool)
            elif w == "T":
                tid = f"T{int(v)}"
                if tid in ctx["tools"]:
                    cur_tool = tid
                    if not tool_seq or tool_seq[-1] != tid:
                        tool_seq.append(tid)
                else:
                    errors.append(f"Ligne {b['line']} : fraise {tid} inconnue.")
            else:
                vals[w] = v
        if "S" in vals:
            st["s"] = vals["S"]
            if any(w == "M" and v in (3, 4) for w, v in b["words"]):
                st["spindle"] = vals["S"]
            vmax = machine.get("vitesse_broche_max")
            if vmax and vals["S"] > float(vmax):
                errors.append(f"Ligne {b['line']} : vitesse de broche {vals['S']:g} > maximum machine {vmax}.")
        if "F" in vals:
            st["f"] = vals["F"]
        if g is None:
            continue
        if st["units"] != "mm":
            errors.append(f"Ligne {b['line']} : mouvement avant la déclaration des unités G21.")
            st["units"] = "mm?"
        if st["abs"] is not True:
            errors.append(f"Ligne {b['line']} : mouvement avant G90 (coordonnées absolues).")
            st["abs"] = True
        x0, y0, z0 = st["x"], st["y"], st["z"]
        x1 = vals.get("X", x0)
        y1 = vals.get("Y", y0)
        z1 = vals.get("Z", z0)
        if z1 is None:
            errors.append(f"Ligne {b['line']} : mouvement sans hauteur Z connue.")
            z1 = ctx["z_safe"]
        moved_xy = x0 is not None and (x1 != x0 or y1 != y0)
        tool = ctx["tools"].get(cur_tool) if cur_tool else None
        r_tool = (tool["diametre"] / 2) if tool else 0.0
        if g == 0:
            if moved_xy and min(z1, z0 if z0 is not None else z1) < ctx["z_top"] + 1.0:
                errors.append(f"Ligne {b['line']} : déplacement rapide G0 en XY à Z{min(z1, z0 or z1):g}, "
                              "sous le plan de sécurité.")
            if z0 is not None and z1 < ctx["z_top"] + 0.5 and z1 < z0:
                errors.append(f"Ligne {b['line']} : descente rapide G0 dans la matière (Z{z1:g}).")
        else:
            if not st["f"]:
                errors.append(f"Ligne {b['line']} : avance F non définie.")
            if (z1 < ctx["z_top"] or (z0 is not None and z0 < ctx["z_top"])) and not st["spindle"]:
                errors.append(f"Ligne {b['line']} : coupe broche arrêtée.")
            if tool and st["f"] and st["f"] > float(tool.get("avance_max", tool["avance"])) + 1e-6:
                errors.append(f"Ligne {b['line']} : avance {st['f']:g} > max de {cur_tool} "
                              f"({tool.get('avance_max')}).")
        if x0 is None and g != 0:
            errors.append(f"Ligne {b['line']} : coupe sans position XY initiale.")
        # points du segment
        pts = []
        length = 0.0
        if g in (2, 3) and x0 is not None:
            cx, cy = x0 + vals.get("I", 0.0), y0 + vals.get("J", 0.0)
            r0, r1 = math.hypot(x0 - cx, y0 - cy), math.hypot(x1 - cx, y1 - cy)
            if abs(r0 - r1) > 0.01:
                errors.append(f"Ligne {b['line']} : arc incohérent (rayons {r0:.3f} / {r1:.3f}).")
            pts, length = _arc_points(x0, y0, x1, y1, cx, cy, g == 3)
            pts = [(x0, y0)] + pts
        elif x0 is not None:
            pts = [(x0, y0), (x1, y1)]
            length = math.dist((x0, y0, z0 or 0), (x1, y1, z1))
        if g == 0:
            rapid_len += length
            time_min += length / RAPID_SPEED
        else:
            cut_len += length
            if st["f"]:
                time_min += length / st["f"]
        zc = min(z1, z0 if z0 is not None else z1)
        if g != 0 and zc < ctx["z_top"] - 1e-6:
            zmin = min(zmin, zc)
            step = last_cut_z - z1 if z0 is not None and z1 < z0 else 0
            if tool and step > float(tool["passe_max"]) + 0.01:
                errors.append(f"Ligne {b['line']} : passe de {step:.2f} mm > passe max {tool['passe_max']} de "
                              f"{cur_tool}.")
            if tool and ctx["z_top"] - zc > float(tool["longueur_utile"]) + 1e-6:
                errors.append(f"Ligne {b['line']} : profondeur {ctx['z_top'] - zc:.2f} > longueur utile de "
                              f"{cur_tool} ({tool['longueur_utile']}).")
            last_cut_z = min(last_cut_z, z1)
            for (px, py) in pts:
                py_panel = py - oy
                if (px < -r_tool - 0.01 or py_panel < -r_tool - 0.01 or px > ctx["panel"]["length"] + r_tool + 0.01
                        or py_panel > ctx["panel"]["width"] + r_tool + 0.01):
                    errors.append(f"Ligne {b['line']} : coupe hors du panneau ({px:.1f}, {py_panel:.1f}).")
                    break
                for zn in zones:
                    if (zn["x"] - r_tool < px < zn["x"] + zn["w"] + r_tool
                            and zn["y"] - r_tool < py_panel < zn["y"] + zn["h"] + r_tool):
                        errors.append(f"Ligne {b['line']} : la fraise passe dans une zone de fixation.")
                        break
        for px, py in pts:
            cx_lim, cy_lim = machine.get("course_x"), machine.get("course_y")
            if cx_lim and (px < -0.01 or px > float(cx_lim)):
                errors.append(f"Ligne {b['line']} : X{px:.1f} hors course machine (0–{cx_lim}).")
                break
            if cy_lim and abs(py) > float(cy_lim):
                errors.append(f"Ligne {b['line']} : Y{py:.1f} hors course machine ({cy_lim}).")
                break
        if machine.get("course_z") and z1 - ctx["z_through"] > float(machine["course_z"]):
            errors.append(f"Ligne {b['line']} : hauteur Z{z1:g} dépasse la course Z.")
        if pts:
            segs.append({"g": g, "pts": [(p[0], p[1] - oy) for p in pts], "z": z1})
        st["x"], st["y"], st["z"] = x1, y1, z1
    if zmin < ctx["z_through"] - 0.01:
        errors.append(f"Profondeur minimale Z{zmin:.2f} sous la limite autorisée Z{ctx['z_through']:.2f} "
                      "(dépassement dans le martyr trop important).")
    if st["spindle"]:
        warnings.append("La broche n'est pas arrêtée (M5) en fin de programme.")
    if expected and [t for t in tool_seq if t] != expected:
        errors.append(f"Séquence de fraises {tool_seq} différente de la séquence attendue {expected}.")
    # dédoublonnage des messages identiques
    errors = list(dict.fromkeys(errors))
    if len(errors) > 60:
        errors = errors[:60] + [f"… {len(errors) - 60} autre(s) erreur(s)."]
    return {"ok": not errors, "errors": errors, "warnings": warnings, "segments": segs,
            "stats": {"cut_length_m": round(cut_len / 1000, 2), "rapid_length_m": round(rapid_len / 1000, 2),
                      "time_min": round(time_min, 1), "z_min": None if zmin == math.inf else round(zmin, 3),
                      "tools": tool_seq}}


def order_check(program: dict) -> list[str]:
    """Une pièce n'est détourée qu'après tous ses usinages intérieurs."""
    errs = []
    seq = [op for f in program["files"] for op in f["ops"]]
    contour_idx = {op["ref"]: i for i, op in enumerate(seq) if op["type"] == "contour"}
    for i, op in enumerate(seq):
        if op["type"] != "contour" and op["ref"] in contour_idx and i > contour_idx[op["ref"]]:
            errs.append(f"{op['ref']} : {op['label']} après le détourage de la pièce.")
    return errs


def toolpath_svg(sim_segments: list[dict], panel: dict, placements_prims: list[dict], z_top: float,
                 z_through: float, title: str) -> str:
    PL, PW = panel["length"], panel["width"]
    k = 1080 / PL
    ox, oy = 60, 70
    X = lambda x: ox + x * k  # noqa: E731
    Y = lambda y: oy + (PW - y) * k  # noqa: E731
    out = [f'<text x="20" y="32" font-size="18" font-weight="bold">{escape(title)}</text>',
           f'<rect x="{X(0):.1f}" y="{Y(PW):.1f}" width="{PL * k:.1f}" height="{PW * k:.1f}" fill="#f3e2c0" '
           f'stroke="#78350f"/>']
    for z in panel.get("zones", []):
        out.append(f'<rect x="{X(z["x"]):.1f}" y="{Y(z["y"] + z["h"]):.1f}" width="{z["w"] * k:.1f}" '
                   f'height="{z["h"] * k:.1f}" fill="#fecaca" stroke="#dc2626"/>')
    for p in placements_prims:
        if p["type"] == "path":
            from .drawing import svg_path_d
            out.append(f'<path d="{svg_path_d(p["points"], X, Y, k)}" fill="none" stroke="#a8a29e" '
                       'stroke-width="0.6"/>')
        elif p["type"] == "rrect":
            out.append(f'<rect x="{X(p["x"]):.1f}" y="{Y(p["y"] + p["h"]):.1f}" width="{p["w"] * k:.1f}" '
                       f'height="{p["h"] * k:.1f}" rx="{p.get("r", 0) * k:.1f}" fill="none" stroke="#a8a29e" '
                       'stroke-width="0.6"/>')
        else:
            out.append(f'<circle cx="{X(p["cx"]):.1f}" cy="{Y(p["cy"]):.1f}" r="{p["r"] * k:.1f}" fill="none" '
                       'stroke="#a8a29e" stroke-width="0.6"/>')
    span = max(z_top - z_through, 1e-6)
    for s in sim_segments:
        d = " ".join(f"{X(x):.1f},{Y(y):.1f}" for x, y in s["pts"])
        if s["g"] == 0:
            out.append(f'<polyline points="{d}" fill="none" stroke="#ef4444" stroke-width="0.6" '
                       'stroke-dasharray="3 3"/>')
        else:
            depth = min(1.0, max(0.0, (z_top - s["z"]) / span))
            light = int(75 - 50 * depth)
            out.append(f'<polyline points="{d}" fill="none" stroke="hsl(220,80%,{light}%)" stroke-width="1"/>')
    y = Y(0) + 30
    out.append(f'<text x="20" y="{y:.0f}" font-size="12" fill="#334155">Bleu clair → foncé : profondeur croissante · '
               'Rouge pointillé : déplacements rapides (G0)</text>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1220 {y + 20:.0f}" width="1220" '
            f'height="{y + 20:.0f}" {FONT}><rect width="100%" height="100%" fill="#fff"/>' + "".join(out) + "</svg>")
