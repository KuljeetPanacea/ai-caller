import { useEffect, useRef } from 'react'

export default function WaitingScreen({ userName, onAutoCallTriggered }) {
  const secondsRemainingRef = useRef(10)
  const countdownDisplay = useRef(null)

  useEffect(() => {
    secondsRemainingRef.current = 10
    const id = setInterval(() => {
      secondsRemainingRef.current -= 1
      if (countdownDisplay.current) {
        countdownDisplay.current.textContent = String(secondsRemainingRef.current)
      }
      if (secondsRemainingRef.current <= 0) {
        clearInterval(id)
        if (onAutoCallTriggered) {
          onAutoCallTriggered()
        }
      }
    }, 1000)

    return () => clearInterval(id)
  }, [onAutoCallTriggered])

  return (
    <section id="screen-waiting" className="screen waiting-screen">
      <div className="waiting-content">
        <p className="eyebrow">Signal</p>
        <h1 id="waiting-greeting">Hi {userName || 'there'}</h1>
        <p className="subtitle">Your AI assistant is preparing to call you...</p>

        <div className="waiting-timer">
          <div className="countdown" ref={countdownDisplay}>10</div>
          <p className="countdown-label">seconds</p>
        </div>

        <p className="waiting-info">Please keep your microphone enabled for the call.</p>
      </div>
    </section>
  )
}
