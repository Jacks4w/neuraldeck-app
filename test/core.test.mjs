import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import {VectorStore} from "../src/main/vectorstore.js";
import {runUpdate, planUpdate, parseManifest, normalizeShareUrl, rebuildIndex} from "../src/main/updater.js";
import {chunkText, cleanTranscript} from "../src/main/textutils.js";
import {detectLanguage, buildUserPrompt, uniqueSources} from "../src/main/rag.js";
import {recommendTier} from "../src/main/catalog.js";
import {ConversationStore, autoTitle} from "../src/main/stores.js";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "nd-"));

// Embedder finto deterministico: bag-of-words su 64 dimensioni
function fakeEmbed(texts) {
    return Promise.resolve(texts.map((t) => {
        const v = new Array(64).fill(0);
        for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 64, 7)] += 1;
        return v;
    }));
}

/** Server HTTP di test con contenuti modificabili e contatore delle richieste. */
function startServer(files) {
    const hits = {};
    const server = http.createServer((req, res) => {
        const p = decodeURIComponent(req.url.split("?")[0]);
        hits[p] = (hits[p] ?? 0) + 1;
        if (!(p in files)) return res.writeHead(404).end("nope");
        res.writeHead(200, {"Content-Type": "text/plain"}).end(files[p]);
    });
    return new Promise((r) => server.listen(0, "127.0.0.1", () => r({server, hits, base: `http://127.0.0.1:${server.address().port}`})));
}

test("normalizeShareUrl converts share links", () => {
    assert.equal(normalizeShareUrl("https://drive.google.com/file/d/ABC123/view?usp=sharing"), "https://drive.google.com/uc?export=download&id=ABC123");
    assert.equal(normalizeShareUrl("https://drive.google.com/open?id=XYZ"), "https://drive.google.com/uc?export=download&id=XYZ");
    assert.equal(normalizeShareUrl("https://www.dropbox.com/scl/fi/abc/l1.txt?rlkey=k&dl=0"), "https://www.dropbox.com/scl/fi/abc/l1.txt?rlkey=k&dl=1");
    assert.equal(normalizeShareUrl("https://github.com/u/r/blob/main/t/l1.txt"), "https://raw.githubusercontent.com/u/r/main/t/l1.txt");
    assert.equal(normalizeShareUrl("https://example.com/a.txt"), "https://example.com/a.txt");
});

test("parseManifest validates", () => {
    assert.throws(() => parseManifest("{bad"), /JSON/);
    assert.throws(() => parseManifest({transcripts: [{id: "a"}]}), /url/);
    assert.throws(() => parseManifest({transcripts: [{id: "a", url: "x"}, {id: "a", url: "y"}]}), /duplicato/);
    const m = parseManifest([{url: "a.txt"}]);
    assert.equal(m.transcripts[0].id, "a.txt");
});

test("cleanTranscript strips SRT timing", () => {
    const srt = "1\n00:00:01,000 --> 00:00:03,000\nHello <i>class</i>\n\n2\n00:00:03,500 --> 00:00:05,000\nToday: filters.\n";
    assert.equal(cleanTranscript(srt, "x.srt"), "Hello class Today: filters.");
});

test("chunkText produces overlapping bounded chunks", () => {
    const text = Array.from({length: 80}, (_, i) => `Sentence number ${i} talks about oscillators and filters.`).join(" ");
    const chunks = chunkText(text, {maxChars: 400, overlap: 80});
    assert.ok(chunks.length > 5);
    for (const c of chunks) assert.ok(c.length <= 480, `chunk too long: ${c.length}`);
    assert.ok(chunks.join(" ").includes("Sentence number 79"));
});

