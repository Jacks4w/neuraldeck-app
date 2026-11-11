#!/usr/bin/env node
// Genera manifest.json da una cartella di trascrizioni (.txt/.md/.srt/.vtt).
// Uso: node scripts/make-manifest.mjs <cartella> [--base-url URL] [--course "Nome corso"] [--out manifest.json]
// Senza --base-url gli URL sono relativi al manifest (funziona se manifest e file stanno nello stesso repo/cartella).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
};
const dir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!dir) {
    console.error("Uso: node scripts/make-manifest.mjs <cartella> [--base-url URL] [--course NOME] [--out FILE]");
    process.exit(1);
}
const out = opt("--out", path.join(dir, "..", "manifest.json"));
const baseUrl = opt("--base-url", null);
const relDir = path.relative(path.dirname(path.resolve(out)), path.resolve(dir)).split(path.sep).join("/");

const files = fs.readdirSync(dir).filter((f) => /\.(txt|md|srt|vtt)$/i.test(f)).sort();
const transcripts = files.map((f, i) => {
    const buf = fs.readFileSync(path.join(dir, f));
    const firstLine = buf.toString("utf8").split(/\r?\n/).find((l) => l.trim()) ?? f;
    const m = firstLine.match(/^lesson\s*(\d+)\s*[-–:]\s*(.+)$/i);
    return {
        id: path.basename(f).replace(/\.[^.]+$/, ""),
        lesson: m ? Number(m[1]) : i + 1,
        title: (m ? m[2] : firstLine).trim().slice(0, 100),
        url: baseUrl ? baseUrl.replace(/\/$/, "") + "/" + encodeURIComponent(f) : `${relDir ? relDir + "/" : ""}${encodeURIComponent(f)}`,
        sha256: crypto.createHash("sha256").update(buf).digest("hex")
    };
});
const manifest = {course: opt("--course", "Synthesizers"), version: new Date().toISOString().slice(0, 10), transcripts};
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`manifest scritto: ${out} (${transcripts.length} trascrizioni)`);
