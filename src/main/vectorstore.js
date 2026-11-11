import fs from "node:fs";
import path from "node:path";

const SCHEMA = 1;

function encodeVector(vec) {
    return Buffer.from(new Float32Array(vec).buffer).toString("base64");
}
function decodeVector(b64) {
    const buf = Buffer.from(b64, "base64");
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
export function normalize(vec) {
    let n = 0;
    for (const v of vec) n += v * v;
    n = Math.sqrt(n) || 1;
    return Float32Array.from(vec, (v) => v / n);
}
function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

/**
 * Indice vettoriale minimale su file JSON (ricerca esaustiva per similarità coseno).
 * Per un corso (decine di lezioni, migliaia di chunk) è più che sufficiente.
 */
export class VectorStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = {schema: SCHEMA, embedModelId: null, manifestUrl: null, course: null, updatedAt: null, lessons: {}};
    }

    load() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            if (raw.schema !== SCHEMA) throw new Error("schema mismatch");
            for (const lesson of Object.values(raw.lessons ?? {}))
                for (const c of lesson.chunks) c.vector = decodeVector(c.vector);
            this.data = raw;
        } catch (err) {
            if (err.code !== "ENOENT") console.warn("[store] index unreadable, starting empty:", err.message);
        }
        return this;
    }

    save() {
        const out = {...this.data, lessons: {}};
        for (const [id, lesson] of Object.entries(this.data.lessons))
            out.lessons[id] = {...lesson, chunks: lesson.chunks.map((c) => ({...c, vector: encodeVector(c.vector)}))};
        fs.mkdirSync(path.dirname(this.filePath), {recursive: true});
        const tmp = this.filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(out));
        fs.renameSync(tmp, this.filePath);
    }

    getLesson(id) {
        return this.data.lessons[id] ?? null;
    }

    upsertLesson(meta, chunks) {
        this.data.lessons[meta.id] = {
            ...meta,
            indexedAt: new Date().toISOString(),
            chunks: chunks.map((c) => ({text: c.text, vector: normalize(c.vector)}))
        };
    }

    removeLesson(id) {
        delete this.data.lessons[id];
    }

    clear() {
        this.data.lessons = {};
    }

    listLessons() {
        return Object.values(this.data.lessons)
            .map(({chunks, ...meta}) => ({...meta, chunkCount: chunks.length}))
            .sort((a, b) => (a.lesson ?? 1e9) - (b.lesson ?? 1e9) || String(a.title).localeCompare(String(b.title)));
    }

    get chunkCount() {
        return Object.values(this.data.lessons).reduce((n, l) => n + l.chunks.length, 0);
    }

    /** queryVectors: uno o più vettori (es. domanda originale + traduzione inglese). Usa il punteggio massimo. */
    search(queryVectors, k = 5) {
        const qs = queryVectors.map(normalize);
        const scored = [];
        for (const lesson of Object.values(this.data.lessons)) {
            lesson.chunks.forEach((chunk, idx) => {
                let best = -1;
                for (const q of qs) best = Math.max(best, dot(q, chunk.vector));
                scored.push({score: best, lessonId: lesson.id, title: lesson.title, lesson: lesson.lesson ?? null, chunkIndex: idx, text: chunk.text});
            });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, k);
    }
}
