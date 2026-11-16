import { createHash } from "node:crypto";

export const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const safeReference = (value) => String(value).replace(/[^0-9A-Za-z_-]/g, "_");
const clean = (value) => typeof value === "string" ? value.trim() : "";
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A sheet describes actual parts and their route. No default material or machine.
export function sheetQuestions(sheet) {
  const questions = [];
  if (!clean(sheet?.title)) questions.push("Quel meuble faut-il fabriquer (title) ?");
  if (sheet?.units !== "mm") questions.push("Confirmer les dimensions en millimètres (units = mm).");
  if (!Array.isArray(sheet?.parts) || !sheet.parts.length) return [...questions, "Fournir la liste des pièces (parts)."];
  if (sheet.parts.length > 500) return [...questions, "Limiter la fiche à 500 références de pièces."];
  const refs = new Set();
  for (const part of sheet.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) { questions.push("Chaque pièce doit être un objet structuré."); continue; }
    const ref = clean(part?.ref);
    if (!ref || refs.has(ref)) questions.push("Chaque pièce doit avoir une référence unique (ref).");
    refs.add(ref);
    if (!clean(part?.name) || !clean(part?.material)) questions.push(`${ref} : préciser la désignation et le matériau.`);
    if (![part?.length, part?.width, part?.thickness].every(positive)) questions.push(`${ref} : fournir longueur, largeur et épaisseur réelles positives en mm.`);
    if (!Number.isInteger(part?.quantity) || part.quantity < 1 || part.quantity > 10000) questions.push(`${ref} : fournir une quantité entière de 1 à 10000.`);
    if (part?.confirmed !== true) questions.push(`${ref} : confirmer les cotes, le matériau et le détail de la pièce (confirmed).`);
    if (!Array.isArray(part?.operations) || !part.operations.length) questions.push(`${ref} : préciser les opérations nécessaires.`);
    const operations = Array.isArray(part.operations) ? part.operations : [];
    for (const op of operations) {
      if (!["cnc", "sciage_panneaux", "rabotage", "autre"].includes(op?.type) || !clean(op?.machine) || !clean(op?.instructions)) {
        questions.push(`${ref} : pour chaque opération, préciser type (cnc, sciage_panneaux, rabotage, autre), machine et instructions.`);
      }
      if (op?.type === "cnc" && !clean(part?.materialId)) questions.push(`${ref} : indiquer la référence matière du profil CNC (materialId).`);
    }
    if (operations.some((op) => ["cnc", "sciage_panneaux"].includes(op?.type)) && typeof part.grain !== "boolean") questions.push(`${ref} : préciser si le sens du fil ou du décor doit être respecté (grain : true/false).`);
    if (operations.some((op) => op?.type === "cnc") && (!clean(part.contour?.shape) || !Array.isArray(part.features))) questions.push(`${ref} : décrire le contour CNC (contour.shape, rectangle si confirmé) et les usinages (features, liste vide si aucun).`);
    if (operations.some((op) => op?.type === "sciage_panneaux") && part.contour?.shape && part.contour.shape !== "rectangle") questions.push(`${ref} : le calepinage scie nécessite un débit rectangulaire ; décrire séparément l'opération de mise en forme.`);
    if (operations.some((op) => op?.type === "rabotage") && (!part.rough || ![part.rough.length, part.rough.width, part.rough.thickness].every(positive) || part.rough.length < part.length || part.rough.width < part.width || part.rough.thickness < part.thickness)) questions.push(`${ref} : fournir les dimensions brutes avant rabotage (rough.length, width, thickness), au moins égales aux dimensions finies.`);
    if (operations.some((op) => op?.type === "sciage_panneaux")) {
      const stock = part.stock;
      if (!stock || ![stock.length, stock.width].every(positive) || !positive(stock.kerf) || !Number.isFinite(stock.margin) || stock.margin < 0) {
        questions.push(`${ref} : fournir le panneau disponible (stock.length, width, margin) et le trait de scie réel (stock.kerf), en mm.`);
      }
    }
    if (part?.position && (!["xy", "xz", "yz"].includes(part.position.plane) || ![part.position.x, part.position.y, part.position.z].every(Number.isFinite) || part.quantity !== 1)) {
      questions.push(`${ref} : une position 3D exige x, y, z numériques, plane = xy/xz/yz et une référence par occurrence (quantity = 1).`);
    }
  }
  if (sheet.parts.reduce((sum, p) => sum + (p?.quantity || 0), 0) > 10000) questions.push("Limiter le dossier à 10000 pièces.");
  return questions;
}

