const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

function required(name, optional = false) {
  const value = process.env[name];
  if (!value && !optional) {
    console.warn(`[config] Missing ${name}`);
  }
  return value || '';
}

module.exports = {
  port: Number(process.env.PORT || 3001),
  openaiApiKey: required('OPENAI_API_KEY'),
  twilio: {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: required('TWILIO_AUTH_TOKEN'),
    phoneNumber: required('TWILIO_PHONE_NUMBER'),
  },
  vapi: {
    apiKey: required('VAPI_API_KEY', true),
    assistantId: required('VAPI_ASSISTANT_ID'),
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID || '',
    voiceId: process.env.VAPI_VOICE_ID || 'Sagar',
  },
  googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY || '',
};