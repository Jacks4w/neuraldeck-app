import {app, BrowserWindow, ipcMain, shell, Menu} from "electron";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {Engine} from "./engine.js";
import {VectorStore} from "./vectorstore.js";
import {SettingsStore, ConversationStore, autoTitle} from "./stores.js";
import {LLM_MODELS, EMBED_MODEL, recommendTier} from "./catalog.js";
import {runUpdate, rebuildIndex} from "./updater.js";
import {answerQuestion} from "./chat.js";
import {LANGUAGES} from "./rag.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..", "..");

// Cartella dati dell'utente: %APPDATA%\NeuralDeck su Windows
app.setName("NeuralDeck");
const dataDir = process.env.NEURALDECK_DATA_DIR || app.getPath("userData");
const paths = {
    models: path.join(dataDir, "models"),
    transcripts: path.join(dataDir, "transcripts"),
    index: path.join(dataDir, "index", "vectors.json"),
    conversations: path.join(dataDir, "conversations"),
    settings: path.join(dataDir, "settings.json"),
    log: path.join(dataDir, "neuraldeck.log")
};
fs.mkdirSync(dataDir, {recursive: true});

function log(...args) {
    const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
    console.log(line);
    try {
        fs.appendFileSync(paths.log, line + "\n");
    } catch {}
}

function readBundledDefaults() {
    try {
        return JSON.parse(fs.readFileSync(path.join(appRoot, "config", "defaults.json"), "utf8"));
    } catch {
        return {};
    }
}
const sampleDir = app.isPackaged ? path.join(process.resourcesPath, "sample") : path.join(appRoot, "sample");

const settings = new SettingsStore(paths.settings, readBundledDefaults());
const conversations = new ConversationStore(paths.conversations);
const store = new VectorStore(paths.index).load();
const engine = new Engine({modelsDir: paths.models, log, buildFromSource: !app.isPackaged});

let win = null;
let engineState = {status: "offline", backend: null, model: null, error: null};
let downloadAbort = null;
let updateAbort = null;
const chatAborts = new Map();

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);
function setEngineState(patch) {
    engineState = {...engineState, ...patch};
    send("engine:state", engineState);
}

function currentModel() {
    return LLM_MODELS[settings.get().modelTier] ?? null;
}
function setupDone() {
    const m = currentModel();
    return Boolean(m && engine.isDownloaded(m) && engine.isDownloaded(EMBED_MODEL));
}

async function loadEngine() {
    const m = currentModel();
    if (!m) return;
    setEngineState({status: "loading", model: m.label, error: null});
    try {
        const r = await engine.load(m, settings.get().backend, (s) => setEngineState({detail: s}));
        setEngineState({status: "online", backend: r.backend, contextSize: r.contextSize, detail: null});
        log(`[engine] online model=${m.id} backend=${r.backend} ctx=${r.contextSize}`);
        if (settings.get().autoUpdateOnStart && settings.get().manifestUrl) send("kb:autoupdate", {});
    } catch (err) {
        log("[engine] load failed:", err.stack || err.message);
        setEngineState({status: "error", error: err.message});
    }
}

function kbInfo() {
    return {lessons: store.listLessons(), chunkCount: store.chunkCount, updatedAt: store.data.updatedAt, course: store.data.course};
}

function createWindow() {
    win = new BrowserWindow({
        width: 1280, height: 820, minWidth: 900, minHeight: 600,
        backgroundColor: "#05060a",
        title: "NeuralDeck",
        icon: path.join(appRoot, "build", "icon.png"),
        titleBarStyle: "hidden",
        titleBarOverlay: {color: "#05060a", symbolColor: "#00fff0", height: 34},
        webPreferences: {preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true}
    });
    Menu.setApplicationMenu(null);
    win.loadFile(path.join(appRoot, "src", "renderer", "index.html"));
    win.webContents.setWindowOpenHandler(({url}) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return {action: "deny"};
    });
    win.on("focus", () => win.webContents.focus());
    if (process.env.NEURALDECK_DEVTOOLS) win.webContents.openDevTools({mode: "detach"});
}

// ---------- IPC ----------
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try {
        return {ok: true, data: await fn(...args)};
    } catch (err) {
        log(`[ipc] ${ch} error:`, err.stack || err.message);
        return {ok: false, error: err.message};
    }
});

handle("app:state", () => ({
    version: app.getVersion(), dataDir, setupDone: setupDone(), settings: settings.get(), engine: engineState,
    models: LLM_MODELS, embedModel: EMBED_MODEL, kb: kbInfo(), languages: LANGUAGES
}));

handle("hw:detect", async () => {
    const hw = await engine.detectHardware();
    return {...hw, recommended: recommendTier(hw), downloaded: Object.fromEntries(Object.entries(LLM_MODELS).map(([k, m]) => [k, engine.isDownloaded(m)]))};
});

handle("setup:download", async (tier) => {
    const model = LLM_MODELS[tier];
    if (!model) throw new Error("unknown tier");
    downloadAbort = new AbortController();
    const signal = downloadAbort.signal;
    try {
        for (const [phase, m] of [["embedder", EMBED_MODEL], ["llm", model]]) {
            send("setup:progress", {phase, label: m.label, downloaded: 0, total: m.sizeBytes});
            await engine.download(m, {signal, onProgress: (p) => send("setup:progress", {phase, label: m.label, ...p})});
            if (signal.aborted) throw new Error("download cancelled");
        }
        settings.set({modelTier: tier});
        log(`[setup] downloaded ${model.id}`);
        loadEngine();
        return true;
    } finally {
        downloadAbort = null;
    }
});
handle("setup:cancel", () => downloadAbort?.abort());

