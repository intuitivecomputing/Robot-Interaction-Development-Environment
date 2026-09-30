import React, { useEffect, useRef, useState } from 'react';

// Soft auto-stop nudge before recordings get unwieldy.
export const RECORDING_LIMIT_SECONDS = 50;

// Fires onTimeout() once, durationSeconds after isRecording goes true. Caller stops the recorder.
export function useRecordingCountdown(
  isRecording: boolean,
  onTimeout: () => void,
  durationSeconds: number = RECORDING_LIMIT_SECONDS
) {
  const onTimeoutRef = useRef(onTimeout);

  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);

  useEffect(() => {
    if (!isRecording) return;
    const timeoutId = setTimeout(() => onTimeoutRef.current(), durationSeconds * 1000);
    return () => clearTimeout(timeoutId);
  }, [isRecording, durationSeconds]);
}

interface RecordingRingProps {
  isRecording: boolean;
  durationSeconds: number;
  size: number; // should match the wrapped button's width/height in px
  strokeWidth?: number;
  className?: string;
  children: React.ReactNode;
}

// Circular countdown ring around a record button; CSS-transition driven, not per-frame state.
export default function RecordingRing({ isRecording, durationSeconds, size, strokeWidth = 5, className, children }: RecordingRingProps) {
  const ringSize = size + strokeWidth * 2 + 4;
  const radius = (ringSize - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  // Flips true a frame after mount so the transition animates instead of snapping.
  const [depleted, setDepleted] = useState(false);
  const [runningLow, setRunningLow] = useState(false);

  useEffect(() => {
    if (!isRecording) {
      setDepleted(false);
      setRunningLow(false);
      return;
    }

    setDepleted(false);
    setRunningLow(false);
    const rafId = requestAnimationFrame(() => setDepleted(true));
    const lowTimeoutId = setTimeout(() => setRunningLow(true), durationSeconds * 0.8 * 1000);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(lowTimeoutId);
    };
  }, [isRecording, durationSeconds]);

  return (
    <div className={`relative inline-flex items-center justify-center ${className || ''}`} style={{ width: ringSize, height: ringSize }}>
      {isRecording && (
        <svg width={ringSize} height={ringSize} className="absolute top-0 left-0 -rotate-90">
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={radius}
            fill="none"
            stroke="#e2e8f0"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={radius}
            fill="none"
            stroke={runningLow ? '#ef4444' : '#3b82f6'}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={depleted ? circumference : 0}
            strokeLinecap="round"
            style={{
              transition: depleted
                ? `stroke-dashoffset ${durationSeconds}s linear, stroke 0.3s ease`
                : 'none'
            }}
          />
        </svg>
      )}
      <div className="absolute" style={{ width: size, height: size }}>
        {children}
      </div>
    </div>
  );
}
