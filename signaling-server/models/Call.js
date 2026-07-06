const mongoose = require("mongoose");

const CallSchema = new mongoose.Schema(
  {
    callId: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    phone: { type: String, default: "" },

    direction: { type: String, enum: ["ai-initiated", "user-initiated"], default: "ai-initiated" },
    status: {
      type: String,
      enum: ["ringing", "accepted", "rejected", "missed", "in-progress", "completed", "failed"],
      default: "ringing",
    },

    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    durationSeconds: { type: Number, default: 0 },

    transcript: [
      {
        role: { type: String, enum: ["ai", "user"] },
        text: String,
        at: { type: Date, default: Date.now },
      },
    ],
    summary: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Call", CallSchema);
