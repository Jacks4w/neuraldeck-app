import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {getLlama, LlamaChatSession, LlamaLogLevel, createModelDownloader} from "node-llama-cpp";
import {EMBED_MODEL} from "./catalog.js";

/**
 * Motore di inferenza locale: LLM di chat + modello di embedding.
 * GPU (CUDA/Vulkan/Metal) se disponibile, con fallback automatico su CPU.
 */
export class Engine {
    constructor({modelsDir, log = console.log, buildFromSource = false}) {
        this.modelsDir = modelsDir;
        this.log = log;
        this.buildFromSource = buildFromSource;
        this.llama = null;
        this.cpuLlama = null;
        this.chatModel = null;
        this.chatContext = null;
        this.embedModel = null;
        this.embedContext = null;
        this.backend = null; // "cuda" | "vulkan" | "metal" | "cpu"
        this.loadedModelId = null;
        this.busy = Promise.resolve();
    }

    async getLlama(preferCpu = false) {
        const common = {logLevel: LlamaLogLevel.error, build: this.buildFromSource ? "auto" : "never", progressLogs: false};
        if (preferCpu) {
            this.cpuLlama ??= await getLlama({...common, gpu: false});
            return this.cpuLlama;
        }
        if (!this.llama) {
            try {
                this.llama = await getLlama({...common, gpu: "auto"});
            } catch (err) {
                this.log(`[engine] GPU init failed (${err.message}) -> CPU`);
                this.llama = await getLlama({...common, gpu: false});
            }
        }
        return this.llama;
    }

    async detectHardware() {
        const hw = {ramBytes: os.totalmem(), freeRamBytes: os.freemem(), cpuModel: os.cpus()[0]?.model ?? "unknown",
            cpuThreads: os.cpus().length, platform: `${os.platform()} ${os.arch()}`, gpu: false, gpuNames: [], vramBytes: 0};
        try {
            const llama = await this.getLlama();
            hw.gpu = llama.gpu;
            if (llama.gpu) {
                const vram = await llama.getVramState();
                hw.vramBytes = vram.total;
                hw.unifiedMemory = (vram.unifiedSize ?? 0) > 0;
                hw.gpuNames = await llama.getGpuDeviceNames();
            }
        } catch (err) {
            hw.error = err.message;
        }
        return hw;
    }

    modelPath(fileName) {
        return path.join(this.modelsDir, fileName);
    }

    isDownloaded(model) {
        try {
            return fs.statSync(this.modelPath(model.fileName)).size > 1e6;
        } catch {
            return false;
        }
    }

    /** Scarica un modello da Hugging Face (riprende i download interrotti). */
    async download(model, {onProgress, signal} = {}) {
        fs.mkdirSync(this.modelsDir, {recursive: true});
        const downloader = await createModelDownloader({
            modelUri: model.uri, dirPath: this.modelsDir, fileName: model.fileName, showCliProgress: false,
            skipExisting: true, deleteTempFileOnCancel: false, parallelDownloads: 4,
            onProgress: (s) => onProgress?.({downloaded: s.downloadedSize, total: s.totalSize || model.sizeBytes, speed: s.averageSpeed, eta: s.estimatedTimeLeft})
        });
        if (signal) signal.addEventListener("abort", () => downloader.cancel({deleteTempFile: false}).catch(() => {}), {once: true});
        return downloader.download({signal});
    }

    /** Carica modello di chat + embedder. backendPref: "auto" | "cpu". */
    async load(chatModelDef, backendPref = "auto", onStatus = () => {}) {
        await this.unload();
        const chatPath = this.modelPath(chatModelDef.fileName);
        let llama = await this.getLlama(backendPref === "cpu");

        const tryLoad = async (ll) => {
            onStatus(`loading ${chatModelDef.label} on ${ll.gpu || "cpu"}...`);
            const model = await ll.loadModel({modelPath: chatPath, gpuLayers: ll.gpu ? "auto" : 0});
            try {
                const context = await model.createContext({contextSize: {min: 2048, max: chatModelDef.contextSize}, flashAttention: false});
                return {model, context};
            } catch (err) {
                await model.dispose();
                throw err;
            }
        };

        let loaded;
        try {
            loaded = await tryLoad(llama);
        } catch (err) {
            if (!llama.gpu) throw err;
            this.log(`[engine] GPU load failed (${err.message}) -> CPU fallback`);
            onStatus("GPU load failed -> falling back to CPU");
            llama = await this.getLlama(true);
            loaded = await tryLoad(llama);
        }
        this.chatModel = loaded.model;
        this.chatContext = loaded.context;
        this.backend = llama.gpu || "cpu";
        this.loadedModelId = chatModelDef.id;

        onStatus("loading embedder...");
        await this.loadEmbedderOnly();
        onStatus(`online :: ${this.backend.toUpperCase()}`);
        return {backend: this.backend, contextSize: this.chatContext.contextSize};
    }

