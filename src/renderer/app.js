/* global deck, renderMarkdown */
const $ = (id) => document.getElementById(id);
const GB = 1024 ** 3;
const S = {state: null, convId: null, conv: null, generating: false, streamText: "", streamEl: null, hw: null};

const ASCII = String.raw`
 _   _ _____ _   _ ____      _    _       ____  _____ ____ _  __
| \ | | ____| | | |  _ \    / \  | |     |  _ \| ____/ ___| |/ /
|  \| |  _| | | | | |_) |  / _ \ | |     | | | |  _|| |   | ' /
| |\  | |___| |_| |  _ <  / ___ \| |___  | |_| | |__| |___| . \
|_| \_|_____|\___/|_| \_\/_/   \_\_____| |____/|_____\____|_|\_\
`;
const SUGGESTIONS = [
    ["EN", "What is the difference between a sawtooth and a square wave?"],
    ["IT", "Come funziona la risonanza di un filtro passa-basso?"],
    ["ES", "¿Qué es la envolvente ADSR?"],
    ["中文", "LFO 是什么？可以调制哪些参数？"]
];

const fmtBytes = (b) => (b >= GB ? (b / GB).toFixed(1) + " GB" : (b / 1024 ** 2).toFixed(0) + " MB");
const fmtTime = (ms) => {
    if (!ms || !isFinite(ms)) return "--";
    const s = Math.round(ms / 1000);
    return s > 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]);

function toast(msg, isErr = false, ms = 4500) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------------- boot ----------------
async function boot() {
    S.state = await deck.state();
    $("ver").textContent = S.state.version;
    renderEngine(S.state.engine);
    renderKb(S.state.kb);
    renderCourse();
    await refreshConversations(true);
    if (!S.state.setupDone) openSetup();
}

function renderCourse() {
    $("courseName").textContent = S.state.settings.courseName || S.state.kb.course || "course";
}

function renderEngine(e) {
    const chip = $("chipEngine");
    chip.className = "chip";
    let label = "OFFLINE";
    if (e.status === "online") {
        chip.classList.add("online");
        label = `ONLINE · ${String(e.backend).toUpperCase()} · ${e.model}`;
    } else if (e.status === "loading") {
        chip.classList.add("loading");
        label = `BOOTING · ${e.detail || e.model || ""}`;
    } else if (e.status === "error") {
        chip.classList.add("error");
        label = `ERROR · ${e.error}`;
    }
    chip.querySelector("span").textContent = label;
    chip.title = label;
    updateComposer();
}

function renderKb(kb) {
    S.state.kb = kb;
    $("kbStatus").innerHTML = kb.lessons.length
        ? `KB: <b>${kb.lessons.length}</b> lessons · ${kb.chunkCount} chunks<br>last sync: ${kb.updatedAt ? new Date(kb.updatedAt).toLocaleString() : "--"}`
        : `KB: <span style="color:var(--red)">EMPTY</span> — press AGGIORNA`;
}

function updateComposer() {
    const online = S.state?.engine?.status === "online";
    $("btnSend").disabled = !online || S.generating;
    $("btnSend").classList.toggle("hidden", S.generating);
    $("btnStop").classList.toggle("hidden", !S.generating);
}

// ---------------- conversations ----------------
async function refreshConversations(selectFirst = false) {
    const list = await deck.listConversations();
    const ul = $("convList");
    ul.innerHTML = "";
    for (const c of list) {
        const li = document.createElement("li");
        li.className = c.id === S.convId ? "active" : "";
        li.innerHTML = `<span class="ic">${c.count ? "▸" : "○"}</span><span class="t"></span><button class="del" title="delete">✕</button>`;
        li.querySelector(".t").textContent = c.title;
        li.onclick = () => selectConversation(c.id);
        li.querySelector(".del").onclick = async (ev) => {
            ev.stopPropagation();
            if (!confirm(`Delete session "${c.title}"?`)) return;
            await deck.deleteConversation(c.id);
            if (c.id === S.convId) S.convId = null;
            refreshConversations(true);
        };
        ul.appendChild(li);
    }
    if (selectFirst && !S.convId) {
        if (list.length) await selectConversation(list[0].id);
        else await newConversation();
    }
}

