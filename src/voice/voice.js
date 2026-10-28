// Grok Voice equivalent, fully local.
// STT — two real backends, tried in order:
//   1. WHISPER_URL: the full-profile Whisper sidecar (whisper-asr-webservice,
//      POST /asr multipart, output=json)
//   2. a local whisper-cli binary (setups with whisper.cpp installed)
// TTS — the piper binary when installed (PIPER_CMD overrides the path);
// resolves {ok:false, error} instead of throwing so /voice/tts degrades
// gracefully instead of 500ing.
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

const WHISPER_URL = (process.env.WHISPER_URL || "").replace(/\/+$/, "");
const PIPER_CMD = process.env.PIPER_CMD || "piper";

async function transcribeHttp(wavBuffer) {
  const form = new FormData();
  form.append("audio_file", new Blob([wavBuffer]), "audio.wav");
  const res = await fetch(`${WHISPER_URL}/asr?output=json`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`whisper http ${res.status}`);
  const out = await res.json();
  return String(out.text || "");
}

async function transcribeLocal(wavBuffer) {
  writeFileSync("/tmp/in.wav", wavBuffer);
  try {
    return await new Promise((resolve, reject) => {
      const p = spawn("whisper-cli", ["-m", "/models/whisper-base.bin", "-f", "/tmp/in.wav", "-nt"]);
      let out = "";
      p.stdout.on("data", d => out += d);
      p.on("close", () => resolve(out.trim()));
      p.on("error", reject);
    });
  } finally {
    try { unlinkSync("/tmp/in.wav"); } catch { /* already gone */ }
  }
}

export async function transcribe(wavBuffer) {
  if (WHISPER_URL) {
    try { return await transcribeHttp(wavBuffer); }
    catch (e) { console.warn("[voice] whisper sidecar failed, trying local backend:", e.message); }
  }
  try { return await transcribeLocal(wavBuffer); }
  catch {
    throw new Error("no STT backend available: set WHISPER_URL (full profile) or install whisper.cpp");
  }
}

export async function speak(text, voice = "en_US-lessac-medium") {
  return await new Promise(resolve => {
    const p = spawn(PIPER_CMD, ["--model", `/voices/${voice}.onnx`, "--output-raw"]);
    p.on("error", e => resolve({
      ok: false, tts: "none",
      error: `TTS unavailable (${PIPER_CMD} not installed): ${e.message}`
    }));
    p.on("close", code => code === 0
      ? resolve({ ok: true, tts: "piper", voice })
      : resolve({ ok: false, tts: "piper", error: `piper exited with code ${code}` }));
    p.stdout.on("data", () => {});      // audio stream consumed downstream
    p.stdin.on("error", () => {});      // never crash the route on EPIPE
    p.stdin.write(String(text));
    p.stdin.end();
  });
}
