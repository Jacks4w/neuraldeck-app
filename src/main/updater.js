import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {sha256, cleanTranscript, chunkText, safeFileName} from "./textutils.js";

const toLf = (buf) => Buffer.from(buf.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");

/**
 * Converte i link di condivisione più comuni in link di download diretto.
 * - GitHub "blob" -> raw.githubusercontent.com
 * - Google Drive /file/d/ID/view, open?id=ID -> uc?export=download&id=ID
 * - Dropbox ?dl=0 -> ?dl=1
 */
export function normalizeShareUrl(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return url;
    }
    if (u.hostname === "github.com") {
        const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
        if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
    }
    if (u.hostname === "drive.google.com") {
        const m = u.pathname.match(/\/file\/d\/([^/]+)/);
        const id = m?.[1] ?? u.searchParams.get("id");
        if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    }
    if (u.hostname.endsWith("dropbox.com")) {
        u.searchParams.delete("dl");
        u.searchParams.set("dl", "1");
        return u.toString();
    }
    return url;
}

export function resolveUrl(url, baseUrl) {
    try {
        return new URL(url, baseUrl).toString();
    } catch {
        return url;
    }
}

/** Scarica un URL (http/https/file) e restituisce un Buffer. */
export async function fetchBuffer(url, {fetchImpl = globalThis.fetch, signal, timeoutMs = 60000} = {}) {
    if (url.startsWith("file:")) return fs.promises.readFile(fileURLToPath(url));
    if (!/^https?:/i.test(url) && fs.existsSync(url)) return fs.promises.readFile(url); // percorso locale
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "follow",
        headers: {"User-Agent": "NeuralDeck/0.1", "Cache-Control": "no-cache"}
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ""} su ${url}`.trim());
    return Buffer.from(await res.arrayBuffer());
}

function looksLikeHtml(buf) {
    const head = buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
    return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** Valida e normalizza il manifest. Lancia errori leggibili. */
export function parseManifest(input) {
    let m = input;
    if (typeof input === "string" || Buffer.isBuffer(input)) {
        try {
            m = JSON.parse(String(input).replace(/^\uFEFF/, ""));
        } catch (e) {
            throw new Error("Manifest non è un JSON valido: " + e.message);
        }
    }
    const list = Array.isArray(m) ? m : m?.transcripts ?? m?.lessons;
    if (!Array.isArray(list)) throw new Error('Manifest senza array "transcripts"');
    const seen = new Set();
    const transcripts = list.map((t, i) => {
        if (!t || typeof t !== "object") throw new Error(`Voce #${i + 1} non valida`);
        if (!t.url) throw new Error(`Voce #${i + 1}: manca "url"`);
        const id = String(t.id ?? t.url);
        if (seen.has(id)) throw new Error(`ID duplicato nel manifest: ${id}`);
        seen.add(id);
        return {
            id,
            title: String(t.title ?? id),
            url: String(t.url),
            sha256: t.sha256 ? String(t.sha256).toLowerCase() : null,
            version: t.version ?? null,
            lesson: t.lesson ?? null,
            date: t.date ?? null
        };
    });
    return {course: m?.course ?? null, version: m?.version ?? null, transcripts};
}

/** Decide cosa scaricare confrontando il manifest con l'indice locale. */
export function planUpdate(manifest, store) {
    const plan = {add: [], update: [], check: [], unchanged: [], remove: []};
    const ids = new Set();
    for (const item of manifest.transcripts) {
        ids.add(item.id);
        const local = store.getLesson(item.id);
        if (!local) plan.add.push(item);
        else if (item.sha256) (item.sha256 !== local.sha256 ? plan.update : plan.unchanged).push(item);
        else if (item.version != null)
            (String(item.version) !== String(local.version ?? "") || item.url !== local.url ? plan.update : plan.unchanged).push(item);
        else plan.check.push(item); // né hash né versione: scarico e confronto l'hash del contenuto
    }
    for (const lesson of store.listLessons()) if (!ids.has(lesson.id)) plan.remove.push(lesson);
    return plan;
}

/**
 * Esegue l'aggiornamento incrementale.
 * @param {object} o
 * @param {string} o.manifestUrl
 * @param {import('./vectorstore.js').VectorStore} o.store
 * @param {string} o.transcriptsDir  copia locale dei testi (serve per re-indicizzare offline)
 * @param {(texts: string[]) => Promise<Float32Array[]|number[][]>} o.embedPassages
 */
