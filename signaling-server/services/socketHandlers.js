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
        console.log("[call] accept-call event received", { callId, socketRole: socket.data.role });
        const call = await Call.findOneAndUpdate(
          { callId },
          { status: "accepted", startedAt: new Date() },
          { new: true }
        );
        if (!call) {
          console.warn("[call] accept-call call_not_found", { callId });
          return ack?.({ ok: false, error: "call_not_found" });
        }
        console.log("[call] accept-call DB updated to accepted", { callId });

        socket.join(callRoom(callId));

        // Tell the Python backend server to spin up a WebRTC peer for this call.
        const user = await User.findById(call.userId);
        console.log("[call] accept-call calling startAiSession", { callId, userId: String(call.userId) });
        await startAiSession({
          callId,
          userId: String(call.userId),
          name: user?.name || "there",
          language: user?.language || "en",
        });
        console.log("[call] accept-call startAiSession done", { callId });

        // Both sides now know they should start WebRTC negotiation.
        io.to(callRoom(callId)).emit("call-ready", { callId });
        console.log("[call] accept-call emitted call-ready", { callId, room: callRoom(callId) });
        ack?.({ ok: true });
      } catch (err) {
        console.error("[accept-call] error:", err);
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on("reject-call", async ({ callId }) => {
      const result = await Call.findOneAndUpdate({ callId }, { status: "rejected", endedAt: new Date() });
      console.log("[call] reject-call DB updated", { callId, found: !!result });
      await stopAiSession({ callId, reason: "rejected" }).catch((err) => console.error("[call] reject-call stopAiSession error", err));
      io.to(callRoom(callId)).emit("call-ended", { callId, reason: "rejected" });
      console.log("[call] reject-call emitted call-ended", { callId });
    });

    socket.on("end-call", async ({ callId }) => {
      console.log("[call] end-call request", { callId });
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
        console.log("[call] end-call DB updated", { callId, durationSeconds });
      }
      await stopAiSession({ callId, reason: "ended" }).catch((err) => console.error("[call] end-call stopAiSession error", err));
      io.to(callRoom(callId)).emit("call-ended", { callId, reason: "ended" });
      console.log("[call] end-call emitted call-ended", { callId });
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
      console.log("[socket] disconnect event", { role: socket.data.role, userId: socket.data.userId, callId: socket.data.callId });
      if (socket.data.role === "human" && socket.data.userId) {
        await User.findByIdAndUpdate(socket.data.userId, {
          online: false,
          socketId: null,
          lastSeen: new Date(),
        });
        console.log("[presence] user disconnected", { userId: socket.data.userId });

        const activeCall = await Call.findOne({ userId: socket.data.userId, status: "accepted" }).sort({ startedAt: -1 });
        if (activeCall) {
          console.log("[call] disconnect teardown active call", { callId: activeCall.callId, userId: socket.data.userId });
          const endedAt = new Date();
          const durationSeconds = activeCall.startedAt
            ? Math.round((endedAt - activeCall.startedAt) / 1000)
            : 0;
          activeCall.status = "completed";
          activeCall.endedAt = endedAt;
          activeCall.durationSeconds = durationSeconds;
          await activeCall.save();
          await stopAiSession({ callId: activeCall.callId, reason: "disconnect" }).catch((err) => console.error("[call] disconnect stopAiSession error", err));
          io.to(callRoom(activeCall.callId)).emit("call-ended", { callId: activeCall.callId, reason: "disconnect" });
          console.log("[call] disconnect emitted call-ended", { callId: activeCall.callId, reason: "disconnect" });
        }
      }
      if (socket.data.role === "ai" && socket.data.callId) {
        console.log(`[ai] socket disconnected for call ${socket.data.callId}`);
      }
    });
  });
}

// Used by the scheduler to push a fresh incoming-call ring to a specific user.
async function ringUser(io, userId, { reason } = {}) {
  const user = await User.findById(userId);
  console.log("[call] ringUser input", { userId, online: user?.online, reason });
  if (!user) {
    return { ok: false, reason: "user_not_found" };
  }

  const callId = randomUUID();
  const call = await Call.create({ callId, userId, phone: user.phone, direction: "ai-initiated", status: "ringing" });
  console.log("[call] ringUser created call DB record", { callId, userId, direction: call.direction });

  io.to(userRoom(userId)).emit("incoming-call", {
    callId,
    caller: "AI Assistant",
    reason: reason || "scheduled-checkin",
  });
  console.log("[call] ringUser emitted incoming-call", { callId, userId, room: userRoom(userId) });

  return { ok: true, callId };
}

module.exports = { registerSocketHandlers, ringUser };
