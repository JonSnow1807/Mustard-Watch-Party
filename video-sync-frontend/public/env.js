// Environment configuration for deployment
window.ENV = {
  API_URL: process.env.REACT_APP_API_URL || 'http://localhost:3000',
  WS_URL: process.env.REACT_APP_WS_URL || 'ws://localhost:3000'
}; 