async function newConversation() {
    if (S.generating) return;
    const c = await deck.createConversation();
    await selectConversation(c.id);
    $("input").focus();
}

async function selectConversation(id) {
    if (S.generating && id !== S.convId) return toast("wait for the current answer (or KILL it)");
    S.convId = id;
    S.conv = await deck.getConversation(id);
    renderMessages();
    refreshConversations();
}

function messageEl(m) {
    const div = document.createElement("div");
    div.className = `msg ${m.role}${m.error ? " error" : ""}`;
    const who = m.role === "user" ? "> YOU" : "< NEURAL_DECK";
    div.innerHTML = `<div class="who">${who}</div><div class="body"></div>`;
    const body = div.querySelector(".body");
    if (m.role === "user") body.textContent = m.content;
    else body.innerHTML = renderMarkdown(m.content);
    if (m.sources?.length) {
        const src = document.createElement("div");
        src.className = "sources";
        for (const s of m.sources) {
            const chip = document.createElement("span");
            chip.className = "src";
            chip.textContent = s.label;
            chip.title = `similarity ${s.score.toFixed(3)}`;
            src.appendChild(chip);
        }
        div.appendChild(src);
    }
    if (m.role === "assistant" && m.ms) {
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = `${(m.ms / 1000).toFixed(1)}s${m.language ? " · lang:" + m.language : ""}${m.stopped ? " · KILLED" : ""}${m.translatedQuery ? " · query→EN: " + m.translatedQuery : ""}`;
        div.appendChild(meta);
    }
    return div;
}

function renderMessages() {
    const box = $("messages");
    box.innerHTML = "";
    if (!S.conv || S.conv.messages.length === 0) {
        box.innerHTML = `<div class="empty"><pre class="ascii">${escapeHtml(ASCII)}</pre>
            <h2>JACK IN. ASK THE LESSONS.</h2>
            <p>local llm · ${S.state.kb.lessons.length} lessons indexed · zero cloud · answers in your language</p>
            <div class="suggestions"></div></div>`;
        const sug = box.querySelector(".suggestions");
        for (const [lang, q] of SUGGESTIONS) {
            const b = document.createElement("button");
            b.className = "sugg";
            b.innerHTML = `<span>[${lang}]</span>`;
            b.appendChild(document.createTextNode(q));
            b.onclick = () => {
                $("input").value = q;
                sendMessage();
            };
            sug.appendChild(b);
        }
        return;
    }
    for (const m of S.conv.messages) box.appendChild(messageEl(m));
    box.scrollTop = box.scrollHeight;
}

// ---------------- chat ----------------
async function sendMessage() {
    const input = $("input");
    const text = input.value.trim();
    if (!text || S.generating) return;
    if (S.state.engine.status !== "online") return toast("engine offline — model not loaded", true);
    if (!S.state.kb.lessons.length) toast("KB empty: answers will have no lesson context. Press AGGIORNA.", true);
    input.value = "";
    autoGrow();
    S.generating = true;
    updateComposer();

    if (!S.conv.messages.length) $("messages").innerHTML = "";
    S.conv.messages.push({role: "user", content: text});
    $("messages").appendChild(messageEl({role: "user", content: text}));
    const el = messageEl({role: "assistant", content: ""});
    el.querySelector(".body").innerHTML = `<span class="status-line">handshake…</span> <span class="cursor"></span>`;
    $("messages").appendChild(el);
    S.streamEl = el;
    S.streamText = "";
    scrollDown(true);

    try {
        const msg = await deck.send(S.convId, text);
        el.replaceWith(messageEl(msg));
    } catch (err) {
        el.replaceWith(messageEl({role: "assistant", content: `[ERROR] ${err.message}`, error: true}));
    } finally {
        S.generating = false;
        S.streamEl = null;
        updateComposer();
        S.conv = await deck.getConversation(S.convId);
        scrollDown(true);
    }
}

