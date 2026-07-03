const AI_VOICE_SERVER_URL = process.env.AI_VOICE_SERVER_URL || "http://localhost:8098";

async function startAiSession({ callId, userId, name, language }) {
  const res = await fetch(`${AI_VOICE_SERVER_URL}/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId, userId, name, language }),
  });
  if (!res.ok) throw new Error(`AI server start failed: ${res.status}`);
  return res.json();
}

async function stopAiSession({ callId, reason }) {
  const res = await fetch(`${AI_VOICE_SERVER_URL}/session/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId, reason }),
  });
  if (!res.ok) throw new Error(`AI server stop failed: ${res.status}`);
  return res.json();
}

module.exports = { startAiSession, stopAiSession };
