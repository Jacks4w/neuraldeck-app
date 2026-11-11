// Mini renderer Markdown sicuro (escape HTML prima di qualsiasi trasformazione).
(function () {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    function inline(s) {
        return s
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
            .replace(/\[((?:Lesson|Lezione|Lección|Leçon|Ders|Lekcija|Урок|课)[^\]]{0,120})\]/gi, '<span class="cite">[$1]</span>');
    }

    window.renderMarkdown = function (src) {
        const lines = esc(src || "").split("\n");
        const out = [];
        let list = null, para = [], code = null;
        const flushPara = () => { if (para.length) { out.push("<p>" + inline(para.join("<br>")) + "</p>"); para = []; } };
        const flushList = () => { if (list) { out.push(`<${list.type}>` + list.items.map((i) => "<li>" + inline(i) + "</li>").join("") + `</${list.type}>`); list = null; } };
        for (const line of lines) {
            if (code !== null) {
                if (/^```/.test(line)) { out.push("<pre><code>" + code.join("\n") + "</code></pre>"); code = null; } else code.push(line);
                continue;
            }
            if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
            const h = line.match(/^(#{1,3})\s+(.*)$/);
            const ul = line.match(/^\s*[-*•]\s+(.*)$/);
            const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
            if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
            else if (ul || ol) {
                flushPara();
                const type = ul ? "ul" : "ol";
                if (!list || list.type !== type) { flushList(); list = {type, items: []}; }
                list.items.push((ul || ol)[1]);
            } else if (!line.trim()) { flushPara(); flushList(); }
            else { flushList(); para.push(line); }
        }
        if (code !== null) out.push("<pre><code>" + code.join("\n") + "</code></pre>");
        flushPara(); flushList();
        return out.join("");
    };
})();
