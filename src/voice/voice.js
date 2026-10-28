// Grok Voice equivalent, fully local: Whisper.cpp for STT, Piper for TTS.
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

export async function transcribe(wavBuffer) {
  writeFileSync("/tmp/in.wav", wavBuffer);
  return await new Promise((resolve, reject) => {
    const p = spawn("whisper-cli", ["-m", "/models/whisper-base.bin", "-f", "/tmp/in.wav", "-nt"]);
    let out = "";
    p.stdout.on("data", d => out += d);
    p.on("close", () => { unlinkSync("/tmp/in.wav"); resolve(out.trim()); });
    p.on("error", reject);
  });
}

export async function speak(text, voice = "en_US-lessac-medium") {
  return await new Promise((resolve, reject) => {
    const p = spawn("piper", ["--model", `/voices/${voice}.onnx`, "--output-raw"]);
    p.stdout.on("data", () => {});
    p.on("close", code => code === 0 ? resolve({ ok: true, tts: "piper", voice }) : reject(new Error("tts failed")));
    p.on("error", reject);
    p.stdin.write(text);
    p.stdin.end();
  });
}
