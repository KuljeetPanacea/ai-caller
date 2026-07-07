import { useState, useEffect, useRef, useCallback } from 'react'

export function useWaitingCountdown(initialSeconds = 10, onComplete) {
  const [secondsRemaining, setSecondsRemaining] = useState(initialSeconds)
  const intervalRef = useRef(null)
  const onCompleteRef = useRef(onComplete)

  useEffect(() => {
    onCompleteRef.current = onComplete
  }, [onComplete])

  const start = useCallback(() => {
    setSecondsRemaining(initialSeconds)
    intervalRef.current = setInterval(() => {
      setSecondsRemaining(prev => {
        if (prev <= 1) {
          clearInterval(intervalRef.current)
          if (onCompleteRef.current) onCompleteRef.current()
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }, [initialSeconds])

  const stop = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
  }, [])

  useEffect(() => {
    return () => stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop])

  return { secondsRemaining, start, stop }
}
