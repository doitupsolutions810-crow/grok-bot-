import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { synthesizeWyoming } from "../src/voice/voice.js";

function frame(type, data = {}, payload = Buffer.alloc(0)) {
  const header = { type, data };
  if (payload.length) header.payload_length = payload.length;
  return Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), payload]);
}

async function withFakePiper(handler, run, { infoData = { tts: [{ name: "piper" }] } = {} } = {}) {
  const received = [];
  const server = createServer(socket => {
    let buffered = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) return;
        const line = buffered.subarray(0, newline).toString("utf8");
        buffered = buffered.subarray(newline + 1);
        try {
          const request = JSON.parse(line);
          received.push(request);
          if (request.type === "describe") {
            // Wyoming requires an info reply before the synthesis request.
            socket.write(frame("info", infoData));
          } else {
            handler(socket, request);
          }
        } catch {
          socket.destroy();
          return;
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

test("Wyoming synthesis creates a valid WAV from audio-start and audio-chunk events", async () => {
  const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
  await withFakePiper((socket, request) => {
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
    // Piper can advertise a large voice catalog in the initial info event.
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
