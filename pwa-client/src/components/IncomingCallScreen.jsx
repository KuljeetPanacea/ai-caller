import PulseAvatar from './PulseAvatar'
import CallAction from './CallAction'
import CallControls from './CallControls'

export default function IncomingCallScreen({ callerName, onAccept, onDecline }) {
  return (
    <section id="screen-incoming" className="screen call-screen">
      <div className="caller-block">
        <PulseAvatar />
        <p className="caller-name" id="incoming-caller-name">{callerName || 'AI Assistant'}</p>
        <p className="call-status-text">Incoming call…</p>
      </div>

      <CallControls variant="incoming">
        <CallAction icon="✕" label="Decline" onClick={onDecline} className="decline" />
        <CallAction icon="✓" label="Accept" onClick={onAccept} className="accept" />
      </CallControls>
    </section>
  )
}
