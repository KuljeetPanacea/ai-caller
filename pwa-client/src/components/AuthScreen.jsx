import { useState } from 'react'

export default function AuthScreen({ login, error }) {
  const [phone, setPhone] = useState('')

  const handleSubmit = async (e) => {
    console.log("AuthScreen handleSubmit", { phone })
    e.preventDefault()
    if (!phone.trim()) return
    await login(phone.trim())
  }

  return (
    <section id="screen-auth" className="screen auth-screen active">
      <div className="auth-mark">S</div>
      <p className="eyebrow">Signal</p>
      <h1>Your AI keeps in touch</h1>
      <p className="subtitle">Enter your registered phone number to continue. If your number is not found, the app will tell you you are not registered.</p>

      <form className="field" onSubmit={handleSubmit}>
        <label htmlFor="phone-input">Phone number</label>
        <input
          id="phone-input"
          type="tel"
          placeholder="9499346014"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <p className="error-text" id="phone-error">{error}</p>
        <button className="btn btn-primary btn-block" id="btn-request-otp" type="submit">Continue</button>
      </form>
    </section>
  )
}
