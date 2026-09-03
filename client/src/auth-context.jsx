// Who is signed in, app-wide. Restores the session from the stored token on
// page load and exposes login / register / logout to the components.
import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken, clearToken } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api('/api/auth/me')
      .then(({ user }) => setUser(user))
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const { token, user } = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setToken(token);
    setUser(user);
    return user; // the caller routes by role — see homePath()
  };

  const register = async (name, email, password) => {
    const { token, user } = await api('/api/auth/register', {
      method: 'POST',
      body: { name, email, password },
    });
    setToken(token);
    setUser(user);
    return user;
  };

  const logout = () => {
    clearToken();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
