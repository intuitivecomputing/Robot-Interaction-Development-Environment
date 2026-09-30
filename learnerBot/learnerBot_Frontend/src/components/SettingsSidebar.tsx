import { useState, useEffect, useRef } from 'react';
import { FACIAL_EXPRESSION_OPTIONS, GESTURE_OPTIONS, GESTURE_LABELS } from '../utils/deploymentPrompt';
import LanguagePicker from './LanguagePicker';

const VOICE_OPTIONS = [
  { id: 'ash', label: 'Ash'},
  { id: 'coral', label: 'Coral' },
  { id: 'echo', label: 'Echo' },
  { id: 'nova', label: 'Nova' },

];

export default function SettingsSidebar() {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  const [name, setName] = useState('Robot');
  const [voice, setVoice] = useState('ash');
  const [voiceInstructions, setVoiceInstructions] = useState('');
  const [languages, setLanguages] = useState<string[]>(['en-US']);
  const voiceSampleRef = useRef<HTMLAudioElement | null>(null);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [unavailableVoices, setUnavailableVoices] = useState<Set<string>>(new Set());
  // All expressions/gestures start selected; toggling one off narrows generateNodeOutputStructure's list.
  const [facialExpressions, setFacialExpressions] = useState<string[]>(FACIAL_EXPRESSION_OPTIONS);
  const [gestures, setGestures] = useState<string[]>(GESTURE_OPTIONS);
  const [pace, setPace] = useState('Normal');

  const currentUser = localStorage.getItem("currentUser") || "user1";
  const activeRobot = localStorage.getItem("activeRobot") || "whiteBot";

  useEffect(() => {
    if (!isOpen) return;

    const fetchSettings = async () => {
      setIsLoading(true);
      try {
        const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
        const response = await fetch(`${apiBase}/api/settings/${activeRobot}/${currentUser}`);
        if (!response.ok) throw new Error("Failed to fetch settings");

        const data = await response.json();
        setName(data.name || 'Robot');
        setVoice(data.voice || 'ash');
        setVoiceInstructions(data.voiceInstructions || '');
        setLanguages(Array.isArray(data.languages) && data.languages.length > 0 ? data.languages : ['en-US']);
        setFacialExpressions(Array.isArray(data.facialExpressions) ? data.facialExpressions : FACIAL_EXPRESSION_OPTIONS);
        setGestures(Array.isArray(data.gestures) ? data.gestures : GESTURE_OPTIONS);
        setPace(data.pace || 'Normal');
      } catch (error) {
        console.error("Error fetching global settings:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSettings();
  }, [isOpen, activeRobot, currentUser]);

  const toggleExpression = (expression: string) => {
    setFacialExpressions((prev) =>
      prev.includes(expression) ? prev.filter((e) => e !== expression) : [...prev, expression]
    );
  };

  const toggleGesture = (gesture: string) => {
    setGestures((prev) =>
      prev.includes(gesture) ? prev.filter((g) => g !== gesture) : [...prev, gesture]
    );
  };

  // Plays /public/audio/voices/{voiceId}.mp3 via a single shared <audio> element.
  // Voices without a sample file yet just get a disabled button instead of erroring.
  const playVoiceSample = (voiceId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (unavailableVoices.has(voiceId)) return;

    const audio = voiceSampleRef.current;
    if (!audio) return;

    if (playingVoice === voiceId) {
      audio.pause();
      audio.currentTime = 0;
      setPlayingVoice(null);
      return;
    }

    audio.src = `/audio/voices/${voiceId}.mp3`;
    setPlayingVoice(voiceId);
    audio.play().catch(() => {
      setUnavailableVoices((prev) => new Set(prev).add(voiceId));
      setPlayingVoice(null);
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    setIsSaved(false);
    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/settings/${activeRobot}/${currentUser}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          voice,
          voiceInstructions,
          languages,
          facialExpressions,
          gestures,
          pace
        })
      });
      if (!response.ok) throw new Error("Failed to save settings");
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2000);
    } catch (error) {
      console.error("Error saving global settings:", error);
      alert("Could not save settings. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      {/* Floating Toggle Button */}
      <button
        onClick={() => setIsOpen(true)}
        className={`fixed bottom-6 right-6 z-40 bg-slate-800 hover:bg-slate-900 text-white p-4 rounded-full shadow-lg transition-all ${
          isOpen ? 'opacity-0 pointer-events-none scale-90' : 'opacity-100 scale-100'
        }`}
        title="Robot Settings"
      >
        <span className="text-xl">⚙️</span>
      </button>

      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-slate-900/20 z-40"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sliding Panel */}
      <div
        className={`fixed top-0 right-0 h-full w-full max-w-sm bg-white shadow-2xl z-50 transition-transform duration-300 flex flex-col ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50 shrink-0">
          <div>
            <h3 className="font-bold text-lg text-slate-800">Robot Settings</h3>
            <p className="text-xs text-slate-500">Applied to every activity that is sent to the Robot</p>
          </div>
          <button onClick={() => setIsOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
          {isLoading ? (
            <p className="text-slate-400 text-sm animate-pulse text-center py-8">Loading settings...</p>
          ) : (
            <>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Robot Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Robot" className="w-full bg-slate-50 border border-slate-200 p-3 rounded-lg outline-none focus:border-indigo-400 text-sm" />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Robot Voice</label>
                <div className="flex items-center gap-2">
                  <select
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                    className="flex-1 bg-slate-50 border border-slate-200 p-3 rounded-lg outline-none focus:border-indigo-400 text-sm"
                  >
                    {VOICE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={(e) => playVoiceSample(voice, e)}
                    disabled={unavailableVoices.has(voice)}
                    title={unavailableVoices.has(voice) ? 'No sample available yet' : 'Play sample'}
                    className={`shrink-0 w-10 h-10 flex items-center justify-center rounded-full text-xs transition-colors ${
                      unavailableVoices.has(voice)
                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                        : playingVoice === voice
                        ? 'bg-indigo-600 text-white'
                        : 'bg-white border border-slate-300 text-slate-600 hover:bg-indigo-100'
                    }`}
                  >
                    {playingVoice === voice ? (
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="5" y="5" width="14" height="14" rx="2"></rect>
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="6 4 20 12 6 20 6 4"></polygon>
                      </svg>
                    )}
                  </button>
                </div>
                <audio
                  ref={voiceSampleRef}
                  onEnded={() => setPlayingVoice(null)}
                  onError={() => {
                    setUnavailableVoices((prev) => (playingVoice ? new Set(prev).add(playingVoice) : prev));
                    setPlayingVoice(null);
                  }}
                  className="hidden"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Robot Voice Instructions</label>
                <textarea value={voiceInstructions} onChange={(e) => setVoiceInstructions(e.target.value)} placeholder="e.g. Warm, cheerful, and encouraging tone" className="w-full bg-slate-50 border border-slate-200 p-3 rounded-lg outline-none focus:border-indigo-400 text-sm resize-none min-h-[80px]" />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Robot Language(s)</label>
                <p className="text-xs text-slate-400 mb-2">What the robot itself listens for during a live activity — pick a maximum of 2 for mixed-language learners.</p>
                <LanguagePicker selected={languages} onChange={setLanguages} />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Robot Facial Expressions</label>
                <p className="text-xs text-slate-400 mb-2">All expressions are enabled by default — click the × to remove one, click a greyed-out option to bring it back.</p>
                <div className="flex flex-wrap gap-2">
                  {FACIAL_EXPRESSION_OPTIONS.map((expression) => {
                    const isSelected = facialExpressions.includes(expression);
                    return (
                      <button
                        key={expression}
                        type="button"
                        onClick={() => toggleExpression(expression)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-semibold capitalize transition-all ${
                          isSelected
                            ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                            : 'border-slate-200 bg-slate-50 text-slate-400'
                        }`}
                      >
                        {expression}
                        {isSelected && <span className="text-indigo-400 font-bold">×</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Robot Gestures</label>
                <p className="text-xs text-slate-400 mb-2">All gestures are enabled by default — click the × to remove one, click a greyed-out option to bring it back.</p>
                <div className="flex flex-wrap gap-2">
                  {GESTURE_OPTIONS.map((gesture) => {
                    const isSelected = gestures.includes(gesture);
                    return (
                      <button
                        key={gesture}
                        type="button"
                        onClick={() => toggleGesture(gesture)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-semibold capitalize transition-all ${
                          isSelected
                            ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                            : 'border-slate-200 bg-slate-50 text-slate-400'
                        }`}
                      >
                        {GESTURE_LABELS[gesture] || gesture}
                        {isSelected && <span className="text-indigo-400 font-bold">×</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Robot Speaking Pace</label>
                <select value={pace} onChange={(e) => setPace(e.target.value)} className="w-full bg-slate-50 border border-slate-200 p-3 rounded-lg outline-none focus:border-indigo-400 text-sm">
                  <option value="Slow">Slow</option>
                  <option value="Normal">Normal</option>
                  <option value="Fast">Fast</option>
                </select>
              </div>

            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 shrink-0">
          <button
            onClick={handleSave}
            disabled={isSaving || isLoading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl shadow transition-all disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : isSaved ? '✓ Saved' : 'Save Settings'}
          </button>
        </div>
      </div>
    </>
  );
}
