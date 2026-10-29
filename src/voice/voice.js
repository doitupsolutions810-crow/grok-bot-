// Local speech backends for the Grok Bot voice surface.
// Full profile uses the private Wyoming TCP protocol exposed by the Piper sidecar.
// Core-only mode can still use a locally installed Piper CLI when configured.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WHISPER_URL = (process.env.WHISPER_URL || "").replace(/\/+$/, "");
const PIPER_CMD = process.env.PIPER_CMD || "piper";
const MAX_TEXT_CHARS = 1000;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_EVENT_DATA_BYTES = 1024 * 1024;
const AUDIO_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 5_000;

async function transcribeHttp(wavBuffer) {
  const form = new FormData();
  form.append("audio_file", new Blob([wavBuffer]), "audio.wav");
  const res = await fetch(`${WHISPER_URL}/asr?output=json`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`whisper http ${res.status}`);
  const out = await res.json();
  return String(out.text || "");
}

async function transcribeLocal(wavBuffer) {
  const dir = mkdtempSync(join(tmpdir(), "grok-whisper-"));
  const input = join(dir, "input.wav");
  try {
    writeFileSync(input, wavBuffer);
    return await new Promise((resolve, reject) => {
      const p = spawn("whisper-cli", ["-m", "/models/whisper-base.bin", "-f", input, "-nt"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", chunk => { if (out.length < 20_000) out += chunk.toString("utf8"); });
      p.on("error", reject);
      p.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error("whisper-cli failed")));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

function validateText(text) {
  const value = String(text ?? "").trim();
  if (!value) throw new Error("text is required.");
  if (value.length > MAX_TEXT_CHARS) throw new Error(`text exceeds the ${MAX_TEXT_CHARS}-character limit.`);
  return value;
}

function validateVoice(value) {
  const voice = String(value || "en_US-lessac-medium").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(voice)) {
    throw new Error("voice must be a simple voice identifier.");
  }
  return voice;
}

function parseWyomingUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error("PIPER_URL must use tcp://host:port."); }
  const port = Number(url.port);
  if (url.protocol !== "tcp:" || !url.hostname || !Number.isInteger(port) || port < 1 || port > 65535 ||
      url.username || url.password || !["", "/"].includes(url.pathname) || url.search || url.hash) {
    throw new Error("PIPER_URL must use tcp://host:port without credentials, path, query, or fragment.");
  }
  return { host: url.hostname, port };
}

class WyomingReader {
  constructor(socket) {
    this.iterator = socket[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }

  async fill(minBytes) {
    while (this.buffer.length < minBytes) {
      const next = await this.iterator.next();
      if (next.done) throw new Error("Piper disconnected before completing the audio response.");
      this.buffer = this.buffer.length
        ? Buffer.concat([this.buffer, next.value])
        : Buffer.from(next.value);
    }
  }

  async readLine(limit = MAX_HEADER_BYTES) {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline >= 0) {
        const line = this.buffer.subarray(0, newline).toString("utf8");
        this.buffer = this.buffer.subarray(newline + 1);
        return line;
      }
      if (this.buffer.length > limit) throw new Error("Piper sent an oversized event header.");
      await this.fill(this.buffer.length + 1);
    }
  }

  async readExact(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) {
      throw new Error("Piper sent an invalid event frame length.");
    }
    if (length === 0) return Buffer.alloc(0);
    await this.fill(length);
    const bytes = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return bytes;
  }

  async readEvent() {
    const line = await this.readLine();
    let header;
    try { header = JSON.parse(line); }
    catch { throw new Error("Piper sent an invalid event header."); }
    if (!header || typeof header.type !== "string") throw new Error("Piper sent an event without a type.");

    const dataLength = header.data_length === undefined ? 0 : header.data_length;
    if (!Number.isSafeInteger(dataLength) || dataLength < 0 || dataLength > MAX_EVENT_DATA_BYTES) {
      throw new Error("Piper sent an invalid event data length.");
    }
    let extra = {};
    if (dataLength) {
      try { extra = JSON.parse((await this.readExact(dataLength)).toString("utf8")); }
      catch { throw new Error("Piper sent invalid event data."); }
      if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
        throw new Error("Piper event data must be an object.");
      }
    }
    const data = { ...(header.data && typeof header.data === "object" ? header.data : {}), ...extra };
    const payloadLength = header.payload_length === undefined ? 0 : header.payload_length;
    if (!Number.isSafeInteger(payloadLength) || payloadLength < 0 || payloadLength > MAX_FRAME_BYTES) {
      throw new Error("Piper sent an invalid audio payload length.");
    }
    const payload = await this.readExact(payloadLength);
    return { type: header.type, data, payload };
  }
}

