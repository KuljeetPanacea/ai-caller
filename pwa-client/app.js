// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SIGNALING_SERVER_URL = window.SIGNALING_SERVER_URL || "http://localhost:4000";
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  // Free public TURN (openrelay.metered.ca) — swap for your own TURN
  // server before real production use, but this is fine to unblock testing.
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  token: localStorage.getItem("signal_token") || null,
  userId: localStorage.getItem("signal_userId") || null,
  userName: localStorage.getItem("signal_userName") || "",
  socket: null,
  pc: null,
  localStream: null,
  currentCallId: null,
  muted: false,
  callTimerHandle: null,
  callStartedAt: null,
  waitingTimerHandle: null,
  thankYouTimerHandle: null,
  hasCompletedCall: false,
};

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  $(id).classList.add("active");
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(() => {
    console.log('Service worker registered');
  }).catch((err) => {
    console.warn('Service worker registration failed', err);
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
$("btn-request-otp").addEventListener("click", async () => {
  const phone = $("phone-input").value.trim();
  $("phone-error").textContent = "";
  if (!phone) return ($("phone-error").textContent = "Enter a phone number.");

  try {
    const res = await fetch(`${SIGNALING_SERVER_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || "Phone number not registered.");

    state.token = data.token;
    state.userId = data.user.id;
    state.userName = data.user.name || "";
    localStorage.setItem("signal_token", state.token);
    localStorage.setItem("signal_userId", state.userId);
    localStorage.setItem("signal_userName", state.userName);

    enterApp();
  } catch (err) {
    $("phone-error").textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// App entry (after auth) — connect socket, load home screen data
// ---------------------------------------------------------------------------
async function enterApp() {
  $("home-greeting").textContent = state.userName ? `Hi ${state.userName}` : "Hi there";
  $("waiting-greeting").textContent = state.userName ? `Hi ${state.userName}` : "Hi there";
  showScreen("screen-waiting");
  connectSocket();
  
  // Start 60-second countdown before auto-calling
  startWaitingCountdown();
}

function startWaitingCountdown() {
  let secondsRemaining = 60;
  const countdownDisplay = $("countdown-display");
  
  countdownDisplay.textContent = secondsRemaining;
  
  state.waitingTimerHandle = setInterval(() => {
    secondsRemaining--;
    countdownDisplay.textContent = secondsRemaining;
    
    if (secondsRemaining <= 0) {
      clearInterval(state.waitingTimerHandle);
      // Trigger auto-call after countdown finishes
      triggerAutoCall();
    }
  }, 1000);
}

async function triggerAutoCall() {
  if (state.hasCompletedCall) return;
  try {
    const res = await fetch(`${SIGNALING_SERVER_URL}/calls/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: state.userId }),
    });
    const data = await res.json();
    if (!data.ok) toast("Could not initiate call: " + (data.reason || data.error || ""));
  } catch {
    toast("Could not reach the server.");
  }
}

function connectSocket() {
  state.socket = io(SIGNALING_SERVER_URL, { transports: ["websocket"] ,path: "/ai-caller-backend/socket.io" } );

  state.socket.on("connect", () => {
    state.socket.emit("register", { userId: state.userId, token: state.token }, (ack) => {
      if (ack?.ok) {
        setPresence(true);
      } else {
        toast("Could not register presence: " + (ack?.error || "unknown error"));
      }
    });
  });

  state.socket.on("disconnect", () => setPresence(false));

  state.socket.on("incoming-call", ({ callId, caller }) => {
    state.currentCallId = callId;
    $("incoming-caller-name").textContent = caller || "AI Assistant";
    showScreen("screen-incoming");
    // play ringtone (will try local ring.mp3 first)
    const ring = $("ring-audio");
    if (ring) {
      ring.play().catch(() => {
        // autoplay might be blocked; ignore
      });
    }
  });

  state.socket.on("call-ready", async ({ callId }) => {
    if (callId !== state.currentCallId) return;
    await startWebRtc(callId);
  });

  state.socket.on("answer", async ({ callId, sdp }) => {
    if (callId !== state.currentCallId || !state.pc) return;
    await state.pc.setRemoteDescription(sdp);
  });

  state.socket.on("ice-candidate", async ({ callId, candidate }) => {
    if (callId !== state.currentCallId || !state.pc || !candidate) return;
    try {
      await state.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn("addIceCandidate failed", err);
    }
  });

  // transcript-line events are ignored (transcript UI removed)

  state.socket.on("call-ended", ({ callId }) => {
    if (callId !== state.currentCallId) return;
    endCallLocally();
    toast("Call ended");
    // stop ringtone on call end
    const ring = $("ring-audio");
    if (ring) try { ring.pause(); ring.currentTime = 0; } catch (e) {}
  });
}

