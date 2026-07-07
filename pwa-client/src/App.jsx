import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from './hooks/useAuth'
import { useCallHistory } from './hooks/useCallHistory'
import { useCallTimer } from './hooks/useCallTimer'
import { useWaitingCountdown } from './hooks/useWaitingCountdown'
import { usePWAInstall } from './hooks/usePWAInstall'
import { useSocket } from './hooks/useSocket'
import AuthScreen from './components/AuthScreen'
import WaitingScreen from './components/WaitingScreen'
import HomeScreen from './components/HomeScreen'
import IncomingCallScreen from './components/IncomingCallScreen'
import ActiveCallScreen from './components/ActiveCallScreen'
import ThankYouScreen from './components/ThankYouScreen'
import Toast from './components/Toast'

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]

export default function App() {
  // 1. Custom hooks first (no callbacks depend on these yet)
  const { token, userId, userName, error, login } = useAuth()
  
  const { elapsed, start: startTimer, stop: stopTimer } = useCallTimer()
  
  const { secondsRemaining, start: startCountdown, stop: stopWaitingCountdown } = useWaitingCountdown(10)
  
  const { canInstall, install } = usePWAInstall()
  useCallHistory(userId)
  const { socket, emit, isConnected: socketConnected } = useSocket(userId, token)

  // 2. State
  const [screen, setScreen] = useState('auth')
  const [hasCompletedCall, setHasCompletedCall] = useState(() => localStorage.getItem('hasCompletedCall') === 'true')
  const [callerName, setCallerName] = useState('')
  const [currentCallId, setCurrentCallId] = useState(null)
  const [statusText, setStatusText] = useState('Connecting…')
  const [isMuted, setIsMuted] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [toastMsg, setToastMsg] = useState('')

  // 3. Refs
  const pcRef = useRef(null)
  const localStreamRef = useRef(null)
  const remoteAudioRef = useRef(null)
  const ringRef = useRef(null)
  const incomingCallIdRef = useRef(null)
  const startCountdownRef = useRef(null)
  const stopTimerRef = useRef(null)
  const socketRef = useRef(socket)
  
  useEffect(() => {
    socketRef.current = socket
  }, [socket])

  // 4. Stable callbacks (no TDZ risk)
  const showToast = useCallback((msg) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(''), 2600)
  }, [])

  const triggerAutoCall = useCallback(async () => {
    if (hasCompletedCall) return
    try {
      const res = await fetch(`${import.meta.env.VITE_SIGNALING_SERVER_URL}/calls/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      })
      const data = await res.json()
      if (!data.ok) showToast('Could not initiate call: ' + (data.reason || data.error || ''))
    } catch {
      showToast('Could not reach the server.')
    }
  }, [userId, hasCompletedCall, showToast])

  const endCallLocally = useCallback(() => {
    if (stopTimerRef.current) stopTimerRef.current()
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop())
      localStreamRef.current = null
    }
    setCurrentCallId(null)
    setScreen('thank-you')
    setHasCompletedCall(true)
    localStorage.setItem('hasCompletedCall', 'true')
    setIsMuted(false)
    setStatusText('Connecting…')
    setTimeout(() => setScreen('home'), 5000)
  }, [])

  const enterApp = useCallback(() => {
    if (hasCompletedCall) {
      setScreen('home')
    } else {
      setScreen('waiting')
      setTimeout(() => {
        if (startCountdownRef.current) startCountdownRef.current()
      }, 100)
    }
  }, [hasCompletedCall])

  useEffect(() => {
    if (token && userId) {
      enterApp()
    }
  }, [token, userId, enterApp])

  // 5. Socket event handlers — depend on latest state via refs/useCallback
  const handleIncomingCall = useCallback((data) => {
    setCallerName(data.caller || 'AI Assistant')
    setCurrentCallId(data.callId)
    setScreen('incoming')
    if (ringRef.current) {
      ringRef.current.play().catch(() => {})
    }
  }, [])

  const handleCallReady = useCallback(async (data) => {
    const callId = data.callId
    setStatusText('Connecting…')
    setScreen('active')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      localStreamRef.current = stream
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      pcRef.current = pc

      stream.getTracks().forEach(track => pc.addTrack(track, stream))
      
      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          remoteAudioRef.current = event.streams[0]
        }
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          emit('ice-candidate', { callId, candidate: event.candidate })
        }
      }

      pc.onconnectionstatechange = () => {
        console.log('[webrtc] connection state changed', { state: pc.connectionState, callId })
        if (pc.connectionState === 'connected') {
          setStatusText('In progress')
          startTimer()
        }
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          setStatusText('Call ended')
        }
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      emit('offer', { callId, sdp: offer })
    } catch (err) {
      showToast('Microphone permission is required to talk.')
      console.error('[call] getUserMedia error', err)
    }
  }, [emit, showToast, startTimer])

  const handleAnswer = useCallback(async (data) => {
    if (!pcRef.current) return
    try {
      await pcRef.current.setRemoteDescription(data.sdp)
    } catch (err) {
      console.error('[call] setRemoteDescription error', err)
    }
  }, [])

  const handleIceCandidate = useCallback(async (data) => {
    if (!pcRef.current || !data.candidate) return
    try {
      await pcRef.current.addIceCandidate(data.candidate)
    } catch (err) {
      console.warn('addIceCandidate failed', err)
    }
  }, [])

  const handleCallEnded = useCallback(() => {
    endCallLocally()
    showToast('Call ended')
    if (ringRef.current) {
      try { ringRef.current.pause(); ringRef.current.currentTime = 0 } catch (e) {}
    }
  }, [endCallLocally, showToast])

  const handleDisconnect = useCallback(() => {
    setIsConnected(false)
  }, [])

  // 6. Register socket events when socket is ready
  useEffect(() => {
    if (!socket) return

    socket.on('incoming-call', handleIncomingCall)
    socket.on('call-ready', handleCallReady)
    socket.on('answer', handleAnswer)
    socket.on('ice-candidate', handleIceCandidate)
    socket.on('call-ended', handleCallEnded)

    return () => {
      socket.off('incoming-call', handleIncomingCall)
      socket.off('call-ready', handleCallReady)
      socket.off('answer', handleAnswer)
      socket.off('ice-candidate', handleIceCandidate)
      socket.off('call-ended', handleCallEnded)
    }
  }, [socket, handleIncomingCall, handleCallReady, handleAnswer, handleIceCandidate, handleCallEnded])

  // 7. Call buttons — reference socket events via emit
  const handleAccept = useCallback(() => {
    if (!currentCallId) return
    emit('accept-call', { callId: currentCallId }, (ack) => {
      if (!ack?.ok) {
        showToast('Could not accept call: ' + (ack?.error || ''))
        return
      }
      setScreen('active')
      setStatusText('Connecting…')
      if (ringRef.current) {
        try { ringRef.current.pause(); ringRef.current.currentTime = 0 } catch (e) {}
      }
      if (stopWaitingCountdown) stopWaitingCountdown()
    })
  }, [currentCallId, emit, showToast, stopWaitingCountdown])

  const handleDecline = useCallback(() => {
    if (!currentCallId) return
    emit('reject-call', { callId: currentCallId })
    setScreen('home')
    setCurrentCallId(null)
    incomingCallIdRef.current = null
    if (ringRef.current) {
      try { ringRef.current.pause(); ringRef.current.currentTime = 0 } catch (e) {}
    }
  }, [currentCallId, emit])

  const handleEndCall = useCallback(() => {
    if (!currentCallId) return
    emit('end-call', { callId: currentCallId })
    endCallLocally()
  }, [currentCallId, emit, endCallLocally])

  const handleMute = useCallback(() => {
    if (!localStreamRef.current) return
    const next = !isMuted
    localStreamRef.current.getAudioTracks().forEach(t => (t.enabled = !next))
    setIsMuted(next)
    if (currentCallId) {
      emit(next ? 'mute' : 'unmute', { callId: currentCallId })
    }
  }, [isMuted, emit, currentCallId])

  // 8. PWA install effect
  useEffect(() => {
    if (canInstall) {
      const btn = document.getElementById('btn-install')
      if (btn) {
        btn.style.display = 'block'
        const handler = async () => {
          await install()
          btn.style.display = 'none'
        }
        btn.addEventListener('click', handler)
        return () => btn.removeEventListener('click', handler)
      }
    }
  }, [canInstall, install])

  // 9. Render
  if (!token || !userId) {
    return (
      <div className="app-frame">
        <AuthScreen login={login} error={error} />
        <Toast message={toastMsg} />
      </div>
    )
  }

  return (
    <div className="app-frame">
      {screen === 'waiting' && (
        <WaitingScreen
          userName={userName}
          onAutoCallTriggered={triggerAutoCall}
        />
      )}
      {screen === 'home' && (
        <HomeScreen
          userName={userName}
          isConnected={isConnected}
          userId={userId}
        />
      )}
      {screen === 'incoming' && (
        <IncomingCallScreen
          callerName={callerName}
          onAccept={handleAccept}
          onDecline={handleDecline}
        />
      )}
      {screen === 'active' && (
        <ActiveCallScreen
          statusText={statusText}
          callTimer={elapsed}
          isMuted={isMuted}
          onMute={handleMute}
          onEnd={handleEndCall}
        />
      )}
      {screen === 'thank-you' && (
        <ThankYouScreen onGoHome={() => setScreen('home')} />
      )}
      <audio ref={ringRef} id="ring-audio" src="/ring.mp3" loop />
      <audio id="remote-audio" autoPlay playsInline style={{ display: 'none' }} />
      <button id="btn-install" style={{ display: 'none', position: 'fixed', top: '12px', right: '12px', zIndex: 1000, padding: '8px 16px', background: 'var(--surface-raised)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 'var(--radius-md)', fontSize: '13px', cursor: 'pointer' }}>Install</button>
      <Toast message={toastMsg} />
    </div>
  )
}
