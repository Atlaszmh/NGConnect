import api from './api';

const TOKEN_KEY = 'ngconnect_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

export async function login(username: string, password: string): Promise<string> {
  const res = await api.post('/auth/login', { username, password });
  const token = res.data.token;
  setToken(token);
  return token;
}

export function logout() {
  clearToken();
  window.location.reload();
}

// Set up axios interceptor to include token
api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 responses
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      clearToken();
      window.location.reload();
    }
    return Promise.reject(error);
  }
);
