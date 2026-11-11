# NEURAL//DECK — chatbot locale sulle lezioni (MVP Windows)

App desktop per Windows che risponde alle domande degli studenti **usando solo le trascrizioni delle lezioni**, con un modello di intelligenza artificiale che gira **interamente sul PC dello studente** (CPU e/o GPU). Nessun costo cloud, nessun credito consumato, funziona offline dopo il primo download.

- Interfaccia stile ChatGPT con estetica cyberpunk/hacker: sidebar delle sessioni, risposte in streaming, pulsante KILL per interrompere.
- **Primo avvio guidato**: rileva RAM e GPU, consiglia il modello (STANDARD 4B o LITE 1.5B), lo scarica con una barra di avanzamento e lo salva nella cartella dati dell'utente.
- Pulsante **⟳ AGGIORNA**: scarica il manifest JSON dal tuo link, poi **solo** le trascrizioni nuove o modificate, e aggiorna l'indice in modo incrementale.
- **RAG multilingue**: trascrizioni in inglese, domande in qualsiasi lingua (italiano, inglese, cinese, russo, croato, spagnolo, turco…). Risponde nella lingua della domanda e cita la lezione di origine (le fonti compaiono anche come etichette `SRC` sotto ogni risposta).

> Stato: **MVP**. La build Windows è stata generata, ma **non è stata provata su un PC Windows reale** (vedi [Cosa è stato testato](#cosa-è-stato-testato-e-cosa-no)).

---

## 1. Requisiti minimi (PC dello studente)

| | LITE (Qwen2.5 1.5B) | STANDARD (Qwen3 4B) — consigliato |
|---|---|---|
| Sistema | Windows 10/11 64 bit | Windows 10/11 64 bit |
| RAM | 4 GB (meglio 6) | 8 GB |
| GPU | non necessaria | facoltativa: con una GPU da 4 GB+ è molto più veloce |
| Disco | ~2 GB liberi | ~3,5 GB liberi |
| Internet | solo per il primo download e per AGGIORNA | idem |

- **GPU**: l'app prova prima la GPU tramite **Vulkan** (NVIDIA, AMD e Intel con driver aggiornati), poi passa **automaticamente alla CPU** se la GPU manca o il caricamento fallisce. Nelle impostazioni si può forzare "CPU ONLY".
- Se un PC è troppo debole, lo studente può usare il PC di un compagno o un computer dell'accademia: l'app è per utente e non richiede account.
- Velocità indicativa (CPU, misurata sulla VM di sviluppo, che è molto più potente di un portatile): 6–16 s a risposta col modello LITE e 25–50 s con lo STANDARD. **Su un portatile normale senza GPU ci si aspetti tempi più lunghi**, ma il testo compare man mano (streaming).

## 2. Installazione per gli studenti

1. Scaricare `NeuralDeck-Setup-x.y.z-x64.exe` (installer) oppure `NeuralDeck-x.y.z-win-x64.zip` (versione portatile: si estrae e si avvia `NeuralDeck.exe`).
2. L'app **non è firmata digitalmente**: Windows SmartScreen mostrerà "Windows ha protetto il PC" → **Ulteriori informazioni → Esegui comunque**.
3. Al primo avvio parte la sequenza di boot: scansione dell'hardware, poi si sceglie il modello (quello consigliato è evidenziato) e si preme **DOWNLOAD**. Il modello viene scaricato da Hugging Face una sola volta (circa 1,5 GB per LITE e 2,9 GB per STANDARD, compreso il modello di ricerca multilingue). Se il download si interrompe, riprende da dove era rimasto.
4. Premere **⟳ AGGIORNA** per scaricare le trascrizioni. Da quel momento si può chattare.
5. A ogni nuova lezione basta premere di nuovo **AGGIORNA**: vengono scaricati solo i file nuovi o modificati.

Cartella dati (modelli, indice, conversazioni, log): `%APPDATA%\NeuralDeck` (pulsante **OPEN DATA DIR** nelle impostazioni). Per un'aula senza internet si possono copiare i file `.gguf` nella sottocartella `models\`: l'app li riconosce e non li riscarica.

## 3. Pubblicare trascrizioni e manifest (docente)

### Formato del manifest

```json
{
  "course": "Synthesizers 101",
  "version": "2026-11-11",
  "transcripts": [
    {
      "id": "lesson-01-oscillators",
      "lesson": 1,
      "title": "Oscillators and Waveforms",
      "url": "transcripts/lesson-01-oscillators.txt",
      "sha256": "a5207aeb…"
    }
  ]
}
```

| Campo | Obbligatorio | Note |
|---|---|---|
| `id` | consigliato | identificativo stabile della lezione (non cambiarlo, altrimenti la lezione viene vista come nuova) |
| `url` | **sì** | link diretto al file, oppure percorso **relativo** al manifest |
| `title`, `lesson` | consigliati | usati nelle citazioni, ad esempio `[Lesson 1: Oscillators and Waveforms]` |
| `sha256` | facoltativo | se presente, il file viene riscaricato solo quando l'hash cambia e viene verificato dopo il download |
| `version` | facoltativo | alternativa all'hash: aumentare il numero quando si modifica la trascrizione |

Senza `sha256` né `version` il file viene riscaricato a ogni AGGIORNA, ma reindicizzato solo se il contenuto è cambiato. Le lezioni tolte dal manifest vengono rimosse dall'indice (opzione disattivabile). Formati accettati: `.txt`, `.md`, `.srt`, `.vtt` (timestamp rimossi in automatico), in UTF-8.

**Generare il manifest in automatico** (calcola gli hash per te):

```bash
node scripts/make-manifest.mjs cartella_trascrizioni --course "Synthesizers 101" --out manifest.json
# con link assoluti:
node scripts/make-manifest.mjs cartella_trascrizioni --base-url https://raw.githubusercontent.com/UTENTE/REPO/main/transcripts
```

Il titolo viene letto dalla prima riga del file, se ha la forma `Lesson 3 - Envelopes…`.

### Dove ospitare i file

- **GitHub (consigliato)**: un repository pubblico con `manifest.json` e una cartella `transcripts/`. Usare il link **raw**: `https://raw.githubusercontent.com/UTENTE/REPO/main/manifest.json`. Con URL relativi nel manifest non serve altro. I link `github.com/.../blob/...` vengono convertiti in raw automaticamente.
- **Google Drive**: condividere ogni file come "Chiunque abbia il link". Funzionano sia il link di condivisione `https://drive.google.com/file/d/ID/view` (convertito in automatico) sia `https://drive.google.com/uc?export=download&id=ID`. Su Drive gli URL relativi non funzionano: nel manifest servono link assoluti, uno per file.
- **Dropbox**: link di condivisione, convertito automaticamente da `dl=0` a `dl=1`.
- Se un link restituisce una pagina HTML (file privato, pagina di login), l'aggiornamento lo segnala chiaramente e salta quel file.

### URL di default

L'URL del manifest predefinito si imposta **prima della build** in `config/defaults.json` (`manifestUrl`). Lo studente può cambiarlo in **SETTINGS**. Il pulsante **LOAD DEMO TRANSCRIPTS** carica le 3 trascrizioni di esempio incluse (`sample/`).

## 4. Compilare

Requisiti: Node.js 22+, Git.

```bash
npm install
npm test                     # test unitari (updater, indice, lingua, ecc.)
npm start                    # avvia l'app in sviluppo
```

### Installer `.exe` con GitHub Actions (metodo consigliato)

Il workflow `.github/workflows/build-windows.yml` gira su `windows-latest` ed esegue: installazione, test, verifica che llama.cpp si carichi su Windows, build **NSIS (installer .exe) + zip portatile**. Avvio:
- manuale: tab **Actions → Build Windows installer → Run workflow** (opzione per includere CUDA);
- automatico: push di un tag `v*` (es. `git tag v0.1.0 && git push --tags`), che allega i file anche alla Release.

Gli artefatti si scaricano dalla pagina del job (`NeuralDeck-windows`).

### Build da Linux/macOS (solo zip portatile)

```bash
npm run win:binaries         # scarica i binari llama.cpp per Windows (CPU + Vulkan; --cuda per CUDA)
npm run dist:win:zip         # -> release/NeuralDeck-x.y.z-win-x64.zip
```

L'installer NSIS da Linux richiede Wine funzionante; nella VM usata per lo sviluppo Wine non si avvia, per questo l'installer si genera con GitHub Actions.

### Smoke test con i modelli reali

```bash
MODELS_DIR=/percorso/ai/gguf TIER=lite node scripts/rag-smoke.mjs   # oppure TIER=standard
```

Indicizza le trascrizioni di esempio e fa domande in 8 lingue, mostrando la lingua rilevata, le fonti e i tempi.

## 5. Architettura

- **Electron** (UI) + **node-llama-cpp 3.22** (llama.cpp con binari precompilati per CPU, Vulkan e CUDA).
- LLM: `Qwen3-4B-Instruct-2507 Q4_K_M` (STANDARD) oppure `Qwen2.5-1.5B-Instruct Q4_K_M` (LITE). Contesto di 4096 token.
- Embedding: **BGE-M3 Q4_K_M** (multilingue, 1024 dimensioni, eseguito su CPU per non occupare VRAM).
- Pipeline: rilevamento della lingua (alfabeto + franc) → traduzione della domanda in inglese (attivabile/disattivabile) → ricerca coseno su domanda originale + traduzione → top-K estratti → prompt con istruzione esplicita sulla lingua di risposta → streaming.
- Indice: file JSON locale (`index/vectors.json`, vettori Float32 in base64). Per un corso (decine di lezioni) la ricerca esaustiva richiede pochi millisecondi.
- Codice: `src/main/` (engine, updater, rag, vectorstore, stores), `src/renderer/` (UI), `sample/` (manifest + 3 trascrizioni sui sintetizzatori), `test/`.

## 6. Cosa è stato testato e cosa no

**Testato sulla VM Linux (x64, solo CPU):**
- 11 test unitari superati: manifest (validazione, link Drive/Dropbox/GitHub), aggiornamento incrementale su un server HTTP reale (aggiunta, file invariati non riscaricati, modifica via hash/versione/contenuto, hash errato, 404, rimozione, cambio del modello di embedding, ricostruzione offline), pulizia SRT, chunking, rilevamento della lingua (it, hr, tr, ru, zh, es, en, con cronologia in un'altra lingua), sessioni senza "New Chat" vuote duplicate.
- Pipeline RAG con i modelli veri (LITE e STANDARD): domande in inglese, italiano, spagnolo, cinese, russo, croato e turco → lingua corretta, lezione giusta recuperata e citata. Una domanda fuori tema (calcio) → l'app risponde che l'informazione non è nelle lezioni.
- App Electron avviata (sviluppo e build impacchettata Linux): download reale del modello dalla procedura guidata, AGGIORNA via HTTP (prima volta: 3 nuove; seconda: 3 invariate), errore chiaro con URL non configurato, chat in streaming, KILL, titoli automatici delle sessioni, persistenza dopo il riavvio.
- Build Windows: lo **zip portatile** è stato generato da Linux (contiene `NeuralDeck.exe` PE32+ x64 e i binari llama.cpp Windows per CPU e Vulkan).

**NON testato:**
- **Avvio su Windows reale**: né lo zip né l'installer sono stati eseguiti su Windows (Wine non funziona in questa VM). Va provato su un PC Windows prima di distribuirlo agli studenti.
- **Installer NSIS**: non generato qui. Il workflow GitHub Actions è scritto ma non ancora eseguito.
- **Accelerazione GPU** (Vulkan/CUDA): la VM non ha GPU. È testato solo il percorso CPU; il fallback GPU→CPU è implementato ma non provato.
- Prestazioni su portatili con 4–8 GB di RAM.
- Link reali di Google Drive o Dropbox: è testata la conversione degli URL, non il download effettivo da quei servizi.

## 7. Limiti noti

- Il modello **LITE (1.5B) sbaglia spesso** anche con il testo giusto davanti (nei test ha confuso, per esempio, Sustain e Release). Va bene come ripiego, ma per lo studio conviene STANDARD. Le etichette `SRC` indicano la lezione da ricontrollare.
- Lingue meno diffuse (es. croato, turco): risposte comprensibili ma con errori grammaticali, soprattutto con LITE.
- Se l'URL del manifest non è impostato in `config/defaults.json`, ogni studente deve incollarlo a mano in SETTINGS.
- PDF non supportati: convertire in `.txt`.
- App non firmata (avviso SmartScreen); nessun aggiornamento automatico dell'app (solo dei contenuti).
- Solo Windows x64 (Mac/ARM in futuro: il codice è già multipiattaforma).

## 8. Licenze

| Componente | Licenza |
|---|---|
| Codice NeuralDeck | MIT |
| Qwen3-4B-Instruct-2507 (GGUF di unsloth) | Apache 2.0 |
| Qwen2.5-1.5B-Instruct (GGUF ufficiale Qwen) | Apache 2.0 |
| BGE-M3 (BAAI, GGUF di gpustack) | MIT |
| node-llama-cpp / llama.cpp | MIT |
| Electron | MIT |

Tutti i modelli consentono anche l'uso commerciale. Attenzione: **Qwen2.5-3B NON è stato scelto** perché ha la "Qwen Research License" (non commerciale), diversa dall'Apache 2.0 degli altri modelli Qwen. I modelli non sono inclusi nell'installer: vengono scaricati da Hugging Face al primo avvio.
