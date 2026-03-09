import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.DEV ? 'http://localhost:3001/api' : '/api',
  timeout: 15000,
});

export default api;
