// Gapless WebAudio player for a streamed 16-bit little-endian mono PCM body.
// - Accumulates received bytes so the UI can offer a mid-stream or final WAV download.
// - Emits onBytes / onFirstAudio / onDone callbacks the UI uses for progress + state.
// - stop() is idempotent and fully cleans all scheduled sources.

export class PcmStreamPlayer {
  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.ctx = null;
    this.nextStart = 0;
    this.sources = [];
    this.pcmBuffers = [];
    this.totalBytes = 0;
    this.stopped = false;
    this.finished = false;
    this.onBytes = null;         // (totalBytes, durationSec) => void
    this.onFirstAudio = null;    // () => void  (fires when the first chunk is actually scheduled)
    this.onDone = null;          // () => void  (fires after the upstream stream ends naturally)
    this.onPlaybackEnd = null;   // () => void  (fires when the WebAudio buffer queue has drained)
    this._firstScheduled = false;
    this._playbackEndTimer = null;
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
    }
  }

  /** Total seconds of audio received so far (approx: 2 bytes/sample, mono). */
  receivedSeconds() {
    return this.totalBytes / (this.sampleRate * 2);
  }

  async playStream(response) {
    this._ensureCtx();
    // small prebuffer absorbs fetch-chunk jitter
    this.nextStart = this.ctx.currentTime + 0.05;
    const reader = response.body.getReader();
    let tail = new Uint8Array(0);
    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        this.pcmBuffers.push(value);
        this.totalBytes += value.length;
        if (this.onBytes) this.onBytes(this.totalBytes, this.receivedSeconds());

        const merged = new Uint8Array(tail.length + value.length);
        merged.set(tail);
        merged.set(value, tail.length);
        const evenLen = merged.length & ~1;
        const pcm16 = new Int16Array(merged.buffer, 0, evenLen / 2);
        tail = merged.slice(evenLen);

        if (pcm16.length === 0) continue;
        const f32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;
        const buf = this.ctx.createBuffer(1, f32.length, this.sampleRate);
        buf.getChannelData(0).set(f32);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        const startAt = Math.max(this.nextStart, this.ctx.currentTime + 0.02);
        src.start(startAt);
        this.nextStart = startAt + buf.duration;
        this.sources.push(src);

        if (!this._firstScheduled) {
          this._firstScheduled = true;
          if (this.onFirstAudio) this.onFirstAudio();
        }
      }
    } finally {
      try { reader.cancel?.(); } catch {}
    }
    this.finished = !this.stopped;
    if (this.finished && this.onDone) this.onDone();

    // Fire onPlaybackEnd when the scheduled buffer queue actually drains.
    // (onDone fires when fetch completes; audio may still be playing after.)
    if (!this.stopped && this.ctx && this.onPlaybackEnd) {
      const remainingMs = Math.max(0, (this.nextStart - this.ctx.currentTime) * 1000);
      clearTimeout(this._playbackEndTimer);
      this._playbackEndTimer = setTimeout(() => {
        if (!this.stopped && this.onPlaybackEnd) this.onPlaybackEnd();
      }, remainingMs + 30);
    }
  }

  /** Stop playback immediately; idempotent. Upstream reader is still aborted via the caller's AbortController. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this._playbackEndTimer);
    for (const s of this.sources) {
      try { s.stop(0); } catch {}
      try { s.disconnect(); } catch {}
    }
    this.sources = [];
  }

  /** Assemble a WAV blob from all PCM bytes received so far (even a partial/aborted stream). */
  toWavBlob() {
    const totalLen = this.totalBytes & ~1;
    const buf = new Uint8Array(44 + totalLen);
    const dv = new DataView(buf.buffer);
    let p = 0;
    const writeStr = (s) => { for (const c of s) buf[p++] = c.charCodeAt(0); };
    const writeU32 = (v) => { dv.setUint32(p, v, true); p += 4; };
    const writeU16 = (v) => { dv.setUint16(p, v, true); p += 2; };
    writeStr("RIFF");
    writeU32(36 + totalLen);
    writeStr("WAVE");
    writeStr("fmt ");
    writeU32(16);
    writeU16(1);              // PCM
    writeU16(1);              // mono
    writeU32(this.sampleRate);
    writeU32(this.sampleRate * 2);
    writeU16(2);
    writeU16(16);
    writeStr("data");
    writeU32(totalLen);

    let written = 0;
    for (const chunk of this.pcmBuffers) {
      const take = Math.min(chunk.length, totalLen - written);
      buf.set(chunk.subarray(0, take), 44 + written);
      written += take;
      if (written >= totalLen) break;
    }
    return new Blob([buf], { type: "audio/wav" });
  }
}
