import crypto from "node:crypto";

export function sha256(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
}

/** Rimuove timestamp/indici da sottotitoli SRT/VTT, lascia invariato il testo semplice. */
export function cleanTranscript(raw, fileHint = "") {
    let text = String(raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const looksLikeSubs = /\.(srt|vtt)(\?|$)/i.test(fileHint) || /^WEBVTT/.test(text) ||
        /\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(text);
    if (looksLikeSubs) {
        text = text
            .split("\n")
            .filter((line) => {
                const l = line.trim();
                if (l === "" || l === "WEBVTT") return false;
                if (/^\d+$/.test(l)) return false;
                if (/-->/.test(l)) return false;
                if (/^(NOTE|STYLE|REGION)\b/.test(l)) return false;
                return true;
            })
            .map((l) => l.replace(/<[^>]+>/g, "").trim())
            .join(" ");
    }
    return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Divide il testo in chunk di ~maxChars caratteri con sovrapposizione,
 * spezzando preferibilmente su paragrafi e frasi.
 */
export function chunkText(text, {maxChars = 900, overlap = 150} = {}) {
    const sentences = text
        .split(/\n{2,}/)
        .flatMap((para) => para.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [para])
        .map((s) => s.trim())
        .filter(Boolean);

    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
        // frase singola troppo lunga: spezzala brutalmente
        const pieces = sentence.length > maxChars
            ? sentence.match(new RegExp(`.{1,${maxChars}}(\\s|$)`, "g")) ?? [sentence]
            : [sentence];
        for (const piece of pieces) {
            if (current.length + piece.length + 1 > maxChars && current.length > 0) {
                chunks.push(current.trim());
                current = current.length > overlap ? current.slice(-overlap) : current;
                const sp = current.indexOf(" ");
                if (sp > 0) current = current.slice(sp + 1);
            }
            current += (current ? " " : "") + piece.trim();
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

export function safeFileName(id) {
    return String(id).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "item";
}
