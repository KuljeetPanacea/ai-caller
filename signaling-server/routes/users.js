const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const router = express.Router();

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_token" });
  try {
    req.auth = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

// PATCH /users/:id/schedule { times: ["09:00", "20:30"] }
router.patch("/:id/schedule", authMiddleware, async (req, res) => {
  if (String(req.auth.userId) !== String(req.params.id)) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { times } = req.body;
  if (!Array.isArray(times)) return res.status(400).json({ error: "times must be an array" });

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { scheduledCallTimes: times },
    { new: true }
  );
  if (!user) return res.status(404).json({ error: "user_not_found" });
  res.json({ scheduledCallTimes: user.scheduledCallTimes });
});

module.exports = router;
