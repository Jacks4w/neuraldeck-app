#!/usr/bin/env node
// Garantisce che in node_modules ci siano i binari precompilati Windows di node-llama-cpp.
// - Su Windows di solito li installa già npm (dipendenze opzionali): lo script verifica e basta.
// - Da Linux/macOS servono per creare la build Windows: npm salta i pacchetti con "os: win32".
// Uso: node scripts/fetch-win-binaries.mjs [--cuda]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {execFileSync, execSync} from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nlcPkg = path.join(root, "node_modules", "node-llama-cpp", "package.json");
if (!fs.existsSync(nlcPkg)) {
    console.error("ERRORE: node_modules/node-llama-cpp non trovato. Esegui prima 'npm ci' (o 'npm install').");
    process.exit(1);
}
const version = JSON.parse(fs.readFileSync(nlcPkg, "utf8")).version;
const pkgs = ["win-x64", "win-x64-vulkan"];
if (process.argv.includes("--cuda")) pkgs.push("win-x64-cuda", "win-x64-cuda-ext");

const isPresent = (p) => {
    const pj = path.join(root, "node_modules", "@node-llama-cpp", p, "package.json");
    return fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, "utf8")).version === version;
};

const missing = pkgs.filter((p) => {
    if (isPresent(p)) {
        console.log(`= @node-llama-cpp/${p}@${version} già presente`);
        return false;
    }
    return true;
});

if (missing.length) {
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "nlc-win-"));
    try {
        for (const p of missing) {
            const spec = `@node-llama-cpp/${p}@${version}`;
            console.log(`> scarico ${spec}`);
            let out = "";
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    // execSync con stringa: funziona sia con npm (Linux/macOS) sia con npm.cmd (Windows)
                    out = execSync(`npm pack ${spec} --silent`, {cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"]});
                    break;
                } catch (e) {
                    if (attempt === 3) throw new Error(`npm pack ${spec} fallito dopo 3 tentativi: ${e.message}`);
                    console.log(`  tentativo ${attempt} fallito, riprovo...`);
                }
            }
            const tgz = out.trim().split(/\r?\n/).pop().trim();
            const dest = path.join(root, "node_modules", "@node-llama-cpp", p);
            fs.rmSync(dest, {recursive: true, force: true});
            fs.mkdirSync(dest, {recursive: true});
            // Percorsi relativi + cwd: evita che GNU tar (Git Bash) scambi "D:\..." per un host remoto.
            const unpack = path.join(tmp, "unpack-" + p);
            fs.mkdirSync(unpack);
            execFileSync("tar", ["-xzf", tgz, "-C", path.basename(unpack)], {cwd: tmp, stdio: "inherit"});
            fs.cpSync(path.join(unpack, "package"), dest, {recursive: true});
        }
    } finally {
        fs.rmSync(tmp, {recursive: true, force: true});
    }
}

const still = pkgs.filter((p) => !isPresent(p));
if (still.length) {
    console.error("ERRORE: binari mancanti:", still.join(", "));
    process.exit(1);
}
console.log("binari Windows pronti:", pkgs.join(", "));
