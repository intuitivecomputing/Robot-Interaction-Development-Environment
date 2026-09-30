import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import RecordingRing, { useRecordingCountdown, RECORDING_LIMIT_SECONDS } from '../components/RecordingRing';
import { finalizeRecordingBlob } from '../utils/audioRecording';

const THEME_CATEGORIES = {
  "General / Blank Canvas": [
    { 
      id: 'custom_topic', 
      label: '✨ Custom Topic', 
      role: 'You are a friendly and playful social robot interacting with a child. Your tone should always be fun, warm, and enthusiastic.', 
      task: 'Answer the child\'s questions about [INSERT YOUR TOPIC HERE] simply, then immediately invite them to dive deeper.', 
      context: 'Strictly 1 to 2 sentences only per turn. Always end your answer with a fun follow-up suggestion. If they want to move on, ask for a new question. Say a warm goodbye when they are done.' 
    }
  ],
  "Animals & Nature": [
    { 
      id: 'ocean_explorer', 
      label: '🌊 Ocean Creatures', 
      role: 'You are a friendly and playful social robot who is an expert on the ocean and marine biology.', 
      task: 'Answer the child\'s questions about sea creatures (like dolphins, sharks, or octopuses).', 
      context: 'Strictly 1 to 2 sentences only per turn. Share a cool, easy-to-understand animal fact, then always end with a fun follow-up suggestion to keep them engaged.' 
    },
    { 
      id: 'dino_guide', 
      label: '🦖 Dinosaurs', 
      role: 'You are a friendly and playful social robot who loves dinosaurs and ancient history.', 
      task: 'Answer the child\'s questions about different dinosaurs, what they ate, and how big they were.', 
      context: 'Strictly 1 to 2 sentences only per turn. Give a fun, simple answer, then suggest another cool dinosaur fact to explore. Ask for a new question if they want to move on.' 
    }
  ],
  "Space & Science": [
    { 
      id: 'space_friend', 
      label: '🚀 The Solar System', 
      role: 'You are a friendly and playful social robot who loves exploring outer space.', 
      task: 'Answer the child\'s questions about planets, stars, the moon, and astronauts.', 
      context: 'Strictly 1 to 2 sentences only per turn. Share a fascinating space fact and always end with an enthusiastic follow-up suggestion to keep their curiosity going.' 
    },
    { 
      id: 'weather_bot', 
      label: '⛈️ Weather & Earth', 
      role: 'You are a friendly and playful social robot who knows all about how the earth works.', 
      task: 'Answer the child\'s questions about thunderstorms, rainbows, snow, and volcanoes.', 
      context: 'Strictly 1 to 2 sentences only per turn. Make the science sound fun and exciting, ending with a question about what wild weather they want to learn about next.' 
    }
  ],
  "History & Culture": [
    { 
      id: 'history_guide', 
      label: '🏰 Ancient Times', 
      role: 'You are a friendly and playful social robot who has traveled through time.', 
      task: 'Answer the child\'s questions about ancient castles, pyramids, and how people lived a long time ago.', 
      context: 'Strictly 1 to 2 sentences only per turn. Paint a fun picture of the past and always end by asking if they want to hear another cool history secret.' 
    },
    { 
      id: 'invention_friend', 
      label: '💡 Cool Inventions', 
      role: 'You are a friendly and playful social robot who loves figuring out how things were made.', 
      task: 'Answer the child\'s questions about who invented everyday things like airplanes, lightbulbs, or video games.', 
      context: 'Strictly 1 to 2 sentences only per turn. Explain things simply, praise their great questions, and suggest another fun invention to talk about.' 
    }
  ],
  "Social & Emotional Skills": [
    { 
      id: 'friendship_buddy', 
      label: '🤝 Being a Good Friend', 
      role: 'You are a friendly and playful social robot who is an expert on kindness and making friends.', 
      task: 'Answer the child\'s questions about sharing toys, including others in games, and how to be a great teammate.', 
      context: 'Strictly 1 to 2 sentences only per turn. Give a warm, supportive answer that encourages kindness, then suggest a fun way they can practice being a good friend today.' 
    },
    { 
      id: 'feeling_explorer', 
      label: '🌈 Understanding Feelings', 
      role: 'You are a friendly and playful social robot who loves exploring how we feel on the inside.', 
      task: 'Answer the child\'s questions about why we get frustrated, how to name big feelings, and what to do when we are sad or excited.', 
      context: 'Strictly 1 to 2 sentences only per turn. Validate their feelings with empathy, then ask them if they want to talk about a time they felt a specific way or if they have another question.' 
    },
    { 
      id: 'growth_mindset', 
      label: '🌱 Trying New Things', 
      role: 'You are a friendly and playful social robot who believes that everyone can learn anything with practice.', 
      task: 'Answer the child\'s questions about what to do when something is too hard or how to keep going when they make a mistake.', 
      context: 'Strictly 1 to 2 sentences only per turn. Keep the tone super enthusiastic about the power of "not yet," and always suggest one tiny, fun step they can take to try their task again.' 
    }
  ]
};