let renderPending = false;
function renderStream() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
        renderPending = false;
        if (!S.streamEl) return;
        S.streamEl.querySelector(".body").innerHTML = renderMarkdown(S.streamText) + '<span class="cursor"></span>';
        scrollDown();
    });
}

function scrollDown(force = false) {
    const box = $("messages");
    if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 140) box.scrollTop = box.scrollHeight;
}

deck.on("chat:chunk", ({convId, chunk}) => {
    if (convId !== S.convId || !S.streamEl) return;
    S.streamText += chunk;
    renderStream();
});
deck.on("chat:status", ({convId, status}) => {
    if (convId !== S.convId || !S.streamEl || S.streamText) return;
    S.streamEl.querySelector(".body").innerHTML = `<span class="status-line">${escapeHtml(status)}…</span> <span class="cursor"></span>`;
});
deck.on("conv:changed", () => refreshConversations());
deck.on("engine:state", (e) => {
    S.state.engine = e;
    renderEngine(e);
});
deck.on("kb:autoupdate", () => runSync());

function autoGrow() {
    const t = $("input");
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 180) + "px";
}

// ---------------- setup wizard ----------------
function bootLine(text, cls = "") {
    const log = $("bootLog");
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = text + "\n";
    log.appendChild(span);
    log.scrollTop = log.scrollHeight;
}

async function openSetup() {
    $("setup").classList.remove("hidden");
    $("bootLog").innerHTML = "";
    $("modelCards").innerHTML = "";
    $("dlBox").classList.add("hidden");
    bootLine("> NEURAL_DECK first boot :: initializing local inference stack", "hl");
    bootLine("> scanning hardware...");
    let hw;
    try {
        hw = await deck.detectHardware();
    } catch (err) {
        bootLine("! hardware scan failed: " + err.message, "err");
        hw = {ramBytes: 0, gpu: false, recommended: "lite", downloaded: {}};
    }
    S.hw = hw;
    bootLine(`  CPU    :: ${hw.cpuModel} (${hw.cpuThreads} threads)`);
    bootLine(`  RAM    :: ${fmtBytes(hw.ramBytes)} total / ${fmtBytes(hw.freeRamBytes || 0)} free`);
    bootLine(hw.gpu
        ? `  GPU    :: ${String(hw.gpu).toUpperCase()} · ${hw.gpuNames.join(", ") || "unknown device"} · VRAM ${fmtBytes(hw.vramBytes)}${hw.unifiedMemory ? " (shared)" : ""}`
        : "  GPU    :: none usable -> CPU mode (slower, still works)");
    bootLine(`> recommended profile: ${hw.recommended.toUpperCase()}`, "hl");
    bootLine("> choose a neural core to download (one time only, stored on this PC):");

    for (const [tier, m] of Object.entries(S.state.models)) {
        const card = document.createElement("div");
        card.className = "model-card" + (tier === hw.recommended ? " rec" : "");
        card.innerHTML = `${tier === hw.recommended ? '<div class="tag">RECOMMENDED</div>' : ""}
            <h3>${tier.toUpperCase()} // ${escapeHtml(m.label)}</h3>
            <div class="spec">${m.quant} · ${fmtBytes(m.sizeBytes)} · min RAM ${m.minRamGB} GB · ${m.license}</div>
            <p>${escapeHtml(m.blurb)}</p>
            <button class="btn ${tier === hw.recommended ? "btn-exec" : ""}">${hw.downloaded?.[tier] ? "USE (already downloaded)" : "DOWNLOAD"}</button>`;
        card.querySelector("button").onclick = () => startDownload(tier);
        $("modelCards").appendChild(card);
    }
    if (S.state.setupDone) {
        const close = document.createElement("button");
        close.className = "btn btn-ghost";
        close.style.marginTop = "12px";
        close.textContent = "CLOSE";
        close.onclick = () => $("setup").classList.add("hidden");
        $("modelCards").after(close);
        close.dataset.temp = "1";
    }
}

