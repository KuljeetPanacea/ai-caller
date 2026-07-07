import { useState, useEffect, useCallback } from 'react'

export function useCallHistory(userId) {
  const [calls, setCalls] = useState([])

  const loadHistory = useCallback(async () => {
    if (!userId) return
    try {
      const res = await fetch(`${import.meta.env.VITE_SIGNALING_SERVER_URL}/calls/${userId}`)
      const data = await res.json()
      setCalls(data.calls || [])
    } catch {
      // silent — history is a nice-to-have on the home screen
    }
  }, [userId])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  return { calls, reload: loadHistory }
}
