import { useState, useCallback } from 'react'

const TOKEN_KEY = 'signal_token'
const USER_ID_KEY = 'signal_userId'
const USER_NAME_KEY = 'signal_userName'

export function useAuth() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [userId, setUserId] = useState(() => localStorage.getItem(USER_ID_KEY))
  const [userName, setUserName] = useState(() => localStorage.getItem(USER_NAME_KEY) || '')
  const [error, setError] = useState('')

  const login = useCallback(async (phone) => {
    const res = await fetch(`${import.meta.env.VITE_SIGNALING_SERVER_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    })
    const data = await res.json()
    if (!res.ok) {
      const message = data.message || data.error || 'Phone number not registered.'
      setError(message)
      return false
    }
    setToken(data.token)
    setUserId(data.user.id)
    setUserName(data.user.name || '')
    localStorage.setItem(TOKEN_KEY, data.token)
    localStorage.setItem(USER_ID_KEY, data.user.id)
    localStorage.setItem(USER_NAME_KEY, data.user.name || '')
    setError('')
    return true
  }, [])

  const clear = useCallback(() => {
    setToken(null)
    setUserId(null)
    setUserName('')
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_ID_KEY)
    localStorage.removeItem(USER_NAME_KEY)
  }, [])

  return { token, userId, userName, error, login, clear }
}