export function cncRequest(sheet) {
  const parts = sheet.parts.filter((p) => p.operations.some((op) => op.type === "cnc"));
  return { furniture: "pieces_libres", params: {
    quantite: { value: "1", source: "fourni" },
    pieces: { value: JSON.stringify(parts.map((p) => ({
      name: `${p.ref} — ${p.name}`, length: p.length, width: p.width, qty: p.quantity,
      material: p.materialId, source: "fourni", grain: p.grain === true,
      rotation_allowed: p.rotationAllowed === true,
      features: p.features ?? [], ...(p.contour ? { contour: p.contour } : {}),
      assembly: p.assembly ?? "", note: `Référence fiche technique : ${p.ref}`
    }))), source: "fourni" }
  } };
}

export function documentHtml(title, body) {
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:15px Arial,sans-serif;max-width:1100px;margin:32px auto;color:#172331}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{border:1px solid #aab4bf;padding:9px;text-align:left}pre{white-space:pre-wrap}svg{max-width:100%;height:auto}h1{font-size:24px}@media print{body{margin:0}.operation{break-before:page}}</style><h1>${escape(title)}</h1>${body}</html>`;
}

function partsTable(parts) {
  return `<table><thead><tr><th>Pièce</th><th>Désignation</th><th>L × l × ép. finies (mm)</th><th>Brut avant rabotage (mm)</th><th>Qté</th><th>Matière</th></tr></thead><tbody>${parts.map((p) => `<tr><td>${escape(p.ref)}</td><td>${escape(p.name)}</td><td>${p.length} × ${p.width} × ${p.thickness}</td><td>${p.rough ? `${p.rough.length} × ${p.rough.width} × ${p.rough.thickness}` : "—"}</td><td>${p.quantity}</td><td>${escape(p.material)}</td></tr>`).join("")}</tbody></table>`;
}

