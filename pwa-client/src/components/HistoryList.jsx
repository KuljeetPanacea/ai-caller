export default function HistoryList({ calls }) {
  const list = calls.slice(0, 6)
  if (list.length === 0) {
    return <p className="hint" style={{ margin: '4px 0 0' }}>No calls yet.</p>
  }

  return (
    <>
      {list.map((call) => {
        const when = new Date(call.createdAt).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
        const duration = call.durationSeconds
          ? `${Math.floor(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s`
          : ''
        return (
          <div key={call._id || call.callId} className="history-item">
            <div>
              <div>AI Assistant</div>
              <div className="meta">{when}{duration ? ' · ' + duration : ''}</div>
            </div>
            <span className={`status-tag ${call.status}`}>{call.status}</span>
          </div>
        )
      })}
    </>
  )
}
