const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Record = require("../models/Record");

const router = express.Router();

function signToken(user) {
  return jwt.sign({ userId: user._id, phone: user.phone }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
}

// POST /auth/login { phone }
router.post("/login", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const record = await Record.findOne({ phone });
    if (!record) {
      return res.status(404).json({ error: "not_registered", message: "Phone number not registered." });
    }

    let user = await User.findOne({ phone });
    if (!user) {
      user = new User({ phone, name: record.name || "" });
    } else if (!user.name && record.name) {
      user.name = record.name;
    }
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