export function technicalArtifacts(number, version, sheet) {
  const title = `BC ${number} — Fiche technique v${version} — ${sheet.title}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 ${sheet.parts.length * 180 + 40}"><title>${escape(title)} — vues des pièces, sans assemblage</title>${sheet.parts.map((p, i) => {
    const scale = Math.min(680 / p.length, 110 / p.width);
    return `<g transform="translate(30 ${i * 180 + 35})"><rect width="${p.length * scale}" height="${p.width * scale}" fill="#e5edf3" stroke="#172331"/><text y="-10">${escape(p.ref)} — ${escape(p.name)}</text><text y="135">${p.length} × ${p.width} × ${p.thickness} mm · Qté ${p.quantity}</text></g>`;
  }).join("")}</svg>`;
  // Exact cuboids in mm; an assembled view requires supplied positions.
  const obj = ["# H-KIDS — millimetres; volumes de référence, détails d'usinage dans les DXF", `# BC ${number} FT v${version}`, sheet.parts.every((p) => p.position) ? "# Positions fournies par la fiche technique" : "# Pièces séparées : assemblage non représenté"];
  let offset = 0, cursor = 0;
  for (const p of sheet.parts) {
    const pos = sheet.parts.every((part) => part.position) ? p.position : { x: cursor, y: 0, z: 0, plane: "xy" };
    const dims = pos.plane === "xz" ? [p.length, p.thickness, p.width] : pos.plane === "yz" ? [p.thickness, p.length, p.width] : [p.length, p.width, p.thickness];
    obj.push(`o ${safeReference(p.ref)}`);
    for (const [x, y, z] of [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]]) obj.push(`v ${pos.x + x * dims[0]} ${pos.y + y * dims[1]} ${pos.z + z * dims[2]}`);
    for (const face of [[4,3,2,1],[5,6,7,8],[1,2,6,5],[2,3,7,6],[3,4,8,7],[4,1,5,8]]) obj.push(`f ${face.map((v) => v + offset).join(" ")}`);
    offset += 8; cursor += p.length + 100;
  }
  return [
    { name: "fiche-technique.html", content: documentHtml(title, `${partsTable(sheet.parts)}<p>${escape(sheet.notes ?? "")}</p><p>Vues d'encombrement de pièces séparées. Les volumes 3D représentent les encombrements ; les plans CNC détaillés et les usinages sont fournis dans le dossier méthodes et les DXF.</p>${svg}`) },
    { name: "fiche-technique.json", content: JSON.stringify({ ...sheet, order: String(number), version }, null, 2) },
    { name: "plans-encombrement-2d.svg", content: svg },
    { name: "volumes-3d.obj", content: obj.join("\n") + "\n" }
  ];
}

// Deterministic shelf layout for rectangular saw parts, grouped by actual stock.
// Rotation only when the technical sheet explicitly permits it.
export function sawNesting(parts) {
  const groups = new Map();
  for (const p of parts.filter((p) => p.operations.some((op) => op.type === "sciage_panneaux"))) {
    const key = JSON.stringify([p.material, p.thickness, p.stock, p.grain === true]);
    if (!groups.has(key)) groups.set(key, { material: p.material, thickness: p.thickness, stock: p.stock, sheets: [] });
    const group = groups.get(key);
    const { length, width, margin, kerf } = group.stock;
    for (let occurrence = 1; occurrence <= p.quantity; occurrence++) {
      let placed = false;
      for (const sheet of [...group.sheets, null]) {
        const current = sheet ?? { number: group.sheets.length + 1, placements: [], x: margin, y: margin, row: 0 };
        const orientations = [[p.length, p.width, false], ...(p.rotationAllowed === true && !p.grain ? [[p.width, p.length, true]] : [])];
        for (const [l, w, rotated] of orientations) {
          let x = current.x, y = current.y, row = current.row;
          if (x + l > length - margin) { x = margin; y += row + kerf; row = 0; }
          if (x + l > length - margin || y + w > width - margin) continue;
          current.placements.push({ ref: p.ref, occurrence, x, y, length: l, width: w, rotated });
          Object.assign(current, { x: x + l + kerf, y, row: Math.max(row, w) });
          if (!sheet) group.sheets.push(current);
          placed = true;
          break;
        }
        if (placed) break;
      }
      if (!placed) throw new Error(`${p.ref} : la pièce ne tient pas sur le panneau disponible avec les marges et le sens du fil.`);
    }
  }
  return [...groups.values()].map((g) => ({ ...g, sheets: g.sheets.map(({ x: _x, y: _y, row: _row, ...sheet }) => sheet) }));
}

