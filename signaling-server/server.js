require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");

const authRoutes = require("./routes/auth");
const usersRoutes = require("./routes/users");
const { registerSocketHandlers, ringUser } = require("./services/socketHandlers");
const { startScheduler } = require("./services/scheduler");
const Call = require("./models/Call");

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/users", usersRoutes);

app.get("/health", (req, res) => res.json({ ok: true }));

// Manual test trigger: POST /calls/trigger { userId }
// Lets you fire an AI-initiated call on demand instead of waiting for the cron scheduler.
app.post("/calls/trigger", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });
    const result = await ringUser(io, userId, { reason: "manual-trigger" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simple call history lookup for a user
app.get("/calls/:userId", async (req, res) => {
  const calls = await Call.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(50);
  res.json({ calls });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_ORIGIN || "*" },
});

registerSocketHandlers(io);

const PORT = process.env.PORT || 4000;

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[mongo] connected");

  startScheduler(io);

  server.listen(PORT, () => {
    console.log(`[server] signaling server listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
