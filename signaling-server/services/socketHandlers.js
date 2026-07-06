const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
const User = require("../models/User");
const Call = require("../models/Call");
const { startAiSession, stopAiSession } = require("./aiServerClient");

function callRoom(callId) {
  return `call:${callId}`;
}
function userRoom(userId) {
  return `user:${userId}`;
}

function registerSocketHandlers(io) {
  io.on("connection", (socket) => {
    console.log(`[socket] connected ${socket.id}`);

    // ---- Presence ----
    // A human user's app calls this right after connecting.
    socket.on("register", async ({ userId, token }, ack) => {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        if (String(payload.userId) !== String(userId)) throw new Error("token/user mismatch");

        const user = await User.findByIdAndUpdate(
          userId,
          { socketId: socket.id, online: true, lastSeen: new Date() },
          { new: true }
        );
        if (!user) throw new Error("user not found");

        socket.data.userId = userId;
        socket.data.role = "human";
        socket.join(userRoom(userId));

        console.log(`[presence] user ${userId} online (${socket.id})`);
        ack?.({ ok: true });
      } catch (err) {
        console.error("[register] failed:", err.message);
        ack?.({ ok: false, error: err.message });
      }
    });

    // The Python AI voice server connects as a socket client too, and
    // announces which callId it is handling so we can relay SDP/ICE to it.
    socket.on("ai-register", ({ callId, internalSecret }, ack) => {
      if (internalSecret !== process.env.JWT_SECRET) {
        return ack?.({ ok: false, error: "unauthorized" });
      }
      socket.data.role = "ai";
      socket.data.callId = callId;
      socket.join(callRoom(callId));
      console.log(`[ai] joined room for call ${callId}`);
      ack?.({ ok: true });
    });

    // ---- Call lifecycle ----

    // Called by the scheduler (see scheduler.js) or an admin/test route,
    // not directly by a client socket. Exposed here for reuse.
    socket.on("__internal_not_used", () => {});

    socket.on("accept-call", async ({ callId }, ack) => {
      try {
        const call = await Call.findOneAndUpdate(
          { callId },
          { status: "accepted", startedAt: new Date() },
          { new: true }
        );
        if (!call) return ack?.({ ok: false, error: "call_not_found" });

        socket.join(callRoom(callId));

        // Tell the Python backend server to spin up a WebRTC peer for this call.
        const user = await User.findById(call.userId);
        await startAiSession({
          callId,
          userId: String(call.userId),
          name: user?.name || "there",
          language: user?.language || "en",
        });

        // Both sides now know they should start WebRTC negotiation.
        io.to(callRoom(callId)).emit("call-ready", { callId });
        ack?.({ ok: true });
      } catch (err) {
        console.error("[accept-call] error:", err.message);
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on("reject-call", async ({ callId }) => {
      await Call.findOneAndUpdate({ callId }, { status: "rejected", endedAt: new Date() });
      await stopAiSession({ callId, reason: "rejected" }).catch(() => {});
      io.to(callRoom(callId)).emit("call-ended", { callId, reason: "rejected" });
    });

    socket.on("end-call", async ({ callId }) => {
      const call = await Call.findOne({ callId });
      if (call) {
        const endedAt = new Date();
        const durationSeconds = call.startedAt
          ? Math.round((endedAt - call.startedAt) / 1000)
          : 0;
        call.status = "completed";
        call.endedAt = endedAt;
        call.durationSeconds = durationSeconds;
        await call.save();
      }
      await stopAiSession({ callId, reason: "ended" }).catch(() => {});
      io.to(callRoom(callId)).emit("call-ended", { callId, reason: "ended" });
    });

    socket.on("ai-call-ended", async ({ callId, reason }) => {
      const call = await Call.findOne({ callId });
      if (call) {
        const endedAt = new Date();
        const durationSeconds = call.startedAt
          ? Math.round((endedAt - call.startedAt) / 1000)
          : 0;
        call.status = "completed";
        call.endedAt = endedAt;
        call.durationSeconds = durationSeconds;
        await call.save();
      }
      io.to(callRoom(callId)).emit("call-ended", { callId, reason: reason || "completed" });
    });

    // ---- WebRTC signaling relay (pure pass-through) ----
    socket.on("offer", ({ callId, sdp }) => {
      socket.to(callRoom(callId)).emit("offer", { callId, sdp });
    });
    socket.on("answer", ({ callId, sdp }) => {
      socket.to(callRoom(callId)).emit("answer", { callId, sdp });
    });
    socket.on("ice-candidate", ({ callId, candidate }) => {
      socket.to(callRoom(callId)).emit("ice-candidate", { callId, candidate });
    });

    // ---- Misc in-call controls ----
    socket.on("mute", ({ callId }) => socket.to(callRoom(callId)).emit("peer-muted", { callId }));
    socket.on("unmute", ({ callId }) =>
      socket.to(callRoom(callId)).emit("peer-unmuted", { callId })
    );

    // ---- Transcript relay (AI server pushes partial/final transcript lines) ----
    socket.on("transcript-line", async ({ callId, role, text }) => {
      await Call.findOneAndUpdate(
        { callId },
        { $push: { transcript: { role, text, at: new Date() } } }
      );
      socket.to(callRoom(callId)).emit("transcript-line", { callId, role, text });
    });

    socket.on("disconnect", async () => {
      if (socket.data.role === "human" && socket.data.userId) {
        await User.findByIdAndUpdate(socket.data.userId, {
          online: false,
          socketId: null,
          lastSeen: new Date(),
        });
        console.log(`[presence] user ${socket.data.userId} offline`);

        // If the user refreshes during an active call, stop the AI session.
        const activeCall = await Call.findOne({ userId: socket.data.userId, status: "accepted" }).sort({ startedAt: -1 });
        if (activeCall) {
          const endedAt = new Date();
          const durationSeconds = activeCall.startedAt
            ? Math.round((endedAt - activeCall.startedAt) / 1000)
            : 0;
          activeCall.status = "completed";
          activeCall.endedAt = endedAt;
          activeCall.durationSeconds = durationSeconds;
          await activeCall.save();
          await stopAiSession({ callId: activeCall.callId, reason: "disconnect" }).catch(() => {});
          io.to(callRoom(activeCall.callId)).emit("call-ended", { callId: activeCall.callId, reason: "disconnect" });
        }
      }
      if (socket.data.role === "ai" && socket.data.callId) {
        console.log(`[ai] left room for call ${socket.data.callId}`);
      }
    });
  });
}

// Used by the scheduler to push a fresh incoming-call ring to a specific user.
async function ringUser(io, userId, { reason } = {}) {
  const user = await User.findById(userId);
  if (!user || !user.online) return { ok: false, reason: "user_offline" };

  const callId = randomUUID();
  await Call.create({ callId, userId, phone: user.phone, direction: "ai-initiated", status: "ringing" });

  io.to(userRoom(userId)).emit("incoming-call", {
    callId,
    caller: "AI Assistant",
    reason: reason || "scheduled-checkin",
  });

  return { ok: true, callId };
}

module.exports = { registerSocketHandlers, ringUser };
