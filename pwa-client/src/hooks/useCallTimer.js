import { useState, useEffect,useCallback, useRef } from 'react'

export function useCallTimer() {
  const [elapsed, setElapsed] = useState('00:00')
  const startTimeRef = useRef(null)
  const intervalRef = useRef(null)

  const start = useCallback(() => {
    startTimeRef.current = Date.now()
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = setInterval(() => {
      const now = Date.now()
      const diff = Math.floor((now - startTimeRef.current) / 1000)
      const mm = String(Math.floor(diff / 60)).padStart(2, '0')
      const ss = String(diff % 60).padStart(2, '0')
      setElapsed(`${mm}:${ss}`)
    }, 1000)
  }, [])

  const stop = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    setElapsed('00:00')
    startTimeRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  return { elapsed, start, stop }
}
