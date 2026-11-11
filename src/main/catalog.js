// Catalogo dei modelli scaricabili al primo avvio (mai inclusi nell'installer).
const GB = 1024 ** 3;

export const LLM_MODELS = {
    standard: {
        tier: "standard",
        id: "qwen3-4b-instruct-2507-q4_k_m",
        label: "Qwen3 4B Instruct 2507",
        quant: "Q4_K_M",
        uri: "hf:unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        fileName: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        sizeBytes: 2497281120,
        minRamGB: 8,
        contextSize: 4096,
        license: "Apache-2.0",
        blurb: "Better reasoning + 100+ languages. Needs ~8 GB RAM (or a 4 GB+ GPU)."
    },
    lite: {
        tier: "lite",
        id: "qwen2.5-1.5b-instruct-q4_k_m",
        label: "Qwen2.5 1.5B Instruct",
        quant: "Q4_K_M",
        uri: "hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF/qwen2.5-1.5b-instruct-q4_k_m.gguf",
        fileName: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        sizeBytes: 1117320736,
        minRamGB: 4,
        contextSize: 4096,
        license: "Apache-2.0",
        blurb: "Lightweight, runs on 4-8 GB RAM CPU-only laptops. Less accurate."
    }
};

export const EMBED_MODEL = {
    id: "bge-m3-q4_k_m",
    label: "BGE-M3 (multilingual)",
    uri: "hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf",
    fileName: "bge-m3-Q4_K_M.gguf",
    sizeBytes: 437778496,
    license: "MIT",
    // BGE-M3 non usa prefissi "query:"/"passage:" (a differenza di E5)
    queryPrefix: "",
    passagePrefix: "",
    contextSize: 1024,
    maxTokens: 1000,
    // similarità coseno minima per considerare rilevante un estratto (calibrata sui test: pertinenti 0.40-0.70, fuori tema ~0.25)
    minScore: 0.35
};

/** Sceglie il modello in base a RAM e VRAM rilevate. */
export function recommendTier({ramBytes = 0, vramBytes = 0, gpu = false} = {}) {
    const ramGB = ramBytes / GB;
    const vramGB = vramBytes / GB;
    // os.totalmem() su un PC da 8 GB riporta ~7.7-7.9 GB: soglia a 7.5.
    if ((gpu && vramGB >= 4) || ramGB >= 7.5) return "standard";
    return "lite";
}
