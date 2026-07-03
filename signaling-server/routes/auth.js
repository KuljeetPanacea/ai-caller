const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const router = express.Router();
const DEV_OTP_MODE = process.env.DEV_OTP_MODE === "true";

function signToken(user) {
  return jwt.sign({ userId: user._id, phone: user.phone }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
}

// POST /auth/request-otp { phone }
router.post("/request-otp", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "phone is required" });

    let user = await User.findOne({ phone });
    if (!user) user = new User({ phone });

    if (DEV_OTP_MODE) {
      user.otpCode = "123456";
    } else {
      user.otpCode = String(Math.floor(100000 + Math.random() * 900000));
      // TODO: send via SMS provider (Twilio Verify, MSG91, etc.)
    }
    user.otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await user.save();

    console.log(`[OTP] ${phone} -> ${user.otpCode}`);
    res.json({ ok: true, devOtp: DEV_OTP_MODE ? user.otpCode : undefined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /auth/verify-otp { phone, code, name? }
router.post("/verify-otp", async (req, res) => {
  try {
    const { phone, code, name } = req.body;
    if (!phone || !code) return res.status(400).json({ error: "phone and code are required" });

    const user = await User.findOne({ phone });
    if (!user || !user.otpCode) return res.status(400).json({ error: "no_otp_requested" });
    if (user.otpExpiresAt < new Date()) return res.status(400).json({ error: "otp_expired" });
    if (user.otpCode !== code) return res.status(400).json({ error: "invalid_otp" });

    user.otpCode = null;
    user.otpExpiresAt = null;
    if (name) user.name = name;
    await user.save();

    const token = signToken(user);
    res.json({
      token,
      user: { id: user._id, phone: user.phone, name: user.name, language: user.language },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /auth/me  (Authorization: Bearer <token>)
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing_token" });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.userId);
    if (!user) return res.status(404).json({ error: "user_not_found" });

    res.json({ user: { id: user._id, phone: user.phone, name: user.name, language: user.language } });
  } catch (err) {
    res.status(401).json({ error: "invalid_token" });
  }
});

module.exports = router;
