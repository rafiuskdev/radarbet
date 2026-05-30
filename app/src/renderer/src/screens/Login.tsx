import { useState, FormEvent } from 'react'

const VALID_EMAIL    = 'teste@teste.com'
const VALID_PASSWORD = 'senha123'

interface Props {
  onLogin: () => void
}

export function Login({ onLogin }: Props) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    await new Promise(r => setTimeout(r, 400))

    // Aceita credenciais vazias para agilizar o desenvolvimento
    const isDevBypass = email === '' && password === ''
    const isValid     = isDevBypass || (email === VALID_EMAIL && password === VALID_PASSWORD)

    if (isValid) {
      onLogin()
    } else {
      setError('Email ou senha inválidos.')
      setLoading(false)
    }
  }

  return (
    <div className="screen-login">
      {/* Barra de drag no topo (frameless window) */}
      <div className="login-drag-bar rb-drag" />

      <div className="login-card rb-no-drag">
        <div className="login-brand">
          <div className="login-logo-circle">R</div>
          <span className="login-brand-name">RADARBET</span>
        </div>

        <h1 className="login-title">Bem-vindo de volta</h1>
        <p className="login-subtitle">Faça login para acessar o radar</p>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label className="login-label" htmlFor="email">Email</label>
            <input
              id="email"
              className="login-input"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="seu@email.com"
              autoComplete="email"
            />
          </div>

          <div className="login-field">
            <label className="login-label" htmlFor="password">Senha</label>
            <input
              id="password"
              className="login-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? 'Entrando…' : 'Entrar →'}
          </button>
        </form>
      </div>
    </div>
  )
}
