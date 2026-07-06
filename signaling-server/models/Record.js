const mongoose = require("mongoose");

const collectionName = process.env.MONGO_COLLECTION_NAME || "records";

const RecordSchema = new mongoose.Schema(
  {
    uhid: { type: String, default: "" },
    name: { type: String, default: "" },
    phone: { type: String, required: true, index: true },
    registeredAt: { type: Date, default: null },
    sourceUrl: { type: String, default: "" },
    capturedAt: { type: Date, default: null },
    syncedAt: { type: Date, default: null },
    extensionVersion: { type: String, default: "" },
    browser: { type: String, default: "" },
  },
  {
    collection: collectionName,
    timestamps: false,
  }
);

module.exports = mongoose.model("Record", RecordSchema, collectionName);
