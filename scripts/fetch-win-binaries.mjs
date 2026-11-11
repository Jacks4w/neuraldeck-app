#!/usr/bin/env node
// Scarica i binari precompilati Windows di node-llama-cpp dentro node_modules
// (servono SOLO per creare la build Windows da Linux/macOS: npm salta i pacchetti
// opzionali con "os: win32" quando non sei su Windows).
// Uso: node scripts/fetch-win-binaries.mjs [--cuda]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {execFileSync} from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "node_modules/node-llama-cpp/package.json"), "utf8")).version;
const pkgs = ["win-x64", "win-x64-vulkan"];
if (process.argv.includes("--cuda")) pkgs.push("win-x64-cuda", "win-x64-cuda-ext");

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "nlc-win-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
for (const p of pkgs) {
    const dest = path.join(root, "node_modules/@node-llama-cpp", p);
    const pj = path.join(dest, "package.json");
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, "utf8")).version === version) {
        console.log(`= @node-llama-cpp/${p}@${version} già presente`);
        continue;
    }
    console.log(`> scarico @node-llama-cpp/${p}@${version}`);
    const tgz = execFileSync(npm, ["pack", `@node-llama-cpp/${p}@${version}`, "--pack-destination", tmp, "--silent"], {encoding: "utf8", shell: process.platform === "win32"}).trim().split("\n").pop();
    fs.rmSync(dest, {recursive: true, force: true});
    fs.mkdirSync(dest, {recursive: true});
    execFileSync("tar", ["-xzf", path.join(tmp, tgz), "-C", dest, "--strip-components=1"]);
}
fs.rmSync(tmp, {recursive: true, force: true});
console.log("binari Windows pronti:", pkgs.join(", "));
