// When the app is served by the local FastAPI backend (start.bat / uvicorn),
// talk to that same server. The deployed frontend (GitHub Pages) keeps
// pointing at the Render API.
window.BACKEND_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? location.origin
  : 'https://trade-tracker-api-5e2o.onrender.com';
