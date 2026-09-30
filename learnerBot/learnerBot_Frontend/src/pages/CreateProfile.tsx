import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import RecordingRing, { useRecordingCountdown, RECORDING_LIMIT_SECONDS } from '../components/RecordingRing';
import { finalizeRecordingBlob } from '../utils/audioRecording';

export default function CreateProfile() {
  const navigate = useNavigate();
  
  // Voice State
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [, setLatestTranscript] = useState("");
  const [latestAiQuestion, setLatestAiQuestion] = useState("");
  const [chatHistory, setChatHistory] = useState<any[]>([]);
  
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef<number>(0);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  
  // Profile Data State
  const [learnerName, setLearnerName] = useState("");
  const [targetAge, setTargetAge] = useState("");
  const [cognitiveProfile, setCognitiveProfile] = useState("");
  const [interests, setInterests] = useState("");

  // The researcher's Settings STT language(s) — fetched once, not re-fetched per turn.
  const [sttLanguages, setSttLanguages] = useState<string[]>(["en-US"]);

  // Reference document (optional, up to 5 files at once) — extracted/distilled text
  // gets fed to the AI as background context on every turn, and saved alongside the
  // profile for future edits.
  const [referenceDocument, setReferenceDocument] = useState("");
  const [referenceFileNames, setReferenceFileNames] = useState<string[]>([]);
  const [isAnalyzingUpload, setIsAnalyzingUpload] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const MAX_UPLOAD_FILES = 5;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  // Set via /language-setup (mandatory on first login) or changed anytime via the
  // 🌐 button — sticky per-username in localStorage. Falls back to English only if
  // that's somehow missing (e.g. a bookmarked deep link before ever logging in).
  useEffect(() => {
    const currentUser = localStorage.getItem("currentUser") || "Guest";
    try {
      const saved = localStorage.getItem(`sttLanguagesOverride_${currentUser}`);
      const parsed = saved ? JSON.parse(saved) : null;
      setSttLanguages(Array.isArray(parsed) && parsed.length > 0 ? parsed : ['en-US']);
    } catch (e) {
      console.warn('Could not parse saved language override:', e);
      setSttLanguages(['en-US']);
    }
  }, []);

  const handleFileUpload = async (files: File[]) => {
    if (files.length > MAX_UPLOAD_FILES) {
      alert(`Please select at most ${MAX_UPLOAD_FILES} files at once.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsAnalyzingUpload(true);
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      formData.append("context_type", "profile");

      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/engine/analyze-upload`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || "Failed to analyze the uploaded file(s).");
      }

      const data = await response.json();
      // Accumulates rather than replaces — lets a batch that's too large for one
      // request (the gateway caps combined request size) be uploaded in smaller
      // groups without losing what was already analyzed.
      const newText = data.referenceText || "";
      if (newText) {
        setReferenceDocument((prev) => (prev ? `${prev}\n\n${newText}` : newText));
      }
      setReferenceFileNames((prev) => [...prev, ...files.map((f) => f.name)]);

      // Only fill fields that are still empty — don't clobber what's already been said/typed.
      const suggested = data.suggestedFields || {};
      if (suggested.name && !learnerName) setLearnerName(suggested.name);
      if (suggested.targetAge && !targetAge) setTargetAge(suggested.targetAge);
      if (suggested.cognitiveProfile && !cognitiveProfile) setCognitiveProfile(suggested.cognitiveProfile);
      if (suggested.interests && !interests) setInterests(suggested.interests);
    } catch (error: any) {
      console.error("Error analyzing uploaded file(s):", error);
      alert(error.message || "Could not process those files. Please try .pdf, .docx, .txt, or image files.");
    } finally {
      setIsAnalyzingUpload(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Phase 1 timing — seeded once per visit; reload-safe since sessionStorage survives a reload.
  useEffect(() => {
    if (!sessionStorage.getItem('phaseStart_profile')) {
      sessionStorage.setItem('phaseStart_profile', new Date().toISOString());
    }
  }, []);

  const INITIAL_AI_QUESTION = "Tell me about the person we are designing for! What is their name, age, and what do they need help with?";

  // Speaks the initial greeting on load — every later turn gets audio from
  // its own voice-loop response, but this first one has no round trip yet.
  // StrictMode double-invokes effects in dev (mount -> cleanup -> mount again);
  // without this guard both invocations would independently fetch and play audio.
  useEffect(() => {
    let cancelled = false;

    const speakGreeting = async () => {
      try {
        const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
        const response = await fetch(`${apiBase}/api/engine/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: INITIAL_AI_QUESTION })
        });
        if (!response.ok) throw new Error("TTS failed");

        const data = await response.json();
        if (cancelled) return;
        const audioUrl = `data:audio/mp3;base64,${data.audio_base64}`;
        const newAudio = new Audio(audioUrl);
        audioPlayerRef.current = newAudio;
        newAudio.play().catch((e) => console.error("Playback blocked:", e));
      } catch (error) {
        console.error("Error generating greeting audio:", error);
      }
    };

    speakGreeting();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorderRef.current.onstop = async () => {
        const recordedMs = Date.now() - recordingStartedAtRef.current;
        console.log(`[RECORDING DEBUG] Actual recorded duration: ${(recordedMs / 1000).toFixed(1)}s`);
        const audioBlob = await finalizeRecordingBlob(audioChunksRef.current, 'audio/webm', recordedMs);
        await handleVoiceSubmit(audioBlob);
      };

      recordingStartedAtRef.current = Date.now();
      mediaRecorderRef.current.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Microphone access denied:", err);
      alert("Could not access microphone.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setIsProcessing(true);
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      if (isAnalyzingUpload) return;
      startRecording();
    }
  };

  // Google's synchronous speech recognition caps inline audio at 60s — auto-stop
  // a bit before that instead of letting the transcription request just fail.
  useRecordingCountdown(isRecording, stopRecording);

  const handleVoiceSubmit = async (audioBlob: Blob) => {
    try {
      const formData = new FormData();
      formData.append("audio_file", audioBlob, "voice.webm");
      formData.append("language_codes", JSON.stringify(sttLanguages));
      formData.append("reference_document", referenceDocument);

      // Grab only the last 20 messages for context memory
      const recentHistory = chatHistory.slice(-20);
      formData.append("conversation_history", JSON.stringify(recentHistory));
      
      // Send the current state of the text boxes
      formData.append("current_name", learnerName);
      formData.append("current_age", targetAge);
      formData.append("current_cognitive", cognitiveProfile);
      formData.append("current_interests", interests);

      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      
      // Points to a new profile-specific endpoint
      const response = await fetch(`${apiBase}/api/engine/profile-voice-loop`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Failed to process voice request.");
      
      const data = await response.json();
      console.log(`[RECORDING DEBUG] Transcript: "${data.transcript}"`);

      // Update text boxes if the AI extracted new info
      if (data.learnerName) setLearnerName(data.learnerName);
      if (data.targetAge) setTargetAge(data.targetAge);
      if (data.cognitiveProfile) setCognitiveProfile(data.cognitiveProfile);
      if (data.interests) setInterests(data.interests);
      if (data.history) setChatHistory(data.history);

      // Update the display logs
      if (data.transcript) setLatestTranscript(data.transcript);
      if (data.question) setLatestAiQuestion(data.question);

      // Play back the AI's vocal response
      if (data.audio_base64) {
        const audioUrl = `data:audio/mp3;base64,${data.audio_base64}`;
        if (audioPlayerRef.current) {
          audioPlayerRef.current.src = audioUrl;
          audioPlayerRef.current.play();
        } else {
          const newAudio = new Audio(audioUrl);
          audioPlayerRef.current = newAudio;
          newAudio.play();
        }
      }
    } catch (error) {
      console.error("Profile Voice Loop Error:", error);
      alert("Voice processing failed. Check console.");
    } finally {
      setIsProcessing(false);
    }
  };

  const [isSaving, setIsSaving] = useState(false);

  const saveProfile = async () => {
    if (!learnerName) return alert("Please provide a name!");

    const currentUser = localStorage.getItem("currentUser") || "Guest";
    const activeRobot = localStorage.getItem("activeRobot") || "whiteBot";

    setIsSaving(true);
    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machine_name: activeRobot,
          user_id: currentUser,
          name: learnerName,
          targetAge,
          cognitiveProfile,
          interests,
          referenceDocument
        })
      });

      if (!response.ok) throw new Error("Failed to save profile");

      const saved = await response.json();

      // Best-effort creation-process log — never let a logging failure
      // surface as a save failure to the user.
      try {
        await fetch(`${apiBase}/api/activity-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            machine_name: activeRobot,
            user_id: currentUser,
            profile_id: saved.id,
            login_timestamp: localStorage.getItem("loginTimestamp") || "unknown_session",
            log_type: 'profile',
            event: 'created',
            entity_id: saved.id,
            entity_title: learnerName,
            final_data: { name: learnerName, targetAge, cognitiveProfile, interests },
            conversation_history: chatHistory,
            phase_entered_at: sessionStorage.getItem('phaseStart_profile') || '',
            phase_exited_at: new Date().toISOString(),
            reference_document: referenceDocument
          })
        });
        sessionStorage.removeItem('phaseStart_profile');
      } catch (logError) {
        console.error('Error writing activity log:', logError);
      }

      navigate('/profiles');
    } catch (error) {
      console.error("Error saving profile:", error);
      alert("Could not save profile. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 flex flex-col gap-6">
      <div className="flex justify-between items-center mb-2">
        <button onClick={() => { audioPlayerRef.current?.pause(); navigate('/profiles'); }} className="text-sm font-bold text-slate-400 hover:text-indigo-600 transition-colors">
          ← Back to Profiles
        </button>
        <span className="text-xs font-semibold bg-rose-100 text-rose-800 px-3 py-1 rounded-full uppercase tracking-wider">
          Phase 1: User Profile Setup
        </span>
      </div>

      {/* --- Reference Document Upload (optional) --- */}
      <div className="bg-white border border-slate-200 p-5 rounded-2xl shadow-sm flex items-center gap-4 flex-wrap">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.gif,.webp"
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) handleFileUpload(Array.from(files));
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isAnalyzingUpload}
          className="text-sm font-bold py-2 px-4 rounded-xl shadow bg-white border-2 border-slate-800 text-slate-800 hover:bg-slate-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {isAnalyzingUpload ? 'Analyzing...' : '📄 Upload Reference Document(s)'}
        </button>
        {referenceFileNames.length > 0 ? (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <span className="font-semibold">{referenceFileNames.join(', ')}</span>
            <span className="text-slate-400">— the AI will use these while asking questions</span>
            <button
              type="button"
              onClick={() => { setReferenceDocument(''); setReferenceFileNames([]); }}
              className="text-slate-400 hover:text-red-500 font-bold"
              title="Remove reference document(s)"
            >
              ×
            </button>
          </div>
        ) : (
          <span className="text-sm text-slate-400">Optional, up to 5 — e.g. an IEP, assessment, or photo (.pdf, .docx, .txt, image up to 3MB each)</span>
        )}
      </div>

      {/* --- REUSED: Split-Panel Voice Agent Interface --- */}
      <div className="bg-white border border-slate-200 p-8 rounded-2xl shadow-sm flex flex-col md:flex-row gap-8 items-stretch">
        <div className="flex flex-col items-center justify-center min-w-[220px] border-b md:border-b-0 md:border-r border-slate-100 pb-8 md:pb-0 md:pr-8">
          <h3 className="text-xl font-extrabold text-slate-800 mb-8">Voice Agent</h3>
          <RecordingRing isRecording={isRecording} durationSeconds={RECORDING_LIMIT_SECONDS} size={144}>
            <button
              onClick={toggleRecording}
              disabled={isProcessing || isAnalyzingUpload}
              className={`w-36 h-36 rounded-full flex items-center justify-center font-bold text-white shadow-lg transition-all transform hover:scale-105 active:scale-95 ${
                isRecording ? 'bg-red-500 animate-pulse shadow-red-200' : isProcessing ? 'bg-slate-400 cursor-wait shadow-slate-200' : 'bg-[#4f46e5] hover:bg-[#4338ca] shadow-indigo-200'
              }`}
            >
              <span className="text-xl tracking-widest uppercase">{isRecording ? 'STOP' : isProcessing ? 'WAIT' : 'RECORD'}</span>
            </button>
          </RecordingRing>
          <p className="mt-8 text-sm text-slate-500 font-medium">
            {isRecording ? 'Listening...' : isProcessing ? 'Processing...' : 'Reply when ready!'}
          </p>
        </div>

        <div className="flex-1 flex flex-col gap-6 justify-center">
          {chatHistory.some(turn => turn.role === 'user') ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1 block">You said:</span>
              <div className="max-h-[120px] overflow-y-auto pr-2 flex flex-col gap-3 scrollbar-thin">
                {chatHistory.filter((turn) => turn.role === 'user').map((turn, idx) => (
                  <p key={idx} className="text-[15px] text-slate-600 bg-slate-50 p-4 rounded-xl border border-slate-100 italic shrink-0 font-medium">"{turn.content}"</p>
                ))}
                <div ref={chatEndRef} />
              </div>
            </div>
          ) : (
            <div>
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1 block">You said:</span>
              <div className="bg-slate-50 border border-slate-100 p-4 rounded-xl">
                <p className="text-slate-400 italic font-medium text-[15px]">Waiting for your voice input...</p>
              </div>
            </div>
          )}
          
          <div>
            <h4 className="text-xs font-bold text-amber-500 uppercase tracking-widest mb-2">AI Asked:</h4>
            <div className="bg-amber-50 border border-amber-100 p-5 rounded-xl shadow-sm">
              <p className="text-amber-800 font-medium text-[15px] leading-relaxed">
                {latestAiQuestion || `"${INITIAL_AI_QUESTION}"`}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* --- Profile Data Form --- */}
      <div className="bg-white border border-slate-200 p-6 rounded-2xl shadow-sm">
        <h2 className="text-xl font-bold text-slate-800 mb-6">User Details</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Name / Alias</label>
            <input type="text" value={learnerName} onChange={(e) => setLearnerName(e.target.value)} className="w-full bg-slate-50 border border-slate-200 p-3 rounded-xl outline-none focus:border-indigo-400 text-sm" placeholder="e.g. Alex" />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Target Age / Grade</label>
            <input type="text" value={targetAge} onChange={(e) => setTargetAge(e.target.value)} className="w-full bg-slate-50 border border-slate-200 p-3 rounded-xl outline-none focus:border-indigo-400 text-sm" placeholder="e.g. 8 years old" />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">What Background Should the Robot Know About the User and Their Capabilities?</label>
            <textarea value={cognitiveProfile} onChange={(e) => setCognitiveProfile(e.target.value)} className="w-full bg-slate-50 border border-slate-200 p-3 rounded-xl outline-none focus:border-indigo-400 text-sm min-h-[80px]" placeholder="e.g. Needs short sentences, beginner in learning a specific topic..." />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Special Interests</label>
            <textarea value={interests} onChange={(e) => setInterests(e.target.value)} className="w-full bg-slate-50 border border-slate-200 p-3 rounded-xl outline-none focus:border-indigo-400 text-sm min-h-[80px]" placeholder="e.g. Loves dinosaurs and space..." />
          </div>
        </div>
        
        <div className="mt-8 flex justify-end">
          <button
            onClick={saveProfile}
            disabled={isSaving}
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 px-8 rounded-xl shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? 'Saving...' : 'Save Profile & Continue →'}
          </button>
        </div>
      </div>
    </div>
  );
}