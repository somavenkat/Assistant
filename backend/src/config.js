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
    voiceProvider: process.env.VAPI_VOICE_PROVIDER || 'vapi',
    voiceId: process.env.VAPI_VOICE_ID || 'Sagar',
    elevenLabsModel: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
    elevenLabsCredentialId: process.env.ELEVENLABS_CREDENTIAL_ID || '',
    voiceFallbackProvider: process.env.VAPI_VOICE_FALLBACK || 'vapi',
    voiceFallbackId: process.env.VAPI_VOICE_FALLBACK_ID || 'Sagar',
    // Live phone LLM — gpt-4.1 follows "talk like a person" better than gpt-4o / mini.
    callModel: process.env.VAPI_LLM_MODEL || 'gpt-4.1',
  },
  openai: {
    planModel: process.env.OPENAI_PLAN_MODEL || 'gpt-4.1',
    cheapModel: process.env.OPENAI_CHEAP_MODEL || 'gpt-4o-mini',
  },
  googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY || '',
};