export default function Content() {
  const navigate = useNavigate();
  const location = useLocation();
  const { initialPrompt, initialFlowchart, previousHistory } = location.state || {};

  // --- Voice & History State ---
  const [chatHistory, setChatHistory] = useState<any[]>(previousHistory || []);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const [, setLatestTranscript] = useState("");
  const [latestAiQuestion, setLatestAiQuestion] = useState("");
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef<number>(0);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Hidden Originals — frozen at mount, never reassigned, so no need for useState
  const baseMechanics = initialPrompt || "";
  const baseFlowchart = initialFlowchart || null;

  // Active Displays
  const [activeMechanics, setActiveMechanics] = useState(initialPrompt || "");
  const [activeFlowchart, setActiveFlowchart] = useState(initialFlowchart || null);

  // Core Form Inputs
  const [robotRole, setRobotRole] = useState("");
  const [activityTask, setActivityTask] = useState("");
  const [contextRules, setContextRules] = useState("");
  const DEFAULT_CATEGORY = Object.keys(THEME_CATEGORIES)[0] as keyof typeof THEME_CATEGORIES;
  const [activeCategory, setActiveCategory] = useState<keyof typeof THEME_CATEGORIES>(DEFAULT_CATEGORY);

  const [isApplying, setIsApplying] = useState(false);

  // Saved Contexts Library State
  const currentUser = localStorage.getItem("currentUser") || "user1";
  const activeRobot = localStorage.getItem("activeRobot") || "whiteBot";
  const activeLearner = JSON.parse(localStorage.getItem("activeLearner") || '{}');
  const profileId = activeLearner.id || "unknown";

  const [view, setView] = useState<'select' | 'create'>('select');
  const [savedContexts, setSavedContexts] = useState<any[]>([]);
  const [selectedContext, setSelectedContext] = useState<any | null>(null);
  const [isLoadingContexts, setIsLoadingContexts] = useState(true);

  // AI Suggestions State
  const [suggestedContexts, setSuggestedContexts] = useState<any[]>([]);
  const [isLoadingContextSuggestions, setIsLoadingContextSuggestions] = useState(true);

  const [showSaveContextModal, setShowSaveContextModal] = useState(false);
  const [contextName, setContextName] = useState('');
  const [contextDescription, setContextDescription] = useState('');
  const [isSavingContext, setIsSavingContext] = useState(false);

  // Context Card Menu / Edit State
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [editingContext, setEditingContext] = useState<any | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editRobotRole, setEditRobotRole] = useState('');
  const [editActivityTask, setEditActivityTask] = useState('');
  const [editContextRules, setEditContextRules] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Guard: this page expects a flowchart passed via navigation state from Design's template gallery.
  useEffect(() => {
    if (!activeFlowchart || !activeFlowchart.nodes) {
      navigate('/design', { replace: true });
    }
  }, [activeFlowchart, navigate]);

  useEffect(() => {
    if (view !== 'select') return;

    const fetchContexts = async () => {
      setIsLoadingContexts(true);
      try {
        const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
        const response = await fetch(`${apiBase}/api/contexts/${activeRobot}/${currentUser}/${profileId}`);
        if (!response.ok) throw new Error("Failed to fetch contexts");

        const data = await response.json();
        setSavedContexts(data.contexts || []);
      } catch (error) {
        console.error("Error fetching contexts from Firebase:", error);
      } finally {
        setIsLoadingContexts(false);
      }
    };

    fetchContexts();
  }, [view, activeRobot, currentUser, profileId]);

  useEffect(() => {
    if (view !== 'select' || profileId === 'unknown') return;

    const fetchSuggestions = async () => {
      setIsLoadingContextSuggestions(true);
      try {
        const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
        const response = await fetch(`${apiBase}/api/engine/suggest-contexts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ machine_name: activeRobot, user_id: currentUser, profile_id: profileId, count: 3 })
        });
        if (!response.ok) throw new Error("Failed to fetch AI suggestions");

        const data = await response.json();
        setSuggestedContexts(data.suggestions || []);
      } catch (error) {
        console.error("Error fetching AI context suggestions:", error);
        setSuggestedContexts([]);
      } finally {
        setIsLoadingContextSuggestions(false);
      }
    };

    fetchSuggestions();
  }, [view, activeRobot, currentUser, profileId]);

  const handleContinueWithContext = () => {
    if (!selectedContext) return;
    setRobotRole(selectedContext.robotRole || "");
    setActivityTask(selectedContext.activityTask || "");
    setContextRules(selectedContext.contextRules || "");
    setView('create');
  };

  const handleUseSuggestedContext = (suggestion: any) => {
    setRobotRole(suggestion.robotRole || "");
    setActivityTask(suggestion.activityTask || "");
    setContextRules(suggestion.contextRules || "");
    setView('create');
  };

  const handleDeleteContext = async (idToDelete: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenuId(null);
    if (!window.confirm("Are you sure you want to delete this saved context?")) return;

    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/contexts/${activeRobot}/${currentUser}/${profileId}/${idToDelete}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete context");

      setSavedContexts((prev) => prev.filter((c) => c.id !== idToDelete));
      setSelectedContext((prev: any) => (prev?.id === idToDelete ? null : prev));
    } catch (error) {
      console.error("Error deleting context:", error);
      alert("Could not delete context. Please try again.");
    }
  };

  const openEditContextModal = (context: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenuId(null);
    setEditingContext(context);
    setEditTitle(context.title || '');
    setEditDescription(context.description || '');
    setEditRobotRole(context.robotRole || '');
    setEditActivityTask(context.activityTask || '');
    setEditContextRules(context.contextRules || '');
  };

  const handleSaveContextEdit = async () => {
    if (!editingContext) return;
    if (!editTitle.trim()) return alert("Please provide a context name!");

    setIsSavingEdit(true);
    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/contexts/${activeRobot}/${currentUser}/${profileId}/${editingContext.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle,
          description: editDescription,
          robotRole: editRobotRole,
          activityTask: editActivityTask,
          contextRules: editContextRules
        })
      });

      if (!response.ok) throw new Error("Failed to save changes");

      const updated = { ...editingContext, title: editTitle, description: editDescription, robotRole: editRobotRole, activityTask: editActivityTask, contextRules: editContextRules };
      setSavedContexts((prev) => prev.map((c) => (c.id === editingContext.id ? updated : c)));
      setSelectedContext((prev: any) => (prev?.id === editingContext.id ? updated : prev));
      setEditingContext(null);
    } catch (error) {
      console.error("Error updating context:", error);
      alert("Could not save changes. Please try again.");
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleClearAllContexts = async () => {
    if (!window.confirm("Are you sure you want to delete all saved contexts? This cannot be undone.")) return;

    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/contexts/${activeRobot}/${currentUser}/${profileId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to clear contexts");

      setSavedContexts([]);
      setSelectedContext(null);
    } catch (error) {
      console.error("Error clearing contexts:", error);
      alert("Could not clear contexts. Please try again.");
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  // --- NEW: Voice Recording Logic ---
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
      
      // Grab only the last 10 turns for context memory
      const recentHistory = chatHistory.slice(-20);
      formData.append("conversation_history", JSON.stringify(recentHistory));
      
      // Pass the current text in the fields so the AI knows what has been manually typed
      formData.append("current_role", robotRole);
      formData.append("current_task", activityTask);
      formData.append("current_rules", contextRules);

      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/engine/content-voice-loop`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Failed to process voice request.");
      
      const data = await response.json();
      console.log(`[RECORDING DEBUG] Transcript: "${data.transcript}"`);

      // Autofill the specific fields from the AI's JSON response
      if (data.robotRole) setRobotRole(data.robotRole);
      if (data.activityTask) setActivityTask(data.activityTask);
      if (data.contextRules) setContextRules(data.contextRules);
      
      // Update local history array
      if (data.history) setChatHistory(data.history);
      if (data.transcript) setLatestTranscript(data.transcript);
      if (data.question) setLatestAiQuestion(data.question);

      // Play the AI's audio response
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
      console.error("Content Voice Loop Error:", error);
      alert("Voice processing failed. Check console.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleNodeContextChange = (nodeId: string, newContext: string) => {
    setActiveFlowchart((prev: any) => ({
      ...prev,
      nodes: prev.nodes.map((n: any) => 
        n.id.toString() === nodeId.toString() ? { ...n, detailedPrompt: newContext } : n
      )
    }));
  };

  const selectThemeTemplate = (theme: any) => {
    setRobotRole(theme.role);
    setActivityTask(theme.task);
    setContextRules(theme.context);
  };

  const generateFinalActivity = async () => {
    if (!robotRole && !activityTask) return alert("Please add some context first!");

    const learnerContext = `
      TARGET LEARNER AGE/GRADE: ${activeLearner.targetAge || 'Not specified'}
      COGNITIVE/SKILL PROFILE: ${activeLearner.cognitiveProfile || 'Not specified'}
    `;

    const combinedThemeContext = `ROLE: ${robotRole}\nTASK: ${activityTask}\nRULES & CONTEXT: ${contextRules}\n\n--- LEARNER PROFILE ---\n${learnerContext}`;
    
    setIsApplying(true);

    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/apply-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flowchart: baseFlowchart, 
          baseGlobalPrompt: baseMechanics, 
          themeContext: combinedThemeContext
        })
      });

      if (!response.ok) throw new Error("Backend merge failed");

      const data = await response.json();
      setActiveFlowchart(data.mergedFlowchart);
      setActiveMechanics(data.mergedGlobalPrompt); 
      
    } catch (error) {
      console.error("Failed to apply theme", error);
      alert("Could not connect to the backend to merge context.");
    } finally {
      setIsApplying(false);
    }
  };

  // No flowchart loaded yet (e.g. direct navigation to /content) — the guard above redirects to /design.
  if (!activeFlowchart || !activeFlowchart.nodes) {
    return null;
  }

  // ==========================================
  // VIEW 1: SAVED CONTEXTS LIBRARY
  // ==========================================
  if (view === 'select') {
    return (
      <div className="max-w-5xl mx-auto px-4 py-12">
        <div className="flex justify-between items-end mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 mb-2">What Are Some Details That Should Go Into the Activity?</h1>
            <p className="text-slate-500">Reuse a saved persona & ruleset, or build a new one from scratch.</p>
          </div>
          <div className="flex items-center gap-4">
            {savedContexts.length > 0 && (
              <button onClick={handleClearAllContexts} className="text-xs font-semibold text-red-500 hover:underline">
                Clear All
              </button>
            )}
            <button onClick={() => navigate('/design')} className="text-sm font-semibold text-slate-400 hover:text-blue-600 transition-colors">
              ← Back to Activity Structures
            </button>
          </div>
        </div>

        {/* AI Suggestions Panel */}
        {(isLoadingContextSuggestions || suggestedContexts.length > 0) && (
          <div className="mb-10 bg-violet-50 border-2 border-violet-100 rounded-2xl p-6">
            <h2 className="font-bold text-violet-900 mb-4">
              ✨ Suggested for {activeLearner.name || 'this learner'}
            </h2>
            {isLoadingContextSuggestions ? (
              <p className="text-violet-400 font-medium animate-pulse text-sm">Generating suggestions...</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {suggestedContexts.map((suggestion, index) => (
                  <div key={index} className="bg-white p-5 rounded-xl border-2 border-violet-200 shadow-sm flex flex-col">
                    <div className="text-3xl mb-2">🎭</div>
                    <h3 className="font-bold text-slate-800">{suggestion.title || 'Suggested Context'}</h3>
                    <p className="text-sm text-slate-500 mt-1 mb-4 flex-1 line-clamp-3">
                      {suggestion.description || ''}
                    </p>
                    <button
                      onClick={() => handleUseSuggestedContext(suggestion)}
                      className="w-full bg-violet-600 hover:bg-violet-700 text-white font-semibold text-sm py-2 rounded-lg transition-colors"
                    >
                      Use This
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {isLoadingContexts ? (
          <div className="flex justify-center items-center min-h-[200px]">
            <p className="text-slate-400 font-medium animate-pulse">Loading contexts from cloud...</p>
          </div>
        ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* The "+" Card */}
          <div
            onClick={() => setView('create')}
            className="bg-blue-50 border-2 border-dashed border-blue-200 hover:border-blue-400 hover:bg-blue-100 p-6 rounded-2xl flex flex-col items-center justify-center text-center cursor-pointer transition-all min-h-[200px] group"
          >
            <div className="w-12 h-12 bg-blue-200 text-blue-700 rounded-full flex items-center justify-center text-2xl font-bold mb-4 group-hover:scale-110 transition-transform">
              +
            </div>
            <h3 className="font-bold text-blue-900">New Topic</h3>
            <p className="text-xs text-blue-600 mt-1">Define a fresh persona & ruleset</p>
          </div>

          {/* Existing Context Cards */}
          {savedContexts.map((context) => {
            const isSelected = selectedContext?.id === context.id;

            return (
              <div
                key={context.id}
                onClick={() => setSelectedContext(context)}
                className={`bg-white p-6 rounded-2xl cursor-pointer transition-all min-h-[200px] flex flex-col border-2 relative ${
                  isSelected
                    ? 'border-blue-600 shadow-md ring-4 ring-blue-50'
                    : 'border-slate-200 shadow-sm hover:shadow-md hover:border-blue-300'
                }`}
              >
                {/* --- CARD MENU --- */}
                <div className="absolute top-4 right-4 z-10" ref={openMenuId === context.id ? menuRef : null}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(openMenuId === context.id ? null : context.id);
                    }}
                    className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors font-bold text-lg leading-none"
                  >
                    ⋮
                  </button>

                  {openMenuId === context.id && (
                    <div className="absolute right-0 mt-1 w-36 bg-white border border-slate-200 rounded-xl shadow-lg py-1.5 z-20 flex flex-col">
                      <button
                        onClick={(e) => openEditContextModal(context, e)}
                        className="w-full text-left px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        Edit Details
                      </button>
                      <button
                        onClick={(e) => handleDeleteContext(context.id, e)}
                        className="w-full text-left px-4 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 transition-colors"
                      >
                        Delete Context
                      </button>
                    </div>
                  )}
                </div>
                {/* ------------------------- */}

                <div className="flex justify-between items-start mb-4">
                  <div className="text-4xl">🎭</div>
                  {isSelected && (
                    <div className="absolute top-14 right-4 bg-blue-600 text-white rounded-full p-1">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    </div>
                  )}
                </div>
                <h3 className="font-bold text-xl text-slate-800 pr-8">{context.title || "Untitled Context"}</h3>
                <p className="text-sm text-slate-500 mt-1 mb-4 flex-1 line-clamp-3">
                  {context.description || context.activityTask || 'No description provided.'}
                </p>
              </div>
            );
          })}
        </div>
        )}

        {/* The Continue Button */}
        <div className="mt-12 flex justify-end border-t border-slate-200 pt-6">
          <button
            onClick={handleContinueWithContext}
            disabled={!selectedContext}
            className={`px-8 py-4 rounded-xl font-bold shadow-md transition-all text-lg ${
              selectedContext
                ? 'bg-blue-600 hover:bg-blue-700 text-white transform hover:-translate-y-1'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            Continue with Context →
          </button>
        </div>

        {/* Edit Context Modal */}
        {editingContext && (
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
              <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
                <h3 className="font-bold text-lg text-slate-800">Edit Context</h3>
                <button onClick={() => setEditingContext(null)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">×</button>
              </div>

              <div className="p-6 flex flex-col gap-4 overflow-y-auto scrollbar-thin">
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Context Name</label>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Short Description</label>
                  <textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all resize-none min-h-[60px]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">What Character Should the Robot Play?</label>
                  <textarea
                    value={editRobotRole}
                    onChange={(e) => setEditRobotRole(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all min-h-[60px]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">What Are the Main Goals for the Conversation?</label>
                  <textarea
                    value={editActivityTask}
                    onChange={(e) => setEditActivityTask(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all min-h-[60px]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Are There Any Specific Rules the Robot Should Keep In Mind?</label>
                  <textarea
                    value={editContextRules}
                    onChange={(e) => setEditContextRules(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all min-h-[60px]"
                  />
                </div>
              </div>

              <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3 shrink-0">
                <button
                  onClick={() => setEditingContext(null)}
                  className="px-4 py-2 rounded-lg font-semibold text-slate-600 hover:bg-slate-200 transition-colors"
                  disabled={isSavingEdit}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveContextEdit}
                  disabled={isSavingEdit}
                  className="px-6 py-2 rounded-lg font-bold text-white bg-blue-600 hover:bg-blue-700 shadow transition-all disabled:opacity-50"
                >
                  {isSavingEdit ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Context Editor
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 flex flex-col gap-6 relative">
      
      <div className="flex justify-between items-center mb-2">
        <button
          onClick={() => setView('select')}
          className="text-sm font-bold text-slate-400 hover:text-blue-600 transition-colors"
        >
          ← Back to Contexts
        </button>
        <span className="text-xs font-semibold bg-blue-100 text-blue-800 px-3 py-1 rounded-full">Phase 2: Context Injection</span>
      </div>

      {/* --- NEW: Voice AI Assistant Header --- */}
      <div className="bg-white border border-slate-200 p-8 rounded-2xl shadow-sm flex flex-col md:flex-row gap-8 items-stretch">
        
        {/* Left Column: The Big Button */}
        <div className="flex flex-col items-center justify-center min-w-[220px] border-b md:border-b-0 md:border-r border-slate-100 pb-8 md:pb-0 md:pr-8">
          <h3 className="text-xl font-extrabold text-slate-800 mb-8">Voice Agent</h3>
          <RecordingRing isRecording={isRecording} durationSeconds={RECORDING_LIMIT_SECONDS} size={144}>
            <button
              onClick={toggleRecording}
              disabled={isProcessing}
              className={`w-36 h-36 rounded-full flex items-center justify-center font-bold text-white shadow-lg transition-all transform hover:scale-105 active:scale-95 ${
                isRecording
                  ? 'bg-red-500 animate-pulse shadow-red-200'
                  : isProcessing
                  ? 'bg-slate-400 cursor-wait shadow-slate-200'
                  : 'bg-blue-700 hover:bg-blue-700 shadow-blue-200'
              }`}
            >
              <span className="text-xl tracking-widest uppercase">
                {isRecording ? 'STOP' : isProcessing ? 'WAIT' : 'RECORD'}
              </span>
            </button>
          </RecordingRing>
          <p className="mt-8 text-sm text-slate-500 font-medium">
            {isRecording ? 'Listening...' : isProcessing ? 'Processing...' : 'Reply when ready!'}
          </p>
        </div>

        {/* Right Column: The Conversation Log */}
        <div className="flex-1 flex flex-col gap-6 justify-center">
          {chatHistory.some(turn => turn.role === 'user') ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1 block">
                You said:
              </span>
              <div className="max-h-[120px] overflow-y-auto pr-2 flex flex-col gap-3 scrollbar-thin">
                {chatHistory
                  .filter((turn) => turn.role === 'user')
                  .map((turn, idx) => (
                    <p key={idx} className="text-[15px] text-slate-600 bg-slate-50 p-4 rounded-xl border border-slate-100 italic shrink-0 font-medium">
                      "{turn.content}"
                    </p>
                  ))}
                <div ref={chatEndRef} />
              </div>
            </div>
          ) : (
            <div>
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1 block">
                You said:
              </span>
              <div className="bg-slate-50 border border-slate-100 p-4 rounded-xl">
                <p className="text-slate-400 italic font-medium text-[15px]">
                  Waiting for your voice input...
                </p>
              </div>
            </div>
          )}
          
          <div>
            <h4 className="text-xs font-bold text-amber-500 uppercase tracking-widest mb-2">AI Asked:</h4>
            <div className="bg-amber-50 border border-amber-100 p-5 rounded-xl shadow-sm">
              <p className="text-amber-800 font-medium text-[15px] leading-relaxed">
                {latestAiQuestion 
                  ? `"${latestAiQuestion}"` 
                  : `"Tell me how this robot should behave, and I'll fill out the fields below for you!"`}
              </p>
            </div>
          </div>
        </div>
      </div>
      
      <section className="bg-white border border-slate-200 p-6 rounded-2xl shadow-sm flex flex-col gap-8">
        <div>
          <h2 className="text-xl font-bold text-slate-800 mb-1">Step 1: Add Context & Rules</h2>
          <p className="text-sm text-slate-500">Define the flavor, persona, and setup specifics to bring your robot to life.</p>
        </div>

        <div className="flex flex-col gap-4 bg-slate-50 p-5 rounded-xl border border-slate-100">
          <h3 className="text-sm font-bold text-blue-800 border-b border-blue-100 pb-2 mb-2">A. Who Is It For And What Will They Be Doing?</h3>
          
          <div className="bg-blue-50 border border-blue-100 p-4 rounded-xl flex flex-col gap-4 mb-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-blue-900 uppercase tracking-wider">Quick Templates</span>
              <select 
                value={activeCategory} 
                onChange={(e) => setActiveCategory(e.target.value as keyof typeof THEME_CATEGORIES)}
                className="bg-white border border-blue-200 text-blue-800 text-xs rounded outline-none font-semibold shadow-sm p-1"
              >
                {Object.keys(THEME_CATEGORIES).map(category => <option key={category} value={category}>{category}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              {(THEME_CATEGORIES[activeCategory] || []).map((theme) => (
                <button 
                  key={theme.id}
                  onClick={() => selectThemeTemplate(theme)}
                  className="bg-white hover:bg-blue-600 hover:text-white border border-blue-200 text-blue-700 px-3 py-1 rounded text-xs font-semibold transition-colors shadow-sm"
                >
                  {theme.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">What Character Should the Robot Play?</label>
            <textarea value={robotRole} onChange={(e) => setRobotRole(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-400 p-3 rounded-lg text-sm min-h-[60px] outline-none" placeholder="e.g. You are a friendly and playful social robot interacting with a child." />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">What Are the Main Goals for the Conversation?</label>
            <textarea value={activityTask} onChange={(e) => setActivityTask(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-400 p-3 rounded-lg text-sm min-h-[60px] outline-none" placeholder="e.g. Answer the child\'s questions about [INSERT YOUR TOPIC HERE] simply, then immediately invite them to dive deeper." />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Are There Any Specific Rules the Robot Should Keep In Mind?</label>
            <textarea value={contextRules} onChange={(e) => setContextRules(e.target.value)} className="w-full bg-white border border-slate-200 focus:border-indigo-400 p-3 rounded-lg text-sm min-h-[60px] outline-none" placeholder="e.g. Strictly 1 to 2 sentences only per turn. Always end your answer with a fun follow-up suggestion." />
          </div>
        </div>

        <div className="flex flex-col gap-2 bg-slate-50 p-5 rounded-xl border border-slate-100">
          <h3 className="text-sm font-bold text-blue-800 border-b border-blue-100 pb-2 mb-2">B. Who Is This For?</h3>
          <p className="text-sm text-slate-600">
            Pulled automatically from the active learner profile — edit it on the Profiles page if it needs updating.
          </p>
          <div className="flex flex-wrap gap-2 mt-1">
            <span className="text-xs font-semibold bg-blue-50 text-blue-700 px-3 py-1 rounded-full">
              {activeLearner.name || 'Unnamed learner'}
            </span>
            <span className="text-xs font-semibold bg-blue-50 text-blue-700 px-3 py-1 rounded-full">
              Age: {activeLearner.targetAge || 'Not specified'}
            </span>
            {activeLearner.cognitiveProfile && (
              <span className="text-xs font-semibold bg-blue-50 text-blue-700 px-3 py-1 rounded-full">
                {activeLearner.cognitiveProfile}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 mt-2">
          <button
            onClick={generateFinalActivity}
            disabled={isApplying}
            className={`flex-1 bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-4 rounded-xl font-bold shadow-md transition-all text-lg ${isApplying ? 'opacity-50 cursor-wait' : ''}`}
          >
            {isApplying ? 'Synthesizing with AI...' : '✨ Merge Context into Activity Mechanics'}
          </button>
          <button
            onClick={() => setShowSaveContextModal(true)}
            disabled={!robotRole && !activityTask}
            className="px-6 py-4 rounded-xl font-bold shadow-md transition-all text-lg bg-white border-2 border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            💾 Save Context
          </button>
        </div>
      </section>

      <section className="bg-blue-50 border-2 border-blue-200 p-6 rounded-2xl shadow-sm mt-2">
        <h2 className="text-lg font-bold text-blue-900 mb-2">Step 2: Review & Edit Mechanics</h2>
        <p className="text-sm text-blue-700 mb-6">This shows your current system prompts. Clicking "Merge" above will dynamically rewrite these with your new context.</p>
        
        <div className="mb-8">
          <label className="block text-xs font-bold text-blue-800 uppercase tracking-wider mb-2">Global System Prompt</label>
          <textarea 
            id="activeMechanicsInput"
            name="activeMechanics"
            value={activeMechanics} 
            onChange={(e) => setActiveMechanics(e.target.value)} 
            className="w-full bg-white border border-blue-200 p-4 rounded-xl text-sm text-slate-700 min-h-[160px] outline-none font-mono" 
          />
        </div>

        <div>
          <label className="block text-xs font-bold text-blue-800 uppercase tracking-wider mb-2">State-Specific Instructions</label>
          <div className="flex flex-col gap-4">
            {activeFlowchart.nodes.map((node: any) => (
              <div key={node.id} className="border border-slate-200 rounded-xl overflow-hidden shadow-sm bg-white">
                <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 font-semibold text-sm text-slate-700 flex justify-between">
                  <span>{node.data?.label || node.label}</span>
                  <span className="text-xs font-normal text-slate-400">Node ID: {node.id}</span>
                </div>
                <textarea 
                  id={`node-prompt-${node.id}`}
                  name={`node-prompt-${node.id}`}
                  value={node.detailedPrompt || ""}
                  onChange={(e) => handleNodeContextChange(node.id, e.target.value)}
                  className="w-full p-4 text-sm text-slate-600 min-h-[100px] outline-none resize-y font-mono"
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      <button
        onClick={() => navigate('/testing', { state: { finalPrompt: activeMechanics, finalFlowchart: activeFlowchart } })}
        className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-4 rounded-xl font-bold shadow-md transition-all mb-8"
      >
        Lock Build & Preview Interaction →
      </button>

      {/* Save Context Modal */}
      {showSaveContextModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="font-bold text-lg text-slate-800">Save Context Preset</h3>
              <button onClick={() => setShowSaveContextModal(false)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">×</button>
            </div>

            <div className="p-6 flex flex-col gap-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Context Name</label>
                <input
                  type="text"
                  value={contextName}
                  onChange={(e) => setContextName(e.target.value)}
                  placeholder="e.g., Friendly Space Tutor"
                  className="w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Short Description (Optional)</label>
                <textarea
                  value={contextDescription}
                  onChange={(e) => setContextDescription(e.target.value)}
                  placeholder="What is this persona designed for?"
                  className="w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all resize-none min-h-[80px]"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setShowSaveContextModal(false)}
                className="px-4 py-2 rounded-lg font-semibold text-slate-600 hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={isSavingContext}
                onClick={async () => {
                  setIsSavingContext(true);
                  try {
                    const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
                    const response = await fetch(`${apiBase}/api/contexts`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        machine_name: activeRobot,
                        user_id: currentUser,
                        profile_id: profileId,
                        title: contextName.trim() || 'Custom Context',
                        description: contextDescription.trim(),
                        robotRole,
                        activityTask,
                        contextRules
                      })
                    });

                    if (!response.ok) throw new Error("Failed to save context");

                    const savedContext = await response.json();

                    setShowSaveContextModal(false);
                    setContextName('');
                    setContextDescription('');
                    setSelectedContext(savedContext);
                    setView('select');
                  } catch (error) {
                    console.error("Error saving context:", error);
                    alert("Could not save context. Please try again.");
                  } finally {
                    setIsSavingContext(false);
                  }
                }}
                className="px-6 py-2 rounded-lg font-bold text-white bg-blue-600 hover:bg-blue-700 shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSavingContext ? 'Saving...' : 'Save Context'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}