export async function runUpdate({manifestUrl, store, transcriptsDir, embedPassages, embedModelId, fetchImpl, signal,
    syncDeletions = true, onProgress = () => {}}) {
    const log = (msg, extra = {}) => onProgress({msg, ...extra});
    if (!manifestUrl) throw new Error("URL del manifest non configurato (Impostazioni)");
    const url = normalizeShareUrl(manifestUrl.trim());
    log(`> fetching manifest :: ${url}`);
    const manifestBuf = await fetchBuffer(url, {fetchImpl, signal});
    if (looksLikeHtml(manifestBuf))
        throw new Error("Il link del manifest restituisce una pagina HTML, non un file JSON. Usa un link diretto/raw pubblico.");
    const manifest = parseManifest(manifestBuf);

    if (embedModelId && store.data.embedModelId && store.data.embedModelId !== embedModelId) {
        log("> embedding model changed: wiping index");
        store.clear();
    }
    store.data.embedModelId = embedModelId ?? store.data.embedModelId;

    const plan = planUpdate(manifest, store);
    log(`> manifest OK :: ${manifest.transcripts.length} transcripts | new ${plan.add.length} | changed ${plan.update.length} | to-verify ${plan.check.length} | unchanged ${plan.unchanged.length}`);

    const result = {added: [], updated: [], unchanged: plan.unchanged.map((t) => t.id), removed: [], errors: [], course: manifest.course};
    const work = [...plan.add.map((t) => ["add", t]), ...plan.update.map((t) => ["update", t]), ...plan.check.map((t) => ["check", t])];
    fs.mkdirSync(transcriptsDir, {recursive: true});

    let i = 0;
    for (const [kind, item] of work) {
        signal?.throwIfAborted();
        i++;
        const itemUrl = normalizeShareUrl(resolveUrl(item.url, url));
        log(`> [${i}/${work.length}] downloading ${item.id}`, {current: i, total: work.length});
        try {
            const buf = await fetchBuffer(itemUrl, {fetchImpl, signal});
            if (looksLikeHtml(buf)) throw new Error("il link restituisce una pagina HTML (link non diretto o file non pubblico)");
            // Hash accettato sia sui byte originali sia con fine riga normalizzati (CRLF→LF):
            // Git su Windows, Drive o un editor possono convertire i fine riga senza cambiare il contenuto.
            const lfHash = sha256(toLf(buf));
            const okHashes = new Set([sha256(buf), lfHash]);
            if (item.sha256 && !okHashes.has(item.sha256)) throw new Error(`hash SHA-256 non corrisponde (atteso ${item.sha256.slice(0, 12)}..., ricevuto ${lfHash.slice(0, 12)}...)`);
            const hash = item.sha256 || lfHash;
            const local = store.getLesson(item.id);
            if (kind === "check" && local && local.sha256 === hash && local.title === item.title) {
                result.unchanged.push(item.id);
                log(`  = ${item.id} unchanged (content hash match)`);
                continue;
            }
            const text = cleanTranscript(buf.toString("utf8"), itemUrl);
            if (!text) throw new Error("file vuoto");
            const chunks = chunkText(text);
            log(`  ~ embedding ${chunks.length} chunks`);
            const vectors = await embedPassages(chunks.map((c) => `${item.title}. ${c}`));
            fs.writeFileSync(path.join(transcriptsDir, safeFileName(item.id) + ".txt"), text);
            store.upsertLesson({id: item.id, title: item.title, url: item.url, sha256: hash, version: item.version, lesson: item.lesson, date: item.date},
                chunks.map((t, k) => ({text: t, vector: vectors[k]})));
            store.save(); // salvataggio a ogni lezione: un'interruzione non perde il lavoro fatto
            (local ? result.updated : result.added).push(item.id);
            log(`  + ${item.id} indexed`);
        } catch (err) {
            if (signal?.aborted) throw err;
            result.errors.push({id: item.id, error: err.message});
            log(`  ! ${item.id} FAILED: ${err.message}`, {level: "error"});
        }
    }

    if (syncDeletions)
        for (const lesson of plan.remove) {
            store.removeLesson(lesson.id);
            fs.rmSync(path.join(transcriptsDir, safeFileName(lesson.id) + ".txt"), {force: true});
            result.removed.push(lesson.id);
            log(`  - ${lesson.id} removed (not in manifest anymore)`);
        }

    store.data.manifestUrl = manifestUrl;
    store.data.course = manifest.course ?? store.data.course;
    store.data.updatedAt = new Date().toISOString();
    store.save();
    log(`> sync complete :: +${result.added.length} ~${result.updated.length} -${result.removed.length} !${result.errors.length}`);
    return result;
}

/** Re-indicizza tutto dalle copie locali (es. dopo cambio del modello di embedding). */
export async function rebuildIndex({store, transcriptsDir, embedPassages, embedModelId, onProgress = () => {}}) {
    const lessons = store.listLessons();
    store.data.embedModelId = embedModelId;
    let n = 0;
    for (const meta of lessons) {
        const file = path.join(transcriptsDir, safeFileName(meta.id) + ".txt");
        if (!fs.existsSync(file)) {
            store.removeLesson(meta.id);
            continue;
        }
        const chunks = chunkText(fs.readFileSync(file, "utf8"));
        const vectors = await embedPassages(chunks.map((c) => `${meta.title}. ${c}`));
        const {chunkCount, indexedAt, ...clean} = meta;
        store.upsertLesson(clean, chunks.map((t, k) => ({text: t, vector: vectors[k]})));
        onProgress({msg: `  + reindexed ${meta.id}`, current: ++n, total: lessons.length});
    }
    store.save();
    return n;
}
