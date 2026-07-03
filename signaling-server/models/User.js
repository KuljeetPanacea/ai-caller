const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: "" },
    language: { type: String, default: "en" },

    // presence
    socketId: { type: String, default: null },
    online: { type: Boolean, default: false },
    lastSeen: { type: Date, default: null },

    // OTP (dev-only; swap for a real provider + hashed codes in production)
    otpCode: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },

    // scheduling preferences
    scheduledCallTimes: [{ type: String }], // e.g. ["09:00", "20:30"] in 24h "HH:mm", server timezone
    timezone: { type: String, default: "Asia/Kolkata" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", UserSchema);