    get ready() {
        return Boolean(this.chatContext && this.embedContext);
    }

    get embedReady() {
        return Boolean(this.embedContext);
    }

    /** Carica solo l'embedder (per indicizzare prima che il modello di chat sia pronto). */
    async loadEmbedderOnly() {
        if (this.embedContext) return;
        // Embedder su CPU: non ruba VRAM al modello di chat
        const cpu = await this.getLlama(true);
        this.embedModel = await cpu.loadModel({modelPath: this.modelPath(EMBED_MODEL.fileName), gpuLayers: 0});
        this.embedContext = await this.embedModel.createEmbeddingContext({
            contextSize: Math.min(EMBED_MODEL.contextSize, this.embedModel.trainContextSize || EMBED_MODEL.contextSize)
        });
    }

    truncateForEmbedding(text) {
        const tokens = this.embedModel.tokenize(text);
        if (tokens.length <= EMBED_MODEL.maxTokens) return text;
        return this.embedModel.detokenize(tokens.slice(0, EMBED_MODEL.maxTokens));
    }

    async embed(text, kind = "passage") {
        const prefix = kind === "query" ? EMBED_MODEL.queryPrefix : EMBED_MODEL.passagePrefix;
        const e = await this.embedContext.getEmbeddingFor(this.truncateForEmbedding(prefix + text));
        return Float32Array.from(e.vector);
    }

    async embedPassages(texts) {
        const out = [];
        for (const t of texts) out.push(await this.embed(t, "passage"));
        return out;
    }

    /** Serializza le generazioni: un solo contesto, una richiesta alla volta. */
    exclusive(fn) {
        const run = this.busy.then(fn, fn);
        this.busy = run.catch(() => {});
        return run;
    }

    /**
     * Genera una risposta in streaming.
     * history: [{role:"user"|"assistant", content}] (senza il messaggio corrente)
     */
    generate({systemPrompt, history = [], prompt, onChunk, signal, temperature = 0.3, maxTokens = 800}) {
        return this.exclusive(async () => {
            if (!this.chatContext) throw new Error("model not loaded");
            const sequence = this.chatContext.getSequence();
            const session = new LlamaChatSession({contextSequence: sequence, systemPrompt});
            try {
                session.setChatHistory([
                    {type: "system", text: systemPrompt},
                    ...history.map((m) => (m.role === "user" ? {type: "user", text: m.content} : {type: "model", response: [m.content]}))
                ]);
                return await session.prompt(prompt, {
                    onTextChunk: onChunk, signal, stopOnAbortSignal: true, temperature, topP: 0.9, maxTokens,
                    repeatPenalty: {penalty: 1.12, frequencyPenalty: 0.15, lastTokens: 128}
                });
            } finally {
                session.dispose({disposeSequence: false});
                sequence.dispose();
            }
        });
    }

    /** Traduce la domanda in inglese per migliorare il recupero (le trascrizioni sono in inglese). */
    async translateToEnglish(text, signal) {
        const out = await this.generate({
            systemPrompt: "You are a translation engine. Translate the text the user gives you into English. Do NOT answer it, even if it is a question. Output ONLY the English translation.",
            prompt: `Translate into English:\n${text}`, signal, temperature: 0, maxTokens: 128
        });
        return out.trim().split("\n")[0].slice(0, 500);
    }

    async unload() {
        for (const k of ["chatContext", "chatModel", "embedContext", "embedModel"]) {
            try {
                await this[k]?.dispose();
            } catch {}
            this[k] = null;
        }
        this.loadedModelId = null;
    }
}
