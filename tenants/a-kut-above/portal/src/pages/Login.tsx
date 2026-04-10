import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [stayLoggedIn, setStayLoggedIn] = useState(false);
  const { login, loading, error } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await login(username, password, stayLoggedIn);
    if (ok) navigate('/', { replace: true });
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-brand">A Kut Above</h1>
        <h2 className="login-subtitle">Tree Services</h2>
        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <div className="password-field">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="toggle-pw"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          <div className="form-group checkbox-group">
            <label>
              <input
                type="checkbox"
                checked={stayLoggedIn}
                onChange={(e) => setStayLoggedIn(e.target.checked)}
              />
              Stay Logged In
            </label>
          </div>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="btn-primary btn-full" disabled={loading}>
            {loading ? 'Logging in...' : 'Log In'}
          </button>
        </form>
      </div>
    </div>
  );
}