export function fabricationArtifacts(number, version, technicalSheet) {
  const sheet = technicalSheet.data;
  const title = `BC ${number} — Dossier de fabrication v${version} — FT v${technicalSheet.version}`;
  const operations = sheet.parts.flatMap((p) => p.operations.map((op, index) => ({
    id: `OP${String(sheet.parts.indexOf(p) + 1).padStart(3, "0")}-${index + 1}`,
    order: String(number), technicalSheetId: technicalSheet.id, technicalSheetVersion: technicalSheet.version,
    part: p.ref, quantity: p.quantity, dimensions: [p.length, p.width, p.thickness], material: p.material,
    sequence: index + 1, type: op.type, machine: op.machine, instructions: op.instructions, checks: op.checks
  })));
  const nesting = sawNesting(sheet.parts);
  const files = [
    { name: "liste-pieces.csv", content: "\ufeffRéférence;Désignation;Longueur mm;Largeur mm;Épaisseur mm;Quantité;Matière\n" + sheet.parts.map((p) => [p.ref, p.name, p.length, p.width, p.thickness, p.quantity, p.material].map((s) => `"${String(s).replace(/"/g, '""')}"`).join(";")).join("\n") },
    { name: "fiche-debit.html", content: documentHtml(title + " — Débit", partsTable(sheet.parts) + "<p>Exécuter uniquement les opérations indiquées dans les fiches de poste, dans leur ordre pour chaque pièce.</p>") },
    { name: "calepinage-scie.json", content: JSON.stringify(nesting, null, 2) }
  ];
  let layouts = "";
  for (const group of nesting) for (const panel of group.sheets) {
    layouts += `<h2>${escape(group.material)} — ${group.thickness} mm — panneau ${panel.number}</h2><p>Panneau ${group.stock.length} × ${group.stock.width} mm ; marge ${group.stock.margin} mm ; trait de scie ${group.stock.kerf} mm. Origine : coin supérieur gauche. Coordonnées en mm.</p><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${group.stock.length} ${group.stock.width}"><rect width="100%" height="100%" fill="white" stroke="black"/>${panel.placements.map((p) => `<rect x="${p.x}" y="${p.y}" width="${p.length}" height="${p.width}" fill="#e5edf3" stroke="black"/><text x="${p.x + 10}" y="${p.y + 35}" font-size="28">${escape(p.ref)} #${p.occurrence}</text>`).join("")}</svg><pre>${escape(panel.placements.map((p) => `${p.ref} #${p.occurrence} : X=${p.x}, Y=${p.y}, ${p.length} × ${p.width}${p.rotated ? ", tournée 90°" : ""}`).join("\n"))}</pre>`;
  }
  files.push({ name: "calepinage-scie.html", content: documentHtml(title + " — Calepinage scie", layouts || "<p>Aucune découpe à la scie à panneaux prévue dans la fiche technique.</p>") });
  for (const op of operations) files.push({ name: `${op.id}.html`, content: documentHtml(`${title} — ${op.id}`, `<p>Poste : <strong>${escape(op.machine)}</strong> · ${escape(op.type)} · ordre ${op.sequence} pour cette pièce</p>${partsTable(sheet.parts.filter((p) => p.ref === op.part))}<h2>Instructions</h2><pre>${escape(op.instructions)}</pre><p>Contrôles : ${escape(op.checks ?? "Contrôler les dimensions de la fiche technique et signaler tout écart avant la suite.")}</p>${op.type === "cnc" ? "<p>Attendre les DXF validés, puis le G-code simulé et la validation du responsable atelier avant utilisation.</p>" : ""}`) });
  const manifest = { order: String(number), version, technicalSheetId: technicalSheet.id, technicalSheetVersion: technicalSheet.version, parts: sheet.parts, operations, sawNesting: nesting };
  files.push({ name: "dossier.json", content: JSON.stringify(manifest, null, 2) });
  files.push({ name: "dossier-fabrication.html", content: documentHtml(title, `${partsTable(sheet.parts)}<h2>Fiches par opération</h2><table><tr><th>Fiche</th><th>Pièce</th><th>Machine</th><th>Ordre</th><th>Instructions</th></tr>${operations.map((op) => `<tr><td>${escape(op.id)}</td><td>${escape(op.part)}</td><td>${escape(op.machine)}</td><td>${op.sequence}</td><td>${escape(op.instructions)}</td></tr>`).join("")}</table>${layouts}`) });
  return { operations, files, manifest };
}
