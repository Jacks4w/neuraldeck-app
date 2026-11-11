#!/usr/bin/env node
// Smoke test end-to-end con i modelli reali (fuori da Electron):
// indicizza le trascrizioni di esempio e pone domande in più lingue.
// Uso: MODELS_DIR=/percorso/modelli TIER=lite|standard node scripts/rag-smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {Engine} from "../src/main/engine.js";
import {VectorStore} from "../src/main/vectorstore.js";
import {runUpdate} from "../src/main/updater.js";
import {answerQuestion} from "../src/main/chat.js";
import {LLM_MODELS, EMBED_MODEL, recommendTier} from "../src/main/catalog.js";
import {DEFAULT_SETTINGS} from "../src/main/stores.js";

const modelsDir = process.env.MODELS_DIR || path.join(os.homedir(), "models");
const tier = process.env.TIER || "lite";
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "nd-smoke-"));
const engine = new Engine({modelsDir, log: console.log, buildFromSource: false});

const hw = await engine.detectHardware();
console.log("HW:", JSON.stringify({...hw, recommended: recommendTier(hw)}));

let t = Date.now();
const info = await engine.load(LLM_MODELS[tier], process.env.BACKEND || "auto", (s) => console.log("  status:", s));
console.log(`LOAD ${tier}: ${JSON.stringify(info)} in ${Date.now() - t} ms`);

const store = new VectorStore(path.join(work, "v.json"));
t = Date.now();
const r = await runUpdate({
    manifestUrl: pathToFileURL(path.resolve("sample/manifest.json")).toString(), store, transcriptsDir: path.join(work, "tr"),
    embedModelId: EMBED_MODEL.id, embedPassages: (x) => engine.embedPassages(x), onProgress: (p) => console.log(" ", p.msg)
});
console.log(`INDEX: +${r.added.length} chunks=${store.chunkCount} in ${Date.now() - t} ms`);

const questions = (process.env.QUESTIONS ? process.env.QUESTIONS.split("|") : [
    "What does the resonance parameter of a filter do?",
    "Che differenza c'è tra onda a dente di sega e onda quadra?",
    "¿Qué significa la S en un envolvente ADSR?",
    "什么是LFO？它可以调制哪些参数？",
    "Что такое самовозбуждение фильтра?",
    "Kako radi hard sync između oscilatora?",
    "Filtrede 24 dB/oktav eğim ne anlama geliyor?",
    "Chi ha vinto il campionato di calcio nel 2010?"
]);
const settings = {...DEFAULT_SETTINGS, courseName: r.course, translateQuery: process.env.TRANSLATE !== "0"};
for (const q of questions) {
    t = Date.now();
    let first = 0;
    const ans = await answerQuestion({engine, store, settings, history: [], question: q, onChunk: () => (first ||= Date.now() - t)});
    console.log("\n================================================================");
    console.log("Q:", q);
    console.log(`lang=${ans.language} translated=${JSON.stringify(ans.translatedQuery)} first-token=${first}ms total=${Date.now() - t}ms`);
    console.log("SOURCES:", ans.sources.map((s) => `${s.label} (${s.score.toFixed(3)})`).join(" | "));
    console.log("A:", ans.content);
}
await engine.unload();
fs.rmSync(work, {recursive: true, force: true});
process.exit(0);