export function createWavHeader({ rate, width, channels }, payloadLength) {
  if (!Number.isInteger(rate) || rate < 8_000 || rate > 192_000 ||
      ![1, 2, 3, 4].includes(width) || ![1, 2].includes(channels) ||
      !Number.isSafeInteger(payloadLength) || payloadLength < 0 ||
      payloadLength > 0xffffffff - 36 || payloadLength % (width * channels) !== 0) {
    throw new Error("Piper returned unsupported audio format metadata.");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + payloadLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // integer PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * width * channels, 28);
  header.writeUInt16LE(width * channels, 32);
  header.writeUInt16LE(width * 8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(payloadLength, 40);
  return header;
}

async function synthesizeOnce(text, voice, endpoint, timeoutMs) {
  const socket = createConnection(endpoint);
  const reader = new WyomingReader(socket);
  let connectTimer;
  try {
    await new Promise((resolve, reject) => {
      connectTimer = setTimeout(() => {
        const error = new Error("Piper connection timed out.");
        error.code = "ETIMEDOUT";
        socket.destroy(error);
      }, CONNECT_TIMEOUT_MS);
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    clearTimeout(connectTimer);
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => {
      const error = new Error("Piper audio synthesis timed out.");
      error.code = "ETIMEDOUT";
      socket.destroy(error);
    });

    // Wyoming services start with describe/info before a request. Piper's
    // info event can include a long voice catalog, so the header/data caps are
    // bounded at 1 MiB rather than assuming a small response.
    socket.write(JSON.stringify({ type: "describe" }) + "\n");
    const description = await reader.readEvent();
    if (description.type !== "info") {
      throw new Error("Piper did not answer the Wyoming describe handshake.");
    }

    socket.write(JSON.stringify({
      type: "synthesize",
      data: { text, voice: { name: voice } }
    }) + "\n");

    let audioFormat = null;
    const chunks = [];
    let totalBytes = 0;
    for (;;) {
      const event = await reader.readEvent();
      if (event.type === "error") {
        // Do not echo remote error text into user-visible API responses.
        throw new Error("Piper synthesis failed.");
      }
      if (event.type === "audio-start") {
        audioFormat = {
          rate: Number(event.data?.rate),
          width: Number(event.data?.width),
          channels: Number(event.data?.channels)
        };
      } else if (event.type === "audio-chunk") {
        if (!audioFormat) throw new Error("Piper sent audio before audio-start.");
        totalBytes += event.payload.length;
        if (totalBytes > MAX_AUDIO_BYTES) throw new Error("Piper audio exceeded the 24 MiB response limit.");
        if (event.payload.length) chunks.push(event.payload);
      } else if (event.type === "audio-stop") {
        break;
      }
    }
    if (!audioFormat || totalBytes === 0) throw new Error("Piper returned no audio.");
    const pcm = Buffer.concat(chunks, totalBytes);
    return Buffer.concat([createWavHeader(audioFormat, pcm.length), pcm], 44 + pcm.length);
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
    socket.end();
    socket.destroy();
  }
}

export async function synthesizeWyoming(text, voice, { url = process.env.PIPER_URL, timeoutMs = AUDIO_TIMEOUT_MS } = {}) {
  const input = validateText(text);
  const selectedVoice = validateVoice(voice);
  const endpoint = parseWyomingUrl(url);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await synthesizeOnce(input, selectedVoice, endpoint, timeoutMs); }
    catch (error) {
      lastError = error;
      const retryable = ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT"].includes(error?.code);
      if (!retryable || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  const message = String(lastError?.message || "");
  const safeDiagnostic = message.startsWith("PIPER_URL") ||
    message.startsWith("Piper synthesis failed.") ||
    message.startsWith("Piper disconnected ") ||
    message.startsWith("Piper returned ") ||
    message.startsWith("Piper sent ");
  throw new Error(lastError?.code === "ETIMEDOUT" ? "Piper audio synthesis timed out." :
    safeDiagnostic ? message.slice(0, 240) : "Piper audio service is unavailable or rejected the request.");
}

function localSynthesis(text, voice) {
  return new Promise(resolve => {
    let directory;
    try { directory = mkdtempSync(join(tmpdir(), "grok-piper-")); }
    catch { resolve({ ok: false, error: "Local Piper could not create a temporary audio file." }); return; }
    const outputPath = join(directory, "speech.wav");
    let child;
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(directory, { recursive: true, force: true });
      resolve(result);
    };
    try {
      child = spawn(PIPER_CMD, ["--model", `/voices/${voice}.onnx`, "--output_file", outputPath], {
        stdio: ["pipe", "ignore", "ignore"]
      });
      child.on("error", () => finish({ ok: false, error: "Local Piper could not start; configure PIPER_URL for the full profile." }));
      child.on("close", code => {
        if (settled) return;
        if (code !== 0) { finish({ ok: false, error: "Local Piper returned a synthesis error." }); return; }
        try {
          const size = statSync(outputPath).size;
          if (size < 44 || size > MAX_AUDIO_BYTES + 44) {
            finish({ ok: false, error: "Local Piper returned an invalid or oversized WAV file." });
            return;
          }
          const audio = readFileSync(outputPath);
          if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
            finish({ ok: false, error: "Local Piper did not return a WAV file." });
            return;
          }
          finish({ ok: true, audio, voice, tts: "local-piper" });
        } catch {
          finish({ ok: false, error: "Local Piper did not produce readable WAV audio." });
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(text);
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ ok: false, error: "Local Piper audio synthesis timed out." });
      }, AUDIO_TIMEOUT_MS);
    } catch {
      finish({ ok: false, error: "Local Piper could not start." });
    }
  });
}

export async function speak(text, voice = process.env.TTS_VOICE || "en_US-lessac-medium") {
  let input;
  let selectedVoice;
  try {
    input = validateText(text);
    selectedVoice = validateVoice(voice);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  if (String(process.env.PIPER_URL || "").trim()) {
    try {
      const audio = await synthesizeWyoming(input, selectedVoice);
      return { ok: true, audio, voice: selectedVoice, tts: "wyoming-piper" };
    } catch (error) {
      return { ok: false, error: error.message || "Piper audio service is unavailable." };
    }
  }
  return localSynthesis(input, selectedVoice);
}
