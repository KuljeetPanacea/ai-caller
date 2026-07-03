const cron = require("node-cron");
const User = require("../models/User");
const { ringUser } = require("./socketHandlers");

// Runs every minute, checks whether "now" (HH:mm, server-local) matches any
// user's scheduledCallTimes, and rings the ones who are online.
function startScheduler(io) {
  cron.schedule("* * * * *", async () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const nowStr = `${hh}:${mm}`;

    try {
      const dueUsers = await User.find({ scheduledCallTimes: nowStr, online: true });
      for (const user of dueUsers) {
        const result = await ringUser(io, user._id, { reason: "scheduled-checkin" });
        console.log(`[scheduler] ring ${user.phone} @ ${nowStr}:`, result);
      }
    } catch (err) {
      console.error("[scheduler] error:", err.message);
    }
  });

  console.log("[scheduler] started (checks every minute)");
}

module.exports = { startScheduler };
