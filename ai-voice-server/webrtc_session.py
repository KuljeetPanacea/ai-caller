"""
CallSession owns one aiortc RTCPeerConnection for one phone call.
This implementation removes Gemini-specific execution and offers a silent
backend audio track so the browser can complete WebRTC negotiation.
"""

import asyncio
import fractions
import logging

import av
import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from aiortc.mediastreams import MediaStreamError

logger = logging.getLogger("webrtc_session")

WEBRTC_SAMPLE_RATE = 48000  # aiortc/Opus default
FRAME_MS = 20
OUT_SAMPLES_PER_FRAME = WEBRTC_SAMPLE_RATE * FRAME_MS // 1000  # 960 @ 48k/20ms


class SilentAudioOutputTrack(MediaStreamTrack):
    """A local audio track that emits silence."""

    kind = "audio"

    def __init__(self):
        super().__init__()
        self._pts = 0

    async def recv(self):
        samples = np.zeros((1, OUT_SAMPLES_PER_FRAME), dtype=np.int16)
        frame = av.AudioFrame.from_ndarray(samples, format="s16", layout="mono")
        frame.sample_rate = WEBRTC_SAMPLE_RATE
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, WEBRTC_SAMPLE_RATE)
        self._pts += OUT_SAMPLES_PER_FRAME
        await asyncio.sleep(FRAME_MS / 1000)
        return frame


class CallSession:
    def __init__(self, call_id: str, user_id: str, name: str, language: str):
        self.call_id = call_id
        self.user_id = user_id
        self.pc = RTCPeerConnection()

        @self.pc.on("track")
        def on_track(track):
            logger.info("call %s: remote track received, kind=%s", call_id, track.kind)
            if track.kind == "audio":
                asyncio.create_task(self._drain_user_audio(track))

        @self.pc.on("connectionstatechange")
        async def on_state_change():
            logger.info("call %s: pc state -> %s", call_id, self.pc.connectionState)

    async def start(self):
        self.pc.addTrack(SilentAudioOutputTrack())

    async def _drain_user_audio(self, track):
        frame_count = 0
        try:
            while True:
                await track.recv()
                frame_count += 1
                if frame_count % 100 == 0:
                    logger.info("call %s: drained %d incoming audio frames", self.call_id, frame_count)
        except MediaStreamError:
            logger.info("call %s: user audio track ended after %d frames", self.call_id, frame_count)
        except Exception:
            logger.exception("call %s: error draining user audio after %d frames", self.call_id, frame_count)

    async def handle_offer(self, sdp: str, sdp_type: str) -> RTCSessionDescription:
        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
        answer = await self.pc.createAnswer()
        await self.pc.setLocalDescription(answer)
        return self.pc.localDescription

    async def add_ice_candidate(self, candidate):
        if candidate:
            await self.pc.addIceCandidate(candidate)

    async def close(self):
        await self.pc.close()