test("incremental update: add, unchanged, modify, remove, hash mismatch, no-hash items", async () => {
    const dir = tmp();
    const files = {
        "/t/l1.txt": "Lesson one. Oscillators make sound. Sawtooth has all harmonics.",
        "/t/l2.txt": "Lesson two. Filters remove frequencies. Resonance boosts the cutoff.",
        "/t/l3.srt": "1\n00:00:01,000 --> 00:00:02,000\nEnvelopes have attack decay sustain release.\n"
    };
    const manifest = (extra = {}) => JSON.stringify({
        course: "Synth Test",
        transcripts: [
            {id: "l1", title: "Oscillators", lesson: 1, url: "t/l1.txt", sha256: sha(files["/t/l1.txt"])},
            {id: "l2", title: "Filters", lesson: 2, url: "t/l2.txt", version: extra.v2 ?? 1},
            {id: "l3", title: "Envelopes", lesson: 3, url: "t/l3.srt"}, // senza hash né versione
            ...(extra.more ?? [])
        ]
    });
    files["/manifest.json"] = manifest();
    const {server, hits, base} = await startServer(files);
    try {
        const store = new VectorStore(path.join(dir, "index", "v.json")).load();
        const common = {manifestUrl: `${base}/manifest.json`, store, transcriptsDir: path.join(dir, "tr"), embedPassages: fakeEmbed, embedModelId: "fake"};

        // 1) primo sync: tutto nuovo
        let r = await runUpdate(common);
        assert.deepEqual(r.added.sort(), ["l1", "l2", "l3"]);
        assert.equal(r.errors.length, 0);
        assert.equal(store.listLessons().length, 3);
        assert.ok(!store.getLesson("l3").chunks[0].text.includes("-->"), "SRT cleaned");
        assert.ok(fs.existsSync(path.join(dir, "tr", "l1.txt")));

        // 2) secondo sync: niente da scaricare per l1 (hash) e l2 (versione); l3 riscaricato ma invariato
        r = await runUpdate(common);
        assert.deepEqual(r.added, []);
        assert.deepEqual(r.updated, []);
        assert.deepEqual(r.unchanged.sort(), ["l1", "l2", "l3"]);
        assert.equal(hits["/t/l1.txt"], 1);
        assert.equal(hits["/t/l2.txt"], 1);
        assert.equal(hits["/t/l3.srt"], 2);

        // 3) persistenza: un nuovo store ricarica l'indice dal disco
        const reloaded = new VectorStore(path.join(dir, "index", "v.json")).load();
        assert.equal(reloaded.chunkCount, store.chunkCount);
        assert.equal(reloaded.getLesson("l1").chunks[0].vector.length, 64);

        // 4) modifiche: l1 nuovo contenuto+hash, l2 versione 2, l3 contenuto cambiato, l4 nuovo con hash sbagliato, l5 404
        files["/t/l1.txt"] = "Lesson one REVISED. Square waves have odd harmonics only.";
        files["/t/l3.srt"] = "1\n00:00:01,000 --> 00:00:02,000\nLFO means low frequency oscillator.\n";
        files["/t/l4.txt"] = "Lesson four. FM synthesis.";
        files["/manifest.json"] = manifest({v2: 2, more: [
            {id: "l4", title: "FM", url: "t/l4.txt", sha256: "0".repeat(64)},
            {id: "l5", title: "Missing", url: "t/missing.txt"}
        ]}).replace(sha("Lesson one. Oscillators make sound. Sawtooth has all harmonics."), sha(files["/t/l1.txt"]));
        r = await runUpdate(common);
        assert.deepEqual(r.updated.sort(), ["l1", "l2", "l3"]);
        assert.deepEqual(r.errors.map((e) => e.id).sort(), ["l4", "l5"]);
        assert.match(r.errors.find((e) => e.id === "l4").error, /SHA-256/);
        assert.match(r.errors.find((e) => e.id === "l5").error, /404/);
        assert.ok(store.getLesson("l1").chunks[0].text.includes("REVISED"));
        assert.equal(store.getLesson("l4"), null);

        // 5) rimozione: l2 sparisce dal manifest
        files["/manifest.json"] = JSON.stringify({transcripts: [{id: "l1", title: "Oscillators", url: "t/l1.txt", sha256: sha(files["/t/l1.txt"])}, {id: "l3", title: "Envelopes", url: "t/l3.srt"}]});
        r = await runUpdate(common);
        assert.deepEqual(r.removed, ["l2"]);
        assert.equal(store.getLesson("l2"), null);
        assert.ok(!fs.existsSync(path.join(dir, "tr", "l2.txt")));

        // 6) planUpdate puro
        const plan = planUpdate(parseManifest(files["/manifest.json"]), store);
        assert.equal(plan.unchanged.length, 1);
        assert.equal(plan.check.length, 1);

        // 7) cambio del modello di embedding => indice azzerato e ricostruito
        r = await runUpdate({...common, embedModelId: "fake-v2"});
        assert.deepEqual(r.added.sort(), ["l1", "l3"]);
        assert.equal(store.data.embedModelId, "fake-v2");

        // 8) rebuild offline dalle copie locali
        const n = await rebuildIndex({store, transcriptsDir: common.transcriptsDir, embedPassages: fakeEmbed, embedModelId: "fake-v3"});
        assert.equal(n, 2);

        // 9) retrieval sul vettore finto
        const [q] = await fakeEmbed(["low frequency oscillator LFO"]);
        assert.equal(store.search([q], 1)[0].lessonId, "l3");
    } finally {
        server.close();
    }
});

test("manifest returning HTML is rejected with a clear error", async () => {
    const {server, base} = await startServer({"/m": "<!DOCTYPE html><html>login</html>"});
    try {
        const store = new VectorStore(path.join(tmp(), "v.json"));
        await assert.rejects(runUpdate({manifestUrl: `${base}/m`, store, transcriptsDir: tmp(), embedPassages: fakeEmbed}), /HTML/);
    } finally {
        server.close();
    }
});

