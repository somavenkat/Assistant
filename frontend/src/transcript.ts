export type TranscriptTurn = {
  speaker: 'caller' | 'callee';
  label: string;
  text: string;
};

const SPEAKER_PREFIX = /^(AI|User|Assistant|Customer|Bot|Human):\s*(.*)$/i;

export function parseCallTranscript(
  transcript: string,
  callerName: string,
  calleeName: string
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const lines = transcript.split('\n').map((l) => l.trim()).filter(Boolean);

  let current: TranscriptTurn | null = null;

  for (const line of lines) {
    const match = line.match(SPEAKER_PREFIX);
    if (match) {
      if (current) turns.push(current);
      const role = match[1].toLowerCase();
      const isCaller = role === 'ai' || role === 'assistant' || role === 'bot';
      current = {
        speaker: isCaller ? 'caller' : 'callee',
        label: isCaller ? callerName : calleeName,
        text: match[2] || '',
      };
      continue;
    }
    if (current) {
      current.text = current.text ? `${current.text} ${line}` : line;
    }
  }

  if (current) turns.push(current);
  return turns;
}
