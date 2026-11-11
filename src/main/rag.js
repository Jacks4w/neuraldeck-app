import {franc} from "franc-min";

// ISO 639-3 (franc) -> nome lingua in inglese (i modelli piccoli seguono meglio istruzioni in inglese)
export const LANGUAGES = {
    eng: "English", ita: "Italian", spa: "Spanish", fra: "French", deu: "German", por: "Portuguese",
    hrv: "Croatian", srp: "Serbian", bos: "Bosnian", slv: "Slovenian", tur: "Turkish", rus: "Russian",
    ukr: "Ukrainian", pol: "Polish", ces: "Czech", ron: "Romanian", nld: "Dutch", ell: "Greek",
    cmn: "Chinese (Simplified)", jpn: "Japanese", kor: "Korean", arb: "Arabic", hin: "Hindi",
    swe: "Swedish", hun: "Hungarian", vie: "Vietnamese", ind: "Indonesian", pes: "Persian"
};

const SCRIPT_RULES = [
    [/[\u3040-\u30ff]/, "jpn"],
    [/[\uac00-\ud7af]/, "kor"],
    [/[\u4e00-\u9fff]/, "cmn"],
    [/[\u0600-\u06ff]/, "arb"],
    [/[\u0370-\u03ff]/, "ell"],
    [/[\u0900-\u097f]/, "hin"],
    // lettere latine praticamente esclusive di una lingua (franc sbaglia spesso su frasi brevi)
    [/[ıİğĞ]/, "tur"],
    [/[ąĄęĘłŁśŚźŹżŻ]/, "pol"], // prima del croato: anche il polacco usa "ć"
    [/[đĐćĆ]/, "hrv"],
    [/[ñÑ¿¡]/, "spa"],
    [/[řŘůŮěĚ]/, "ces"],
    [/[șȘțȚăĂ]/, "ron"],
    [/[ãõÃÕ]/, "por"],
    [/ß/, "deu"]
];

/**
 * Rileva la lingua della domanda. `samples` = ultimo messaggio + precedenti messaggi utente
 * (più testo = rilevamento più affidabile). Restituisce {code, name} oppure null se incerta.
 */
export function detectLanguage(samples) {
    const last = (samples[0] ?? "").trim();
    for (const [re, code] of SCRIPT_RULES) if (re.test(last)) return {code, name: LANGUAGES[code]};
    if (/[\u0400-\u04ff]/.test(last)) { // cirillico: scegli solo tra lingue cirilliche
        const c = franc(last, {only: ["rus", "ukr", "srp"], minLength: 3});
        return {code: c === "und" ? "rus" : c, name: LANGUAGES[c === "und" ? "rus" : c]};
    }
    const only = Object.keys(LANGUAGES);
    // priorità al messaggio corrente; la cronologia serve solo se il messaggio è troppo corto/ambiguo
    let code = last.length >= 15 ? franc(last, {only, minLength: 8}) : "und";
    if (code === "und") {
        const text = samples.join(" \n").slice(0, 1500);
        if (text.replace(/\s/g, "").length < 8) return null;
        code = franc(text, {only, minLength: 8});
    }
    if (code === "und") return null;
    // Serbo/bosniaco in alfabeto latino sono quasi indistinguibili dal croato per franc: trattali come croato
    if ((code === "srp" || code === "bos") && !/[\u0400-\u04ff]/.test(last)) return {code: "hrv", name: LANGUAGES.hrv};
    return {code, name: LANGUAGES[code]};
}

export function resolveAnswerLanguage(setting, samples) {
    if (setting && setting !== "auto" && LANGUAGES[setting]) return {code: setting, name: LANGUAGES[setting]};
    return detectLanguage(samples);
}

export function buildSystemPrompt(courseName) {
    return [
        `You are NEURAL_DECK, the teaching assistant of the course "${courseName || "the course"}".`,
        "You answer students' questions using ONLY the lesson transcript excerpts provided in the user's message.",
        "The transcripts are in English, but you ALWAYS reply in the student's language.",
        "If the excerpts do not contain the answer, say so honestly and suggest asking the teacher. Never invent facts.",
        "Cite the lessons you used, e.g. [Lesson 2: Filters].",
        "Style: concise, clear, a bit of cyberpunk/hacker attitude, but accuracy comes first."
    ].join("\n");
}

export function sourceLabel(src) {
    return src.lesson != null ? `Lesson ${src.lesson}: ${src.title}` : src.title;
}

export function buildUserPrompt({question, sources, language}) {
    const excerpts = sources.length
        ? sources.map((s, i) => `<excerpt ${i + 1} source="[${sourceLabel(s)}]">\n${s.text}\n</excerpt>`).join("\n")
        : "(no relevant excerpts found in the transcripts)";
    const lang = language?.name
        ? `${language.name} (the language of the question)`
        : "the same language the student used in the question";
    return [
        "LESSON EXCERPTS (English):",
        excerpts,
        "",
        "STUDENT QUESTION:",
        question,
        "",
        "RULES:",
        `- Write your whole answer in ${lang}.`,
        "- Use only the excerpts above; if they are not enough, say it.",
        "- Cite the source lessons in square brackets, e.g. [" + (sources[0] ? sourceLabel(sources[0]) : "Lesson 1: Title") + "]."
    ].join("\n");
}

/** Raggruppa i chunk recuperati in fonti uniche (per le "chip" nella UI). */
export function uniqueSources(sources) {
    const map = new Map();
    for (const s of sources) {
        const prev = map.get(s.lessonId);
        if (!prev || s.score > prev.score) map.set(s.lessonId, {lessonId: s.lessonId, title: s.title, lesson: s.lesson, score: s.score, label: sourceLabel(s)});
    }
    return [...map.values()];
}
