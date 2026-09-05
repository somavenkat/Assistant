import { useEffect, useRef } from 'react';
import { parseCallTranscript } from '../transcript';

type Props = {
  transcript: string;
  callerName: string;
  calleeName: string;
  live?: boolean;
};

export default function CallTranscript({ transcript, callerName, calleeName, live }: Props) {
  const turns = parseCallTranscript(transcript, callerName, calleeName);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!live || !scroller.current) return;
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [live, transcript, turns.length]);

  if (!turns.length) {
    if (live) {
      return (
        <div className="call-transcript live-empty" role="status">
          <p className="live-waiting">On the line… messages will show here as they speak.</p>
        </div>
      );
    }
    return <pre className="transcript-fallback">{transcript}</pre>;
  }

  return (
    <div
      ref={scroller}
      className={`call-transcript${live ? ' is-live' : ''}`}
      role="log"
      aria-label="Call transcript"
      aria-live="polite"
    >
      <div className="transcript-legend">
        {live && <span className="live-pill">Live</span>}
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