window.addEventListener("beforeunload", () => {
  if (!state.currentCallId) return;
  try {
    state.socket.emit("end-call", { callId: state.currentCallId });
  } catch (err) {
    // best-effort cleanup on refresh
  }
});

function setPresence(online) {
  const pill = $("presence-pill");
  pill.classList.toggle("online", online);
  $("presence-text").textContent = online ? "Online" : "Connecting";
}

// ---------------------------------------------------------------------------
// Call handling
// ---------------------------------------------------------------------------
  $("btn-accept").addEventListener("click", () => {
    state.socket.emit("accept-call", { callId: state.currentCallId }, (ack) => {
      if (!ack?.ok) return toast("Could not accept call: " + (ack?.error || ""));
      showScreen("screen-active");
      $("active-status-text").textContent = "Connecting…";
      // stop ringtone when call accepted
      const ring = $("ring-audio");
      if (ring) try { ring.pause(); ring.currentTime = 0; } catch (e) {}
    });
});

$("btn-decline").addEventListener("click", () => {
  state.socket.emit("reject-call", { callId: state.currentCallId });
  showScreen("screen-home");
  state.currentCallId = null;
  // stop ringtone on decline
  const ring = $("ring-audio");
  if (ring) try { ring.pause(); ring.currentTime = 0; } catch (e) {}
});

$("btn-end").addEventListener("click", () => {
  state.socket.emit("end-call", { callId: state.currentCallId });
  endCallLocally();
});

$("btn-mute").addEventListener("click", () => {
  if (!state.localStream) return;
  state.muted = !state.muted;
  state.localStream.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
  $("btn-mute").classList.toggle("active", state.muted);
  state.socket.emit(state.muted ? "mute" : "unmute", { callId: state.currentCallId });
});

async function startWebRtc(callId) {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    toast("Microphone permission is required to talk.");
    return;
  }

  state.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.localStream.getTracks().forEach((track) => state.pc.addTrack(track, state.localStream));

  state.pc.ontrack = (event) => {
    $("remote-audio").srcObject = event.streams[0];
  };

  state.pc.onicecandidate = (event) => {
    if (event.candidate) {
      state.socket.emit("ice-candidate", { callId, candidate: event.candidate });
    }
  };

  state.pc.onconnectionstatechange = () => {
    if (state.pc.connectionState === "connected") {
      $("active-status-text").textContent = "In progress";
      startTimer();
    }
    if (["failed", "disconnected", "closed"].includes(state.pc.connectionState)) {
      $("active-status-text").textContent = "Call ended";
    }
  };

  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);
  state.socket.emit("offer", { callId, sdp: offer });
}

// transcript UI removed — appendTranscript intentionally omitted

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function startTimer() {
  state.callStartedAt = Date.now();
  clearInterval(state.callTimerHandle);
  state.callTimerHandle = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.callStartedAt) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    $("call-timer").textContent = `${mm}:${ss}`;
  }, 1000);
}

function endCallLocally() {
  clearInterval(state.callTimerHandle);
  clearInterval(state.waitingTimerHandle);
  $("call-timer").textContent = "00:00";
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  state.currentCallId = null;
  state.muted = false;
  state.hasCompletedCall = true;
  $("btn-mute").classList.remove("active");
  showScreen("screen-thank-you");
  loadHistory();
  clearTimeout(state.thankYouTimerHandle);
  state.thankYouTimerHandle = setTimeout(goHome, 5000);
}

function goHome() {
  clearTimeout(state.thankYouTimerHandle);
  showScreen("screen-home");
}

$("screen-thank-you").addEventListener("click", goHome);

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
async function loadHistory() {
  try {
    const res = await fetch(`${SIGNALING_SERVER_URL}/calls/${state.userId}`);
    const data = await res.json();
    renderHistory(data.calls || []);
  } catch {
    // silent — history is a nice-to-have on the home screen
  }
}

function renderHistory(calls) {
  const list = $("history-list");
  list.innerHTML = "";
  if (calls.length === 0) {
    list.innerHTML = '<p class="hint" style="margin:4px 0 0;">No calls yet.</p>';
    return;
  }
  calls.slice(0, 6).forEach((call) => {
    const row = document.createElement("div");
    row.className = "history-item";
    const when = new Date(call.createdAt).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const duration = call.durationSeconds
      ? `${Math.floor(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s`
      : "";
    row.innerHTML = `
      <div>
        <div>AI Assistant</div>
        <div class="meta">${when}${duration ? " · " + duration : ""}</div>
      </div>
      <span class="status-tag ${call.status}">${call.status}</span>
    `;
    list.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(function boot() {
  if (state.token && state.userId) {
    enterApp();
  } else {
    showScreen("screen-auth");
  }
})();

// PWA install prompt handling
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = $('btn-install');
  if (btn) {
    btn.style.display = 'block';
    btn.addEventListener('click', async () => {
      btn.style.display = 'none';
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
    });
  }
});