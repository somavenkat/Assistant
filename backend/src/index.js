const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
  if (!config.vapi.apiKey) {
    console.warn('WARNING: VAPI_API_KEY is empty — outbound calls will fail until you add it.');
  }
});
