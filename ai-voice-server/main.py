import asyncio
import logging
import os

from dotenv import load_dotenv

load_dotenv()

import socketio
from aiortc.sdp import candidate_from_sdp
from aiortc import RTCIceCandidate
from fastapi import FastAPI
from pydantic import BaseModel

from webrtc_session import CallSession

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("main")

SIGNALING_SERVER_URL = os.getenv("SIGNALING_SERVER_URL", "http://localhost:4000")
INTERNAL_SHARED_SECRET = os.getenv("INTERNAL_SHARED_SECRET", "")

app = FastAPI(title="AI Voice Server")
sio = socketio.AsyncClient(reconnection=True)

sessions: dict[str, CallSession] = {}


# ---------------------------------------------------------------------------
# Socket.IO client: this service is itself a "socket" on the signaling
# server, exactly like a human user's app, but it identifies with
# 'ai-register' instead of 'register' and relays WebRTC SDP/ICE for
# whichever calls it's handling.
# ---------------------------------------------------------------------------


@sio.event
async def connect():
    logger.info("connected to signaling server at %s", SIGNALING_SERVER_URL)


@sio.event
async def disconnect():
    logger.warning("disconnected from signaling server")


@sio.on("offer")
async def on_offer(data):
    call_id = data["callId"]
    session = sessions.get(call_id)
    if not session:
        logger.warning("offer for unknown call %s", call_id)
        return

    answer = await session.handle_offer(data["sdp"]["sdp"], data["sdp"]["type"])
    await sio.emit(
        "answer",
        {"callId": call_id, "sdp": {"sdp": answer.sdp, "type": answer.type}},
    )


@sio.on("ice-candidate")
async def on_ice_candidate(data):
    call_id = data["callId"]
    session = sessions.get(call_id)
    if not session or not data.get("candidate"):
        return

    c = data["candidate"]
    try:
        candidate = candidate_from_sdp(c["candidate"].split(":", 1)[1])
        candidate.sdpMid = c.get("sdpMid")
        candidate.sdpMLineIndex = c.get("sdpMLineIndex")
        await session.add_ice_candidate(candidate)
    except Exception:
        logger.exception("call %s: failed to add ICE candidate", call_id)


@sio.on("call-ended")
async def on_call_ended(data):
    await _teardown(data["callId"])


async def emit_transcript(call_id: str, role: str, text: str):
    await sio.emit("transcript-line", {"callId": call_id, "role": role, "text": text})


async def _teardown(call_id: str):
    session = sessions.pop(call_id, None)
    if session:
        await session.close()
        logger.info("call %s: session torn down", call_id)


# ---------------------------------------------------------------------------
# HTTP API — called by the Node signaling server
# ---------------------------------------------------------------------------


class StartSessionRequest(BaseModel):
    callId: str
    userId: str
    name: str = "there"
    language: str = "en"


class StopSessionRequest(BaseModel):
    callId: str
    reason: str = ""


@app.on_event("startup")
async def startup():
    asyncio.create_task(_connect_with_retry())


async def _connect_with_retry():
    while True:
        try:
            await sio.connect(SIGNALING_SERVER_URL, transports=["websocket"])
            return
        except Exception:
            logger.warning("could not reach signaling server, retrying in 3s")
            await asyncio.sleep(3)


@app.post("/session/start")
async def start_session(req: StartSessionRequest):
    if req.callId in sessions:
        return {"ok": True, "already": True}

    session = CallSession(
        call_id=req.callId,
        user_id=req.userId,
        name=req.name,
        language=req.language,
        emit_transcript=emit_transcript,
    )
    sessions[req.callId] = session

    await sio.emit(
        "ai-register", {"callId": req.callId, "internalSecret": INTERNAL_SHARED_SECRET}
    )
    await session.start()

    logger.info("call %s: session started for user %s", req.callId, req.userId)
    return {"ok": True}


@app.post("/session/stop")
async def stop_session(req: StopSessionRequest):
    await _teardown(req.callId)
    return {"ok": True}


@app.get("/health")
async def health():
    return {"ok": True, "activeSessions": list(sessions.keys())}