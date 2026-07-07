export default function ThankYouScreen({ onGoHome }) {
  return (
    <section id="screen-thank-you" className="screen thank-you-screen" onClick={onGoHome}>
      <div className="thank-you-content">
        <div className="thank-you-icon">🙏</div>
        <h1>Thank you!</h1>
        <p className="subtitle">Your call has ended. Have a great day!</p>
      </div>
    </section>
  )
}
