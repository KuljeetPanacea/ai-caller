import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

export function useSocket(userId, token) {
  const [isConnected, setIsConnected] = useState(false)
  const socketRef = useRef(null)

  useEffect(() => {
    if (!userId || !token) return

    const socket = io(import.meta.env.VITE_SIGNALING_SERVER_URL, { transports: ['websocket'] })
    socketRef.current = socket

    socket.on('connect', () => {
      setIsConnected(true)
      socket.emit('register', { userId, token }, (ack) => {
        if (!ack?.ok) {
          console.error('[socket] register ack failed', ack)
        }
      })
    })

    socket.on('disconnect', () => {
      setIsConnected(false)
    })

    return () => {
      socket.disconnect()
    }
  }, [userId, token])

  const emit = (event, data, ack) => {
    if (socketRef.current) {
      socketRef.current.emit(event, data, ack)
    }
  }

  return { socket: socketRef.current, isConnected, emit }
}
