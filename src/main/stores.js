import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}
function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2));
    fs.renameSync(file + ".tmp", file);
}

export const DEFAULT_SETTINGS = {
    manifestUrl: "",
    courseName: "Synthesizers",
    modelTier: null, // "standard" | "lite" (scelto al primo avvio)
    backend: "auto", // "auto" | "cpu"
    answerLanguage: "auto",
    translateQuery: true,
    topK: 5,
    syncDeletions: true,
    autoUpdateOnStart: false
};

export class SettingsStore {
    /** bundledDefaults: config/defaults.json (impostato dal docente prima della build) */
    constructor(file, bundledDefaults = {}) {
        this.file = file;
        this.defaults = {...DEFAULT_SETTINGS, ...bundledDefaults};
        this.values = {...this.defaults, ...readJson(file, {})};
    }
    get() {
        return {...this.values};
    }
    set(patch) {
        const allowed = Object.keys(DEFAULT_SETTINGS);
        for (const [k, v] of Object.entries(patch)) if (allowed.includes(k)) this.values[k] = v;
        writeJson(this.file, this.values);
        return this.get();
    }
    resetManifestUrl() {
        return this.set({manifestUrl: this.defaults.manifestUrl});
    }
}

/** Conversazioni salvate come un file JSON ciascuna. */
export class ConversationStore {
    constructor(dir) {
        this.dir = dir;
        fs.mkdirSync(dir, {recursive: true});
    }
    file(id) {
        if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("bad id");
        return path.join(this.dir, id + ".json");
    }
    list() {
        return fs.readdirSync(this.dir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => readJson(path.join(this.dir, f), null))
            .filter(Boolean)
            .map(({id, title, createdAt, updatedAt, messages}) => ({id, title, createdAt, updatedAt, count: messages.length}))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    get(id) {
        return readJson(this.file(id), null);
    }
    /** Riusa una conversazione vuota esistente invece di accumulare "New Chat" vuote. */
    create() {
        const empty = this.list().find((c) => c.count === 0);
        if (empty) return this.get(empty.id);
        const now = new Date().toISOString();
        const conv = {id: crypto.randomUUID(), title: "new_session", createdAt: now, updatedAt: now, messages: []};
        this.save(conv);
        return conv;
    }
    save(conv) {
        conv.updatedAt = new Date().toISOString();
        writeJson(this.file(conv.id), conv);
        return conv;
    }
    rename(id, title) {
        const c = this.get(id);
        if (!c) return null;
        c.title = String(title).slice(0, 80) || c.title;
        return this.save(c);
    }
    delete(id) {
        fs.rmSync(this.file(id), {force: true});
    }
}

/** Titolo automatico dalla prima domanda. */
export function autoTitle(text) {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length > 42 ? t.slice(0, 40).trimEnd() + "…" : t;
}
