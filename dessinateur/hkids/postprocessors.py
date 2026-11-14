"""Post-processeurs : traduction des mouvements neutres en G-code machine.

Un post-processeur n'est utilisable pour la production qu'après
qualification sur la machine réelle (programme pilote simulé puis testé
avec l'opérateur, enregistré en base). Un identifiant inconnu bloque
toujours l'export.

Les deux modèles fournis sont des points de départ génériques, NON qualifiés :
le contrôleur réel de la CNC H-KIDS doit être identifié en phase 1.
"""
from __future__ import annotations

import unicodedata
from datetime import datetime


def _n(v: float) -> str:
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


class PostProcessor:
    id = ""
    name = ""
    version = "1"
    controller = ""
    tool_change = False
    comment_open, comment_close = "(", ")"

    def comment(self, text: str) -> str:
        """Commentaire en ASCII strict (beaucoup de contrôleurs refusent les accents)."""
        for a, b in (("—", "-"), ("–", "-"), ("Ø", "D"), ("×", "x"), ("(", "["), (")", "]"), ("°", "deg")):
            text = text.replace(a, b)
        clean = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
        return f"{self.comment_open}{clean}{self.comment_close}"

    def header(self, meta: dict, tool: dict, z_clear: float) -> list[str]:
        lines = [self.comment(f"H-KIDS — {meta.get('title', '')}")]
        for k in ("project", "version", "design_hash", "cam_hash", "sheet", "file", "kind", "date", "validations"):
            if meta.get(k) not in (None, ""):
                lines.append(self.comment(f"{k}: {meta[k]}"))
        lines.append(self.comment(f"post: {self.id} v{self.version}"))
        lines += ["G21", "G90", "G17", "G94"]
        return lines

    def tool_block(self, tool: dict, z_clear: float, first: bool) -> list[str]:
        out = []
        if not first:
            out += [f"G0 Z{_n(z_clear)}", "M5"]
        out.append(self.comment(f"Fraise {tool['id']} — {tool['nom']} — Ø{_n(tool['diametre'])}"))
        if self.tool_change:
            num = "".join(ch for ch in tool["id"] if ch.isdigit()) or "1"
            out.append(f"T{num} M6")
        elif not first:
            out.append("M0 " + self.comment(f"CHANGER LA FRAISE : {tool['id']} puis refaire Z0"))
        out += [f"G0 Z{_n(z_clear)}", f"M3 S{int(tool['rpm'])}", "G4 P3"]
        return out

    def footer(self, z_clear: float) -> list[str]:
        return [f"G0 Z{_n(z_clear)}", "M5", "G0 X0 Y0", "M30"]

    def moves(self, moves: list[dict], state: dict, ox: float, oy: float) -> list[str]:
        out = []
        for m in moves:
            words = [f"G{m['g']}"]
            for ax, off in (("x", ox), ("y", oy), ("z", 0.0)):
                v = m.get(ax)
                if v is None:
                    continue
                v = v + off
                if state.get(ax) is None or abs(state[ax] - v) > 1e-6 or m["g"] in (2, 3):
                    words.append(f"{ax.upper()}{_n(v)}")
                    state[ax] = v
            if m["g"] in (2, 3):
                words += [f"I{_n(m['i'])}", f"J{_n(m['j'])}"]
            if m["g"] != 0 and m.get("f") and state.get("f") != m["f"]:
                words.append(f"F{_n(m['f'])}")
                state["f"] = m["f"]
            if len(words) > 1:
                out.append(" ".join(words))
        return out

    def emit(self, program: dict, file: dict, tools: dict, meta: dict, origin: str) -> str:
        panel_w = program["panel"]["width"]
        ox, oy = 0.0, (-panel_w if origin == "arriere_gauche" else 0.0)
        z_clear = program["z_clear"]
        first_tool = tools[file["tools"][0]]
        lines = self.header(meta, first_tool, z_clear)
        state: dict = {}
        current = None
        for op in file["ops"]:
            if op["tool"] != current:
                lines += self.tool_block(tools[op["tool"]], z_clear, current is None)
                state = {"z": z_clear}
                current = op["tool"]
            lines.append(self.comment(op["label"]))
            lines += self.moves(op["moves"], state, ox, oy)
        lines += self.footer(z_clear)
        return "\n".join(lines) + "\n"


class GrblMM(PostProcessor):
    id = "grbl_mm"
    name = "GRBL générique (mm)"
    controller = "GRBL 1.1"
    tool_change = False


class Mach3MM(PostProcessor):
    id = "mach3_mm"
    name = "Mach3 / Mach4 générique (mm)"
    controller = "Mach3"
    tool_change = True

    def header(self, meta, tool, z_clear):
        return ["%"] + super().header(meta, tool, z_clear) + ["G40", "G49", "G80"]

    def footer(self, z_clear):
        return super().footer(z_clear) + ["%"]


POSTS = {p.id: p for p in (GrblMM(), Mach3MM())}


def get_post(post_id: str | None) -> PostProcessor | None:
    return POSTS.get(post_id or "")


def list_posts() -> list[dict]:
    return [{"id": p.id, "name": p.name, "version": p.version, "controller": p.controller,
             "tool_change": p.tool_change} for p in POSTS.values()]


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")