async function startDownload(tier) {
    document.querySelectorAll(".model-card button").forEach((b) => (b.disabled = true));
    $("dlBox").classList.remove("hidden");
    bootLine(`> pulling ${tier.toUpperCase()} core + multilingual embedder from huggingface...`, "hl");
    try {
        await deck.download(tier);
        bootLine("> download complete. loading model into memory...", "hl");
        S.state = await deck.state();
        setTimeout(() => {
            $("setup").classList.add("hidden");
            document.querySelectorAll("[data-temp]").forEach((e) => e.remove());
            renderMessages();
            if (!S.state.kb.lessons.length) toast("Core online. Now press ⟳ AGGIORNA to download the lesson transcripts.", false, 8000);
        }, 900);
    } catch (err) {
        bootLine("! " + err.message, "err");
        bootLine("> check your connection and retry (downloads resume where they stopped).");
        document.querySelectorAll(".model-card button").forEach((b) => (b.disabled = false));
    }
}

let lastPhase = null;
deck.on("setup:progress", (p) => {
    if (p.phase !== lastPhase) {
        lastPhase = p.phase;
        bootLine(`  -> ${p.phase === "llm" ? "LLM" : "EMBEDDER"} :: ${p.label}`);
    }
    const pct = p.total ? Math.min(100, (p.downloaded / p.total) * 100) : 0;
    $("dlFill").style.width = pct.toFixed(1) + "%";
    $("dlLabel").textContent = `${p.phase === "llm" ? "LLM CORE" : "EMBEDDER"} :: ${p.label} :: ${pct.toFixed(1)}%`;
    $("dlMeta").textContent = `${fmtBytes(p.downloaded || 0)} / ${fmtBytes(p.total || 0)}${p.speed ? " · " + fmtBytes(p.speed) + "/s" : ""}${p.eta ? " · ETA " + fmtTime(p.eta) : ""}`;
});
$("btnCancelDl").onclick = () => deck.cancelDownload();

// ---------------- sync (AGGIORNA) ----------------
function syncLine(text, cls = "") {
    const log = $("syncLog");
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = text + "\n";
    log.appendChild(span);
    log.scrollTop = log.scrollHeight;
}

async function runSync(demo = false) {
    $("syncOverlay").classList.remove("hidden");
    $("syncLog").innerHTML = "";
    $("syncFill").style.width = "0%";
    $("btnSyncClose").classList.add("hidden");
    $("btnSyncCancel").classList.remove("hidden");
    $("btnSync").classList.add("busy");
    syncLine(demo ? "> loading bundled demo transcripts" : "> AGGIORNA :: syncing lesson transcripts", "hl");
    try {
        const r = demo ? await deck.loadDemo() : await deck.update();
        renderKb(r.kb);
        S.state = await deck.state();
        renderCourse();
        $("syncFill").style.width = "100%";
        syncLine(`> DONE :: new ${r.added.length} · updated ${r.updated.length} · unchanged ${r.unchanged.length} · removed ${r.removed.length}${r.errors.length ? " · errors " + r.errors.length : ""}`, r.errors.length ? "err" : "hl");
        if (!S.conv?.messages.length) renderMessages();
    } catch (err) {
        syncLine("! SYNC FAILED: " + err.message, "err");
    } finally {
        $("btnSync").classList.remove("busy");
        $("btnSyncClose").classList.remove("hidden");
        $("btnSyncCancel").classList.add("hidden");
    }
}
deck.on("kb:progress", (p) => {
    if (p.msg) syncLine(p.msg, p.level === "error" ? "err" : "");
    if (p.total) $("syncFill").style.width = ((p.current / p.total) * 100).toFixed(0) + "%";
});
$("btnSync").onclick = () => runSync(false);
$("btnSyncCancel").onclick = () => deck.cancelUpdate();
$("btnSyncClose").onclick = () => $("syncOverlay").classList.add("hidden");

