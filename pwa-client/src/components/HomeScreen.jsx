import { useCallHistory } from '../hooks/useCallHistory'
import HistoryList from './HistoryList'
import PresencePill from './PresencePill'

export default function HomeScreen({ userName, isConnected, userId }) {
  const { calls } = useCallHistory(userId)

  return (
    <section id="screen-home" className="screen home-screen">
      <div className="home-header">
        <div>
          <p className="eyebrow">Signal</p>
          <h1 id="home-greeting">Hi {userName || 'there'}</h1>
        </div>
        {/* <PresencePill isOnline={isConnected} /> */}
      </div>

      <div className="status-card history-preview" >
        <p className="label">Recent calls</p>
        <div id="history-list">
          <HistoryList calls={calls} />
        </div>
      </div>
    </section>
  )
}
