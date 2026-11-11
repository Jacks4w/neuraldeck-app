import {EMBED_MODEL} from "./catalog.js";
import {buildSystemPrompt, buildUserPrompt, resolveAnswerLanguage, uniqueSources} from "./rag.js";

/**
 * Pipeline RAG completa: lingua -> (traduzione) -> retrieval -> prompt -> generazione in streaming.
 */
export async function answerQuestion({engine, store, settings, history, question, onChunk, onStatus = () => {}, signal}) {
    const userSamples = [question, ...history.filter((m) => m.role === "user").map((m) => m.content).reverse()];
    const language = resolveAnswerLanguage(settings.answerLanguage, userSamples);

    const queries = [question];
    let translated = null;
    if (settings.translateQuery && store.chunkCount > 0 && language?.code !== "eng") {
        onStatus("translating query -> EN");
        try {
            translated = await engine.translateToEnglish(question, signal);
            if (translated && translated.toLowerCase() !== question.toLowerCase()) queries.push(translated);
        } catch (err) {
            if (signal?.aborted) throw err;
        }
    }

    onStatus("scanning transcripts");
    let sources = [];
    if (store.chunkCount > 0) {
        const vectors = [];
        for (const q of queries) vectors.push(await engine.embed(q, "query"));
        const hits = store.search(vectors, settings.topK ?? 5);
        sources = hits.filter((h) => h.score >= EMBED_MODEL.minScore);
        if (sources.length === 0 && hits.length) sources = hits.slice(0, 1); // domanda fuori tema: un solo estratto, il modello dirà che non lo sa
    }

    onStatus("generating");
    const recent = history.slice(-6).map((m) => ({role: m.role, content: m.content}));
    const content = await engine.generate({
        systemPrompt: buildSystemPrompt(settings.courseName),
        history: recent,
        prompt: buildUserPrompt({question, sources, language}),
        onChunk,
        signal
    });
    // nella UI mostra solo le fonti davvero pertinenti (non l'estratto di ripiego per domande fuori tema)
    const shown = sources.filter((h) => h.score >= EMBED_MODEL.minScore);
    return {content: content.trim(), sources: uniqueSources(shown), language: language?.code ?? null, translatedQuery: translated};
}
