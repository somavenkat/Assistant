import { parseCallTranscript } from '../transcript';

type Props = {
  transcript: string;
  callerName: string;
  calleeName: string;
};

export default function CallTranscript({ transcript, callerName, calleeName }: Props) {
  const turns = parseCallTranscript(transcript, callerName, calleeName);

  if (!turns.length) {
    return <pre className="transcript-fallback">{transcript}</pre>;
  }

  return (
    <div className="call-transcript" role="log" aria-label="Call transcript">
      <div className="transcript-legend">
        <span className="legend-item legend-callee">{calleeName}</span>
        <span className="legend-item legend-caller">{callerName} (your side)</span>
      </div>
      {turns.map((turn, idx) => (
        <div
          key={idx}
          className={`transcript-turn ${turn.speaker === 'caller' ? 'turn-caller' : 'turn-callee'}`}
        >
          <span className="turn-label">{turn.label}</span>
          <div className="turn-bubble">{turn.text}</div>
        </div>
      ))}
    </div>
  );
}
