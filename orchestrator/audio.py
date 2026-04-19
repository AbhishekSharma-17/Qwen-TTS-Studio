"""Small audio helpers — MIME mapping and PCM→WAV wrapper for UI downloads."""
from __future__ import annotations

import io
import struct

MIME_BY_FORMAT = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "flac": "audio/flac",
    "pcm": "audio/L16; rate=24000; channels=1",
    "aac": "audio/aac",
    "opus": "audio/ogg; codecs=opus",
}


def response_mime(fmt: str) -> str:
    return MIME_BY_FORMAT.get(fmt.lower(), "application/octet-stream")


def pcm16_to_wav(pcm_bytes: bytes, sample_rate: int = 24000) -> bytes:
    """Wrap raw little-endian 16-bit mono PCM in a minimal WAV header.

    Handy for turning the streaming PCM output into a downloadable WAV
    without pulling ffmpeg.
    """
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_len = len(pcm_bytes)
    riff_len = 36 + data_len
    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", riff_len))
    buf.write(b"WAVEfmt ")
    buf.write(struct.pack("<I", 16))              # fmt chunk size
    buf.write(struct.pack("<H", 1))               # PCM
    buf.write(struct.pack("<H", num_channels))
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", byte_rate))
    buf.write(struct.pack("<H", block_align))
    buf.write(struct.pack("<H", bits_per_sample))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_len))
    buf.write(pcm_bytes)
    return buf.getvalue()
