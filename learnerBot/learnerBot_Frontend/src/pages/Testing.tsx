import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { fetchRobotSettings } from '../utils/deploymentPrompt';

type TranscriptMessage = { role: string; content: string; stateId?: string; stateLabel?: string; silent?: boolean };

const SIMULATION_BATCH_SIZE = 5;

export default function Testing() {
  const navigate = useNavigate();
  const location = useLocation();

  const { finalPrompt, finalFlowchart, activityTitle, activityDescription, activityConversationHistory } = location.state || {};

  const currentUser = localStorage.getItem("currentUser") || "user1";
  const activeRobot = localStorage.getItem("activeRobot") || "whiteBot";
  const activeLearner = JSON.parse(localStorage.getItem("activeLearner") || '{}');
  const profileId = activeLearner.id || "unknown";

  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGeneratingMore, setIsGeneratingMore] = useState(false);
  const [currentStateId, setCurrentStateId] = useState<string | null>(null);
  const [totalTurnsGenerated, setTotalTurnsGenerated] = useState(0);
  const [finished, setFinished] = useState(false);
  const [safetyCapped, setSafetyCapped] = useState(false);
  const [generateMoreError, setGenerateMoreError] = useState<string | null>(null);
  // What the robot will actually be restricted to speak once deployed — the preview
  // should reflect that, not default to English regardless of Robot Settings.
  const [robotLanguages, setRobotLanguages] = useState<string[]>(['en-US']);

  const runSimulationBatch = async (isInitial: boolean, languagesOverride?: string[]) => {
    if (isInitial) {
      setIsLoading(true);
    } else {
      setIsGeneratingMore(true);
      setGenerateMoreError(null);
    }

    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt: finalPrompt,
          flowchart: finalFlowchart,
          currentStateId,
          history: transcript,
          turnsToGenerate: SIMULATION_BATCH_SIZE,
          totalTurnsGenerated,
          languages: languagesOverride || robotLanguages
        })
      });

      if (!response.ok) throw new Error("Simulation failed");

      const data = await response.json();
      setTranscript((prev) => [...prev, ...data.transcript]);
      setCurrentStateId(data.currentStateId);
      setTotalTurnsGenerated(data.totalTurnsGenerated);
      setFinished(data.finished);
      setSafetyCapped(data.safetyCapped);
    } catch (error) {
      console.error(error);
      if (isInitial) {
        alert("Failed to generate preview. Check backend connection.");
      } else {
        setGenerateMoreError("Failed to generate more of the conversation. Please try again.");
      }
    } finally {
      if (isInitial) {
        setIsLoading(false);
      } else {
        setIsGeneratingMore(false);
      }
    }
  };

  useEffect(() => {
    if (!finalPrompt || !finalFlowchart) {
      // TEMPORARY: /content is bypassed — revert to navigate('/content') once it's back.
      navigate('/design');
      return;
    }

    // Phase 3 timing — only seeded for a real visit, not the missing-state bounce above.
    if (!sessionStorage.getItem('phaseStart_testing')) {
      sessionStorage.setItem('phaseStart_testing', new Date().toISOString());
    }

    // Fetch languages before the first batch so it's not sent with the English
    // default — later "Generate More" batches just read the now-settled state.
    const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
    fetchRobotSettings(apiBase, activeRobot, currentUser).then((settings) => {
      const languages = Array.isArray(settings?.languages) && settings.languages.length > 0 ? settings.languages : ['en-US'];
      setRobotLanguages(languages);
      runSimulationBatch(true, languages);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalPrompt, finalFlowchart, navigate]);

  const handleReadyForRobot = async () => {
    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      await fetch(`${apiBase}/api/activity-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machine_name: activeRobot,
          user_id: currentUser,
          profile_id: profileId,
          login_timestamp: localStorage.getItem("loginTimestamp") || "unknown_session",
          log_type: 'phase',
          event: 'completed',
          entity_id: 'testing',
          entity_title: 'Interaction Preview',
          phase_entered_at: sessionStorage.getItem('phaseStart_testing') || '',
          phase_exited_at: new Date().toISOString()
        })
      });
      sessionStorage.removeItem('phaseStart_testing');
    } catch (logError) {
      console.error('Error writing phase log:', logError);
    }
    navigate('/deploy', { state: { finalPrompt, finalFlowchart, title: activityTitle } });
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 text-center flex flex-col gap-4 items-center min-h-screen justify-center">

      <div className="w-full flex justify-between items-center mb-1">
        {/* TEMPORARY: routes to /design instead of /content while context injection is bypassed. Revert alongside Design.tsx's handleContinueToContent. */}
        <button
          onClick={() => navigate('/design')}
          className="text-sm font-bold text-slate-400 hover:text-indigo-600 transition-colors"
        >
          ← Back to Activity Structures
        </button>
        <span className="text-xs font-semibold bg-orange-100 text-orange-800 px-3 py-1 rounded-full uppercase tracking-wider">
          Phase 3: Interaction Preview
        </span>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm w-full flex flex-col flex-1 max-h-[85vh]">
        <span className="text-3xl mb-3 block">🧪</span>
        <h1 className="text-2xl font-bold text-slate-800 mb-1">Testing Workspace</h1>
        <p className="text-slate-500 text-sm mb-5">
          This is a short, AI-generated preview of how your robot will behave using the current logic.
        </p>

        <div className="flex-1 bg-slate-50 border border-slate-200 rounded-xl overflow-y-auto max-h-[600px] mb-4 min-h-[300px]">
          {isLoading ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400">
              <span className="text-4xl mb-4 animate-bounce">⌛</span>
              <p className="font-semibold animate-pulse">Creating the conversation...</p>
            </div>
          ) : transcript.length === 0 ? (
            <div className="h-full flex items-center justify-center text-slate-400">
              <p>No simulation data available.</p>
            </div>
          ) : (
            <div className="p-6 space-y-4 text-left">
              {transcript.map((msg, idx) => (
                <div key={idx} className={`flex w-full ${msg.role === 'robot' ? 'justify-start' : 'justify-end'}`}>
                  {msg.silent ? (
                    <div className="max-w-[85%] px-4 py-1 text-xs italic text-slate-400">
                      {msg.role === 'robot' ? '🤖' : '👤'} <span className="tracking-widest">{msg.content}</span> <span className="opacity-70">(waiting silently)</span>
                    </div>
                  ) : (
                    <div className={`max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed ${
                      msg.role === 'robot'
                        ? 'bg-white border border-indigo-100 text-indigo-900 rounded-tl-sm shadow-sm'
                        : 'bg-indigo-600 text-white rounded-tr-sm shadow-sm'
                    }`}>
                      <span className="block text-xs font-bold uppercase mb-1 opacity-60">
                        {msg.role === 'robot' ? '🤖 Robot' : '👤 User'}
                      </span>
                      {msg.content}
                    </div>
                  )}
                </div>
              ))}
              <div className="h-6 flex-shrink-0 w-full"></div>
            </div>
          )}
        </div>

        {!isLoading && transcript.length > 0 && (
          <div className="mb-6 flex flex-col items-center gap-2 shrink-0">
            {finished ? (
              <span className="text-sm font-semibold text-emerald-600 bg-emerald-50 border border-emerald-100 px-4 py-2 rounded-full">
                Simulation complete — reached an end state.
              </span>
            ) : safetyCapped ? (
              <span className="text-sm font-semibold text-amber-700 bg-amber-50 border border-amber-100 px-4 py-2 rounded-full">
                Safety cap reached — this flowchart may have an unresolved loop.
              </span>
            ) : (
              <button
                onClick={() => runSimulationBatch(false)}
                disabled={isGeneratingMore}
                className={`font-bold py-2 px-6 rounded-xl border-2 transition-all ${
                  isGeneratingMore
                    ? 'border-slate-200 text-slate-400 cursor-not-allowed'
                    : 'border-indigo-200 text-indigo-600 hover:border-indigo-400 hover:bg-indigo-50'
                }`}
              >
                {isGeneratingMore ? 'Generating…' : 'Generate more ↓'}
              </button>
            )}
            {generateMoreError && (
              <span className="text-xs font-medium text-red-500">{generateMoreError}</span>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 shrink-0">
          {/* TEMPORARY: while context injection is bypassed, this hands the activity straight back into Design's voice-input view instead of the context editor. Revert alongside Design.tsx's handleContinueToContent. */}
          <button
            onClick={() => navigate('/design', {
              state: {
                tweakPrompt: finalPrompt,
                tweakFlowchart: finalFlowchart,
                tweakTitle: activityTitle,
                tweakDescription: activityDescription,
                tweakConversationHistory: activityConversationHistory
              }
            })}
            className="bg-white border-2 border-slate-200 hover:border-slate-300 text-slate-600 font-bold py-3 rounded-xl transition-all"
          >
            Needs Tweaking
          </button>

          <button
            disabled={isLoading}
            onClick={handleReadyForRobot}
            className={`font-bold py-3 rounded-xl shadow transition-all text-white
              ${isLoading ? 'bg-amber-300 cursor-not-allowed' : 'bg-amber-500 hover:bg-amber-600'}`}
          >
            Ready for Robot →
          </button>
        </div>
      </div>
    </div>
  );
}
