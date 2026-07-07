export default function PresencePill({ isOnline }) {
  return (
    <div className={`presence-pill ${isOnline ? 'online' : ''}`}>
      <span className="presence-dot"></span>
      <span id="presence-text">{isOnline ? 'Online' : 'Connecting'}</span>
    </div>
  )
}
