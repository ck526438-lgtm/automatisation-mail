/**
 * Lecture CSV tolérante (séparateur , ou ; détecté, guillemets, BOM) et mapping de colonnes.
 */

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  email: ["email", "e-mail", "mail", "courriel", "adresse email", "adresse e-mail", "email address"],
  first_name: ["first_name", "prenom", "prénom", "firstname", "first name"],
  last_name: ["last_name", "nom", "lastname", "last name", "nom de famille"],
  company: ["company", "societe", "société", "entreprise", "organisation", "organization"],
  title: ["title", "poste", "fonction", "job title", "titre"],
  phone: ["phone", "telephone", "téléphone", "tel", "mobile"],
  country: ["country", "pays"],
};

/** Propose un mapping colonne du fichier → champ standard (les autres deviennent des champs personnalisés). */
export function suggestMapping(headers: string[]): Record<number, string> {
  const mapping: Record<number, string> = {};
  const used = new Set<string>();
  headers.forEach((h, i) => {
    const norm = h.trim().toLowerCase();
    const field = Object.entries(ALIASES).find(([, names]) => names.includes(norm))?.[0];
    if (field && !used.has(field)) {
      mapping[i] = field;
      used.add(field);
    } else {
      mapping[i] = `custom:${norm.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `col_${i}`}`;
    }
  });
  return mapping;
}

export interface MappedRow {
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  title?: string;
  phone?: string;
  country?: string;
  custom_fields: Record<string, string>;
}

export function applyMapping(rows: string[][], mapping: Record<number, string>): MappedRow[] {
  return rows.map((r) => {
    const out: MappedRow = { email: "", custom_fields: {} };
    r.forEach((value, i) => {
      const target = mapping[i];
      if (!target || target === "ignore") return;
      const v = value.trim();
      if (target.startsWith("custom:")) {
        if (v) out.custom_fields[target.slice(7)] = v;
      } else (out as unknown as Record<string, string>)[target] = v;
    });
    return out;
  });
}
