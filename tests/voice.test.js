import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { synthesizeWyoming } from "../src/voice/voice.js";

// Wyoming wire format: JSON header line, followed by data_length JSON bytes
// and then payload_length binary bytes.
function frame(type, data = {}, payload = Buffer.alloc(0)) {
  const header = { type };
  const dataBytes = data && Object.keys(data).length ? Buffer.from(JSON.stringify(data), "utf8") : null;
  if (dataBytes?.length) header.data_length = dataBytes.length;
  if (payload.length) header.payload_length = payload.length;
  return Buffer.concat([
    Buffer.from(JSON.stringify(header) + "\n"),
    ...(dataBytes?.length ? [dataBytes] : []),
    payload
  ]);
}

async function withFakePiper(handler, run, {
  infoData = { tts: [{ name: "piper" }] },
  rawInfoFrame = null
} = {}) {
  const received = [];
  const server = createServer(socket => {
    let buffered = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) return;
        const headerBytes = buffered.subarray(0, newline);
        let header;
        try { header = JSON.parse(headerBytes.toString("utf8")); }
        catch { socket.destroy(); return; }
        const dataLength = Number(header.data_length || 0);
        const payloadLength = Number(header.payload_length || 0);
        if (!Number.isSafeInteger(dataLength) || dataLength < 0 ||
            !Number.isSafeInteger(payloadLength) || payloadLength < 0 ||
            buffered.length - newline - 1 < dataLength + payloadLength) return;
        const remaining = buffered.subarray(newline + 1);
        const dataBytes = remaining.subarray(0, dataLength);
        const payload = remaining.subarray(dataLength, dataLength + payloadLength);
        buffered = remaining.subarray(dataLength + payloadLength);
        let data = header.data || {};
        try {
          if (dataLength) data = JSON.parse(dataBytes.toString("utf8"));
        } catch { socket.destroy(); return; }
        const request = { type: header.type, ...(dataLength || header.data ? { data } : {}) };
        received.push(request);
        if (request.type === "describe") {
          // Wyoming's initial info event also uses data_length + JSON data bytes.
          socket.write(rawInfoFrame || frame("info", infoData));
        } else {
          handler(socket, request, payload);
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    return await run(`tcp://127.0.0.1:${address.port}`, received);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("Wyoming synthesis creates a valid WAV from protocol-shaped events", async () => {
  const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
  await withFakePiper(socket => {
    socket.end(Buffer.concat([
      frame("audio-start", { rate: 22050, width: 2, channels: 1 }),
      frame("audio-chunk", { timestamp: 0 }, pcm),
      frame("audio-stop")
    ]));
  }, async (url, received) => {
    const wav = await synthesizeWyoming("Hello from test", "en_US-lessac-medium", { url, timeoutMs: 1000 });
    assert.equal(received.length, 2);
    assert.deepEqual(received[0], { type: "describe" });
    assert.deepEqual(received[1], {
      type: "synthesize",
      data: { text: "Hello from test", voice: { name: "en_US-lessac-medium" } }
    });
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt32LE(24), 22050);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(40), pcm.length);
    assert.deepEqual(wav.subarray(44), pcm);
  }, {
    // Test a large but permitted info data frame from Piper's voice catalog.
    infoData: {
      tts: [{
        name: "piper",
        voices: Array.from({ length: 400 }, (_, i) => ({
          name: `voice-${i}`,
          description: "voice catalog metadata ".repeat(4)
        }))
      }]
    }
  });
});

test("Wyoming errors are surfaced as a safe synthesis failure", async () => {
  await withFakePiper(socket => {
    socket.end(frame("error", { code: "voice-not-found", text: "Voice is not installed" }));
  }, async url => {
    await assert.rejects(
      synthesizeWyoming("Hello", "en_US-lessac-medium", { url, timeoutMs: 1000 }),
      /Piper synthesis failed\./
    );
  });
});

test("Wyoming disconnect before audio-stop is rejected instead of returning partial audio", async () => {
  await withFakePiper(socket => {
    socket.end(frame("audio-start", { rate: 22050, width: 2, channels: 1 }));
  }, async url => {
    await assert.rejects(
      synthesizeWyoming("Hello", "en_US-lessac-medium", { url, timeoutMs: 1000 }),
      /disconnected before completing/
    );
  });
});

test("text length and voice name are validated before a connection is opened", async () => {
  await assert.rejects(
    synthesizeWyoming("x".repeat(1001), "en_US-lessac-medium", { url: "tcp://127.0.0.1:1" }),
    /1000-character limit/
  );
  await assert.rejects(
    synthesizeWyoming("Hello", "../voice", { url: "tcp://127.0.0.1:1" }),
    /simple voice identifier/
  );
});

test("Wyoming rejects an oversized header even when its newline arrives in the same packet", async () => {
  const rawInfoFrame = Buffer.from(JSON.stringify({
    type: "info",
    metadata: "x".repeat(1024 * 1024 + 1024)
  }) + "\n");
  await withFakePiper(socket => socket.end(frame("audio-stop")), async url => {
    await assert.rejects(
      synthesizeWyoming("Hello", "en_US-lessac-medium", { url, timeoutMs: 1000 }),
      /oversized event header/
    );
  }, { rawInfoFrame });
});

test("Wyoming rejects an oversized declared JSON data block", async () => {
  const rawInfoFrame = Buffer.from(JSON.stringify({
    type: "info",
    data_length: 1024 * 1024 + 1
  }) + "\n");
  await withFakePiper(socket => socket.end(frame("audio-stop")), async url => {
    await assert.rejects(
      synthesizeWyoming("Hello", "en_US-lessac-medium", { url, timeoutMs: 1000 }),
      /invalid event data length/
    );
  }, { rawInfoFrame });
});

test("invalid Wyoming audio metadata is rejected", async () => {
  await withFakePiper(socket => {
    socket.end(Buffer.concat([
      frame("audio-start", { rate: 0, width: 2, channels: 1 }),
      frame("audio-chunk", {}, Buffer.from([0, 0])),
      frame("audio-stop")
    ]));
  }, async url => {
    await assert.rejects(
      synthesizeWyoming("Hello", "en_US-lessac-medium", { url, timeoutMs: 1000 }),
      /unsupported audio format metadata/
    );
  });
});
