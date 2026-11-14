import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// The drafting engine of the "dessinateur méthodes" (dessinateur/, Python):
// from a piece of furniture and its dimensions, the numbered parts, the cut
// list, the nesting on the workshop's panels and one DXF per panel (R2010, mm,
// 1:1, one layer per operation). The Production agent drives it; the engine
// computes every dimension, never the language model.
//
// Its safety rules are kept: no DXF while a dimension, a material thickness or
// an assembly method is still "à confirmer"; no G-code while the machine, its
// cutters and the fixing are not confirmed, while the post-processor has not
// passed the pilot program on this very machine, or while the simulation of a
// file finds an error. The workshop profile (real thicknesses, clearances, the
// CNC and its cutters) and the qualifications are kept here, in
// data/atelier-profil.json, and change only by what the workshop reported.

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DESIGN_ENGINE_DIR = join(PROJECT_ROOT, "dessinateur");
const DEFAULT_TIMEOUT_MS = 60_000;
// The profile in force, what changed it, and the post-processor's
// qualifications (the pilot program machined on the real CNC).
const EMPTY = Object.freeze({ profile: null, history: [], pilot: null, qualifications: [] });

export class DesignOfficeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DesignOfficeError";
    this.code = code;
  }
}

export function createFileDesignProfileBook({ path = join(DATA_DIR, "atelier-profil.json") } = {}) {
  return createFileJsonBook(path, EMPTY);
}

export function createMemoryDesignProfileBook() {
  return createMemoryJsonBook(EMPTY);
}

export function defaultPython(env = process.env) {
  const configured = typeof env.DESSINATEUR_PYTHON === "string" ? env.DESSINATEUR_PYTHON.trim() : "";
  return configured || (process.platform === "win32" ? "python" : "python3");
}

// One request to the engine: JSON in, JSON out, nothing kept by Python.
export function runEngine(request, { python = defaultPython(), engineDir = DESIGN_ENGINE_DIR, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(python, ["-m", "hkids.bridge"], { cwd: engineDir, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, windowsHide: true });
    } catch (error) {
      reject(notInstalled(error));
      return;
    }
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new DesignOfficeError("Le moteur de dessin n'a pas répondu à temps.", "DESIGN_ENGINE_TIMEOUT"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(notInstalled(error));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString("utf8");
      if (code !== 0) {
        const detail = Buffer.concat(err).toString("utf8").trim().split("\n").at(-1) ?? "";
        reject(new DesignOfficeError(/No module named/.test(detail)
          ? `Le moteur de dessin n'est pas installé sur ce poste (${detail}) : pip install -r dessinateur/requirements.txt.`
          : `Le moteur de dessin s'est arrêté : ${detail || `code ${code}`}.`, "DESIGN_ENGINE_FAILED"));
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        reject(new DesignOfficeError("Réponse illisible du moteur de dessin.", "DESIGN_ENGINE_FAILED"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

function notInstalled(error) {
  return new DesignOfficeError(
    error?.code === "ENOENT"
      ? "Le moteur de dessin n'est pas installé sur ce poste : Python est introuvable (DESSINATEUR_PYTHON)."
      : `Le moteur de dessin n'a pas pu démarrer : ${error?.message ?? error}.`,
    "DESIGN_ENGINE_UNAVAILABLE"
  );
}

export function createDesignOffice({ book = createMemoryDesignProfileBook(), engine = (request) => runEngine(request), clock = () => new Date() } = {}) {
  // The profile in force; the engine's starting values the first time.
  async function currentProfile() {
    const stored = (await book.load()).profile;
    if (stored) {
      return stored;
    }
    const initial = await engine({ action: "profil_initial" });
    if (!initial?.ok) {
      throw new DesignOfficeError(initial?.erreur ?? "Profil d'atelier indisponible.", "DESIGN_PROFILE_UNAVAILABLE");
    }
    await book.change((state) => {
      state.profile ??= initial.profil;
    });
    return (await book.load()).profile;
  }

  return Object.freeze({
    async readProfile() {
      return engine({ action: "lire_profil", profil: await currentProfile() });
    },

    // A value the workshop measured or decided, recorded with who said it.
    async confirmProfile({ question, values = {}, by = "direction" }) {
      const answer = await engine({ action: "regler_profil", profil: await currentProfile(), question, valeurs: values });
      if (!answer?.ok) {
        return answer;
      }
      await book.change((state) => {
        state.profile = answer.profil;
        state.history = [...(state.history ?? []), { at: clock().toISOString(), by, question, values }];
      });
      return { ok: true };
    },

    async draw({ furniture, params = {} }) {
      return engine({ action: "dessiner", profil: await currentProfile(), meuble: furniture, parametres: params });
    },

    // The pilot program for the machine as configured. Its fingerprint is kept:
    // a result is recorded only for the program the workshop was given.
    async pilot() {
      const answer = await engine({ action: "pilote", profil: await currentProfile(), qualifications: (await book.load()).qualifications ?? [] });
      if (answer?.ok && answer.pret) {
        await book.change((state) => {
          state.pilot = { hash: answer.empreinte_pilote, post: answer.post, signature: answer.signature_machine, at: clock().toISOString() };
        });
      }
      return answer;
    },

    // What the operator saw when the pilot part was machined: conforming (the
    // post-processor is qualified on this machine) or not.
    async recordPilot({ conforming, notes = "", by = "direction" }) {
      const current = await engine({ action: "pilote", profil: await currentProfile(), qualifications: [] });
      if (!current?.ok || !current.pret) {
        return { ok: false, erreur: `Programme pilote non prêt : ${(current?.raisons ?? [current?.erreur]).join(" ; ")}` };
      }
      const prepared = (await book.load()).pilot;
      if (!prepared) {
        return { ok: false, erreur: "Aucun programme pilote n'a été préparé : le préparer et l'usiner d'abord." };
      }
      if (prepared.hash !== current.empreinte_pilote) {
        return { ok: false, erreur: "Les réglages de la machine ont changé depuis la préparation du programme pilote : le préparer à nouveau et le refaire." };
      }
      if (conforming && String(notes).trim().length < 10) {
        return { ok: false, erreur: "Dire ce qui a été contrôlé sur la pièce d'essai (cotes mesurées, état de coupe, profondeurs)." };
      }
      const entry = {
        post_id: current.post.id,
        post_version: current.post.version,
        machine_signature: current.signature_machine,
        statut: conforming ? "qualifie" : "echec",
        pilot_hash: current.empreinte_pilote,
        notes: String(notes).trim(),
        by,
        at: clock().toISOString()
      };
      await book.change((state) => {
        state.qualifications = [...(state.qualifications ?? []), entry];
      });
      return { ok: true, statut: entry.statut, post: current.post.nom };
    },

    async gcode({ furniture, params = {}, title = "" }) {
      return engine({ action: "gcode", profil: await currentProfile(), qualifications: (await book.load()).qualifications ?? [], meuble: furniture, parametres: params, titre: title });
    }
  });
}