handle("engine:reload", () => loadEngine());

handle("settings:set", async (patch) => {
    const before = settings.get();
    const after = settings.set(patch);
    if ((patch.backend && patch.backend !== before.backend) || (patch.modelTier && patch.modelTier !== before.modelTier && setupDone())) loadEngine();
    return after;
});

handle("conv:list", () => conversations.list());
handle("conv:get", (id) => conversations.get(id));
handle("conv:create", () => conversations.create());
handle("conv:delete", (id) => {
    const r = conversations.delete(id);
    setTimeout(refocusWindow, 50); // rete di sicurezza: tastiera di nuovo attiva dopo la cancellazione
    return r;
});

// Electron su Windows: dopo dialoghi/overlay la tastiera può restare senza focus finché
// non si cambia finestra. Ridare il focus a finestra + webContents lo ripristina.
function refocusWindow() {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    if (!win.isFocused()) win.focus();
    win.webContents.focus();
}
ipcMain.on("win:refocus", () => refocusWindow());
handle("conv:rename", (id, title) => conversations.rename(id, title));

handle("chat:send", async ({convId, text}) => {
    if (!engine.ready) throw new Error("Engine offline: the model is not loaded yet");
    const conv = conversations.get(convId);
    if (!conv) throw new Error("conversation not found");
    const question = String(text).trim().slice(0, 4000);
    if (!question) throw new Error("empty message");
    const history = conv.messages.filter((m) => !m.error);
    conv.messages.push({role: "user", content: question, at: new Date().toISOString()});
    if (history.length === 0) conv.title = autoTitle(question);
    conversations.save(conv);
    send("conv:changed", {});

    const ac = new AbortController();
    chatAborts.set(convId, ac);
    const t0 = Date.now();
    try {
        const r = await answerQuestion({
            engine, store, settings: settings.get(), history, question, signal: ac.signal,
            onChunk: (chunk) => send("chat:chunk", {convId, chunk}),
            onStatus: (status) => send("chat:status", {convId, status})
        });
        const msg = {role: "assistant", content: r.content || "[signal lost: empty response]", sources: r.sources, language: r.language,
            translatedQuery: r.translatedQuery, stopped: ac.signal.aborted, ms: Date.now() - t0, at: new Date().toISOString()};
        conv.messages.push(msg);
        conversations.save(conv);
        return msg;
    } catch (err) {
        conv.messages.push({role: "assistant", content: `[ERROR] ${err.message}`, error: true, at: new Date().toISOString()});
        conversations.save(conv);
        throw err;
    } finally {
        chatAborts.delete(convId);
        send("conv:changed", {});
    }
});
handle("chat:stop", (convId) => chatAborts.get(convId)?.abort());

async function ensureEmbedder() {
    if (!engine.isDownloaded(EMBED_MODEL)) throw new Error("Embedding model not downloaded: complete the setup first");
    if (!engine.embedReady) await engine.loadEmbedderOnly();
}

async function doUpdate(manifestUrl) {
    if (updateAbort) throw new Error("update already running");
    if (!manifestUrl || manifestUrl.includes("CHANGE-ME"))
        throw new Error("Manifest URL non configurato: apri SETTINGS e incolla il link del manifest (oppure usa LOAD DEMO).");
    await ensureEmbedder();
    updateAbort = new AbortController();
    try {
        const s = settings.get();
        const result = await runUpdate({
            manifestUrl, store, transcriptsDir: paths.transcripts, embedModelId: EMBED_MODEL.id,
            embedPassages: (t) => engine.embedPassages(t), syncDeletions: s.syncDeletions, signal: updateAbort.signal,
            onProgress: (p) => send("kb:progress", p)
        });
        if (result.course && (!s.courseName || s.courseName === "Synthesizers")) settings.set({courseName: result.course});
        log(`[kb] update ok +${result.added.length} ~${result.updated.length} -${result.removed.length} errors=${result.errors.length}`);
        return {...result, kb: kbInfo()};
    } finally {
        updateAbort = null;
    }
}
handle("kb:update", () => doUpdate(settings.get().manifestUrl));
handle("kb:loadDemo", () => doUpdate(pathToFileURL(path.join(sampleDir, "manifest.json")).toString()));
handle("kb:cancel", () => updateAbort?.abort());
handle("kb:info", () => kbInfo());
handle("kb:rebuild", async () => {
    await ensureEmbedder();
    await rebuildIndex({store, transcriptsDir: paths.transcripts, embedModelId: EMBED_MODEL.id, embedPassages: (t) => engine.embedPassages(t),
        onProgress: (p) => send("kb:progress", p)});
    return kbInfo();
});
handle("app:openDataDir", () => shell.openPath(dataDir));
handle("app:openExternal", (url) => /^https?:/.test(url) && shell.openExternal(url));

// ---------- lifecycle ----------
app.whenReady().then(() => {
    log(`[app] start v${app.getVersion()} data=${dataDir} packaged=${app.isPackaged}`);
    createWindow();
    if (setupDone()) loadEngine();
});
app.on("window-all-closed", async () => {
    for (const ac of chatAborts.values()) ac.abort();
    await engine.unload().catch(() => {});
    app.quit();
});
