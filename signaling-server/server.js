require("dotenv").config();
const dns = require("dns");
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

// Create a router for all /ai-caller routes
const apiRouter = express.Router();

apiRouter.use("/auth", authRoutes);
apiRouter.use("/users", usersRoutes);

apiRouter.get("/health", (req, res) => res.json({ ok: true }));

// Manual test trigger: POST /calls/trigger { userId }
// Lets you fire an AI-initiated call on demand instead of waiting for the cron scheduler.
apiRouter.post("/calls/trigger", async (req, res) => {
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
apiRouter.get("/calls/:userId", async (req, res) => {
  const calls = await Call.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(50);
  res.json({ calls });
});

// Mount all routes under /ai-caller prefix
app.use("/ai-caller", express.static("../pwa-client"));
app.use("/ai-caller", apiRouter);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_ORIGIN || "*" },
});

registerSocketHandlers(io);

const PORT = process.env.PORT || 4000;

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is required in environment");
  }

  if (mongoUri.startsWith("mongodb+srv://")) {
    dns.setServers(["8.8.8.8", "8.8.4.4"]);
    console.log("[dns] using Google DNS for SRV resolution");
  }

  await mongoose.connect(mongoUri, { dbName: process.env.MONGO_DB_NAME });
  console.log("[mongo] connected", { uri: mongoUri, db: process.env.MONGO_DB_NAME });

  startScheduler(io);

  server.listen(PORT, () => {
    console.log(`[server] signaling server listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