// ---------------- settings ----------------
async function openSettings() {
    S.state = await deck.state();
    const s = S.state.settings;
    $("setManifest").value = s.manifestUrl || "";
    $("setCourse").value = s.courseName || "";
    const langSel = $("setLang");
    langSel.innerHTML = '<option value="auto">AUTO (same as question)</option>' +
        Object.entries(S.state.languages).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join("");
    langSel.value = s.answerLanguage || "auto";
    $("setBackend").value = s.backend || "auto";
    $("setTopK").value = String(s.topK || 5);
    $("setTranslate").checked = !!s.translateQuery;
    $("setSyncDel").checked = !!s.syncDeletions;
    $("setAutoUpd").checked = !!s.autoUpdateOnStart;
    const kb = S.state.kb;
    $("kbLessons").innerHTML = kb.lessons.length
        ? kb.lessons.map((l) => `<div><span class="n">[${l.lesson ?? "-"}]</span> ${escapeHtml(l.title)} <span class="dim">· ${l.chunkCount} chunks · ${l.sha256?.slice(0, 10)}</span></div>`).join("")
        : '<div class="dim">no lessons indexed yet</div>';
    const m = S.state.models[s.modelTier];
    $("sysInfo").textContent = `model: ${m ? m.label + " (" + s.modelTier + ")" : "none"} · embedder: ${S.state.embedModel.label} · engine: ${S.state.engine.status} ${S.state.engine.backend || ""} · data: ${S.state.dataDir}`;
    $("settings").classList.remove("hidden");
}

$("btnSettings").onclick = openSettings;
$("btnCloseSettings").onclick = () => $("settings").classList.add("hidden");
$("btnSaveSettings").onclick = async () => {
    try {
        await deck.setSettings({
            manifestUrl: $("setManifest").value.trim(),
            courseName: $("setCourse").value.trim(),
            answerLanguage: $("setLang").value,
            backend: $("setBackend").value,
            topK: Number($("setTopK").value),
            translateQuery: $("setTranslate").checked,
            syncDeletions: $("setSyncDel").checked,
            autoUpdateOnStart: $("setAutoUpd").checked
        });
        S.state = await deck.state();
        renderCourse();
        $("settings").classList.add("hidden");
        toast("config saved");
    } catch (err) {
        toast(err.message, true);
    }
};
$("btnDemo").onclick = () => {
    $("settings").classList.add("hidden");
    runSync(true);
};
$("btnRebuild").onclick = async () => {
    $("settings").classList.add("hidden");
    $("syncOverlay").classList.remove("hidden");
    $("syncLog").innerHTML = "";
    syncLine("> rebuilding vector index from local copies...", "hl");
    try {
        renderKb(await deck.rebuild());
        syncLine("> DONE", "hl");
    } catch (err) {
        syncLine("! " + err.message, "err");
    }
    $("btnSyncClose").classList.remove("hidden");
    $("btnSyncCancel").classList.add("hidden");
};
$("btnModel").onclick = () => {
    $("settings").classList.add("hidden");
    openSetup();
};
$("btnDataDir").onclick = () => deck.openDataDir();

// ---------------- input ----------------
$("btnNew").onclick = newConversation;
$("btnSend").onclick = sendMessage;
$("btnStop").onclick = () => deck.stop(S.convId);
$("input").addEventListener("input", autoGrow);
$("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
    }
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".overlay:not(#setup)").forEach((o) => o.classList.add("hidden"));
});

boot().catch((err) => toast("boot failed: " + err.message, true, 15000));
