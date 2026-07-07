import PulseAvatar from './PulseAvatar'
import CallAction from './CallAction'
import CallControls from './CallControls'

export default function ActiveCallScreen({ statusText, callTimer, isMuted, onMute, onEnd }) {
  return (
    <section id="screen-active" className="screen call-screen">
      <div className="caller-block">
        <PulseAvatar />
        <p className="caller-name">AI Assistant</p>
        <p className="call-status-text" id="active-status-text">{statusText || 'Connecting…'}</p>
        <p className="call-timer" id="call-timer">{callTimer || '00:00'}</p>
      </div>

      <CallControls>
        <CallAction icon="🎤" label="Mute" onClick={onMute} className={`mute ${isMuted ? 'active' : ''}`} />
        <CallAction icon="✕" label="End" onClick={onEnd} className="end" />
      </CallControls>
    </section>
  )
}