test("bundled sample manifest works via file:// and hashes match", async () => {
    const dir = tmp();
    const store = new VectorStore(path.join(dir, "v.json"));
    const url = new URL("../sample/manifest.json", import.meta.url).toString();
    const r = await runUpdate({manifestUrl: url, store, transcriptsDir: path.join(dir, "tr"), embedPassages: fakeEmbed, embedModelId: "fake"});
    assert.equal(r.added.length, 3);
    assert.equal(r.errors.length, 0);
    assert.equal(r.course, "Synthesizers 101 (demo)");
});

test("language detection", () => {
    const cases = {
        ita: "Come funziona la risonanza di un filtro passa basso?",
        hrv: "Kako radi rezonancija niskopropusnog filtra?",
        tur: "Alçak geçiren filtrenin rezonansı nasıl çalışır?",
        rus: "Как работает резонанс фильтра низких частот?",
        cmn: "低通滤波器的共振是如何工作的？",
        spa: "¿Cómo funciona la resonancia de un filtro paso bajo?",
        eng: "How does the resonance of a low-pass filter work?"
    };
    for (const [code, q] of Object.entries(cases)) assert.equal(detectLanguage([q])?.code, code, q);
    assert.equal(detectLanguage(["ok"]), null);
    // il messaggio corrente prevale sulla cronologia in un'altra lingua (bug trovato nel test GUI)
    assert.equal(detectLanguage(["бъясни подробно все этапы огибающей ADSR", "Come funziona la risonanza di un filtro passa-basso?"]).code, "rus");
    assert.equal(detectLanguage(["Explain every stage of the ADSR envelope in detail", "Come funziona la risonanza di un filtro passa-basso?"]).code, "eng");
    assert.equal(detectLanguage(["e il decay?", "Come funziona la risonanza di un filtro passa-basso?"]).code, "ita");
});

test("prompt contains sources and language", () => {
    const p = buildUserPrompt({question: "Cos'è un LFO?", sources: [{title: "Envelopes", lesson: 3, text: "LFO is..."}], language: {name: "Italian"}});
    assert.match(p, /Lesson 3: Envelopes/);
    assert.match(p, /Italian/);
    const u = uniqueSources([{lessonId: "a", title: "A", score: 0.8}, {lessonId: "a", title: "A", score: 0.9}, {lessonId: "b", title: "B", score: 0.7}]);
    assert.equal(u.length, 2);
    assert.equal(u[0].score, 0.9);
});

test("recommendTier", () => {
    const G = 1024 ** 3;
    assert.equal(recommendTier({ramBytes: 4 * G}), "lite");
    assert.equal(recommendTier({ramBytes: 7.8 * G}), "standard");
    assert.equal(recommendTier({ramBytes: 6 * G, gpu: "vulkan", vramBytes: 6 * G}), "standard");
    assert.equal(recommendTier({ramBytes: 6 * G, gpu: "vulkan", vramBytes: 2 * G}), "lite");
});

test("conversation store reuses empty sessions and auto-titles", () => {
    const cs = new ConversationStore(tmp());
    const a = cs.create();
    const b = cs.create();
    assert.equal(a.id, b.id, "no duplicate empty 'New Chat'");
    a.messages.push({role: "user", content: "x"});
    a.title = autoTitle("What is the difference between a sawtooth and a square wave?");
    cs.save(a);
    assert.notEqual(cs.create().id, a.id);
    assert.ok(a.title.length <= 42);
    assert.throws(() => cs.get("../../etc/passwd"));
});

test("sample manifest still validates when transcripts have Windows CRLF line endings", async () => {
    const {pathToFileURL} = await import("node:url");
    const src = new URL("../sample/", import.meta.url);
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "sample", "transcripts"), {recursive: true});
    fs.copyFileSync(new URL("manifest.json", src), path.join(dir, "sample", "manifest.json"));
    for (const f of fs.readdirSync(new URL("transcripts/", src))) {
        const lf = fs.readFileSync(new URL(`transcripts/${f}`, src), "utf8").replace(/\r\n/g, "\n");
        fs.writeFileSync(path.join(dir, "sample", "transcripts", f), lf.replace(/\n/g, "\r\n"));
    }
    const store = new VectorStore(path.join(dir, "v.json"));
    const r = await runUpdate({manifestUrl: pathToFileURL(path.join(dir, "sample", "manifest.json")).toString(), store, transcriptsDir: path.join(dir, "tr"), embedPassages: fakeEmbed, embedModelId: "fake"});
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.added.length, 3);
});
