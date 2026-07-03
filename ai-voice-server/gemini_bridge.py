"""
GeminiBridge wraps a single Gemini Live session for one phone call.

Responsibilities:
  - Open a Gemini Live streaming session (bidirectional audio)
  - Accept 16kHz mono PCM16 chunks from the user's mic (push_user_audio)
  - Yield 24kHz mono PCM16 chunks of Gemini's spoken reply (via an asyncio.Queue)
  - Forward transcript lines (both sides) to a callback so they can be
    relayed to the signaling server and stored in Mongo

This isolates all Gemini-specific code from the WebRTC/aiortc plumbing in
webrtc_session.py.
"""

import asyncio
import logging
import os

from google import genai
from google.genai import types

logger = logging.getLogger("gemini_bridge")

GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-001")

# Gemini Live audio contract (as of the Live API): 16kHz PCM16 mono input,
# 24kHz PCM16 mono output. Keep these as constants so webrtc_session.py can
# resample to/from whatever the browser's WebRTC track is actually using.
INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000


class GeminiBridge:
    def __init__(self, call_id: str, user_name: str, language: str, on_transcript):
        self.call_id = call_id
        self.user_name = user_name
        self.language = language
        self.on_transcript = on_transcript  # async callback(role: str, text: str)

        self._client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        self._session_cm = None
        self._session = None
        self.audio_out_queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._closed = False
        self._recv_task: asyncio.Task | None = None

    def _system_instruction(self) -> str:
        return (
            "You are a warm, concise voice assistant placing a check-in phone call "
            f"to a person named {self.user_name}. Speak naturally, keep turns short "
            "(1-3 sentences), and let them talk. Open the call with a friendly, "
            "brief greeting and ask how they're doing. "
            f"Respond in this language: {self.language}."
        )

    async def start(self):
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=types.Content(
                parts=[types.Part(text=self._system_instruction())]
            ),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
                )
            ),
            # Ask Gemini to also give us text transcripts of both sides so we
            # can store them, even though the primary output is audio.
            output_audio_transcription=types.AudioTranscriptionConfig(),
            input_audio_transcription=types.AudioTranscriptionConfig(),
        )

        self._session_cm = self._client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=config)
        self._session = await self._session_cm.__aenter__()
        self._recv_task = asyncio.create_task(self._receive_loop())

        # Kick the AI off so it speaks first (it "placed the call").
        await self._session.send_client_content(turns=types.Content(role="user", parts=[types.Part(text="(call connected)")]),turn_complete=True,)
        logger.info("call %s: Gemini Live session started", self.call_id)

    async def _receive_loop(self):
        try:
            async for response in self._session.receive():
                if self._closed:
                    break

                # Spoken audio chunk from Gemini
                if getattr(response, "data", None):
                    await self.audio_out_queue.put(response.data)

                # Transcripts, when present
                server_content = getattr(response, "server_content", None)
                if server_content:
                    out_t = getattr(server_content, "output_transcription", None)
                    if out_t and out_t.text:
                        await self.on_transcript("ai", out_t.text)
                    in_t = getattr(server_content, "input_transcription", None)
                    if in_t and in_t.text:
                        await self.on_transcript("user", in_t.text)
        except Exception:
            logger.exception("call %s: Gemini receive loop crashed", self.call_id)

    async def push_user_audio(self, pcm16_16k_bytes: bytes):
        """Feed one chunk of 16kHz mono PCM16 mic audio into Gemini."""
        if self._closed or self._session is None:
            return
        await self._session.send_realtime_input(
            audio=types.Blob(mime_type=f"audio/pcm;rate={INPUT_SAMPLE_RATE}", data=pcm16_16k_bytes)
        )

    async def close(self):
        self._closed = True
        if self._recv_task:
            self._recv_task.cancel()
        if self._session_cm:
            try:
                await self._session_cm.__aexit__(None, None, None)
            except Exception:
                logger.exception("call %s: error closing Gemini session", self.call_id)
        logger.info("call %s: Gemini Live session closed", self.call_id)
