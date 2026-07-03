"""
CallSession owns one aiortc RTCPeerConnection for one phone call, and bridges
its audio to/from a GeminiBridge instance.

Audio path:
  browser mic --(WebRTC/Opus)--> aiortc remote track --resample to 16k mono--> Gemini
  Gemini audio (24k mono PCM16) --resample to 48k mono--> aiortc local track --(WebRTC/Opus)--> browser speaker

We use PyAV (bundled with aiortc) for resampling since it's already a
dependency and avoids pulling in extra native libs.
"""

import asyncio
import fractions
import logging

import av
import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from aiortc.mediastreams import MediaStreamError

from gemini_bridge import GeminiBridge, INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE

logger = logging.getLogger("webrtc_session")

WEBRTC_SAMPLE_RATE = 48000  # aiortc/Opus default
FRAME_MS = 20
OUT_SAMPLES_PER_FRAME = WEBRTC_SAMPLE_RATE * FRAME_MS // 1000  # 960 @ 48k/20ms


class GeminiAudioOutputTrack(MediaStreamTrack):
    """A local audio track whose samples come from Gemini's spoken replies."""

    kind = "audio"

    def __init__(self, pcm24k_queue: asyncio.Queue[bytes]):
        super().__init__()
        self._queue = pcm24k_queue
        self._resampler = av.AudioResampler(format="s16", layout="mono", rate=WEBRTC_SAMPLE_RATE)
        self._pts = 0
        self._leftover = np.empty((0,), dtype=np.int16)

    async def _next_pcm24k_chunk(self) -> bytes:
        try:
            return await asyncio.wait_for(self._queue.get(), timeout=FRAME_MS / 1000 * 5)
        except asyncio.TimeoutError:
            # Silence while Gemini is "thinking" / between utterances
            silence_samples = int(OUTPUT_SAMPLE_RATE * FRAME_MS / 1000)
            return np.zeros(silence_samples, dtype=np.int16).tobytes()

    async def recv(self):
        # Pull enough 24kHz samples, resample to 48kHz, and hand back exactly
        # one 20ms frame at a time so the RTP pacing stays smooth.
        while self._leftover.shape[0] < OUT_SAMPLES_PER_FRAME:
            chunk = await self._next_pcm24k_chunk()
            in_samples = np.frombuffer(chunk, dtype=np.int16)
            in_frame = av.AudioFrame.from_ndarray(
                in_samples.reshape(1, -1), format="s16", layout="mono"
            )
            in_frame.sample_rate = OUTPUT_SAMPLE_RATE
            for out_frame in self._resampler.resample(in_frame):
                resampled = out_frame.to_ndarray().reshape(-1)
                self._leftover = np.concatenate([self._leftover, resampled])

        frame_samples, self._leftover = (
            self._leftover[:OUT_SAMPLES_PER_FRAME],
            self._leftover[OUT_SAMPLES_PER_FRAME:],
        )

        frame = av.AudioFrame.from_ndarray(
            frame_samples.reshape(1, -1), format="s16", layout="mono"
        )
        frame.sample_rate = WEBRTC_SAMPLE_RATE
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, WEBRTC_SAMPLE_RATE)
        self._pts += OUT_SAMPLES_PER_FRAME
        return frame


class CallSession:
    def __init__(self, call_id: str, user_id: str, name: str, language: str, emit_transcript):
        self.call_id = call_id
        self.user_id = user_id
        self.pc = RTCPeerConnection()
        self._emit_transcript = emit_transcript  # async fn(call_id, role, text)

        self.bridge = GeminiBridge(
            call_id=call_id,
            user_name=name,
            language=language,
            on_transcript=lambda role, text: emit_transcript(call_id, role, text),
        )

        self._resample_in = av.AudioResampler(
            format="s16", layout="mono", rate=INPUT_SAMPLE_RATE
        )

        @self.pc.on("track")
        def on_track(track):
            logger.info("call %s: remote track received, kind=%s", call_id, track.kind)
            if track.kind == "audio":
                asyncio.ensure_future(self._pump_user_audio(track))

        @self.pc.on("connectionstatechange")
        async def on_state_change():
            logger.info("call %s: pc state -> %s", call_id, self.pc.connectionState)

    async def start(self):
        await self.bridge.start()
        self.pc.addTrack(GeminiAudioOutputTrack(self.bridge.audio_out_queue))

    async def _pump_user_audio(self, track):
        """Read the browser's mic track, resample to 16k mono, forward to Gemini."""
        frame_count = 0
        try:
            while True:
                frame = await track.recv()
                for out_frame in self._resample_in.resample(frame):
                    pcm = out_frame.to_ndarray().astype(np.int16).tobytes()
                    try:
                        await self.bridge.push_user_audio(pcm)
                    except Exception:
                        logger.exception(
                            "call %s: push_user_audio failed on frame %d",
                            self.call_id, frame_count,
                        )
                        continue  # don't let one bad chunk kill the whole call
                    frame_count += 1
                    if frame_count % 100 == 0:
                        logger.info(
                            "call %s: forwarded %d audio chunks to Gemini (last chunk=%d bytes)",
                            self.call_id, frame_count, len(pcm),
                        )
        except MediaStreamError:
            logger.info("call %s: user audio track ended after %d chunks", self.call_id, frame_count)
        except Exception:
            logger.exception("call %s: error pumping user audio after %d chunks", self.call_id, frame_count)

    async def handle_offer(self, sdp: str, sdp_type: str) -> RTCSessionDescription:
        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
        answer = await self.pc.createAnswer()
        await self.pc.setLocalDescription(answer)
        return self.pc.localDescription

    async def add_ice_candidate(self, candidate):
        if candidate:
            await self.pc.addIceCandidate(candidate)

    async def close(self):
        await self.bridge.close()
        await self.pc.close()