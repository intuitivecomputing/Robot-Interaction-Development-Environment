import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import InteractionFlowchart from './Flowchart';
import RecordingRing, { useRecordingCountdown, RECORDING_LIMIT_SECONDS } from '../components/RecordingRing';
import { finalizeRecordingBlob } from '../utils/audioRecording';

// Design formats (Discussion/Roleplay/Q&A/Educational Game) were removed — every
// activity is now built through the single, more versatile Custom flow. Kept as
// single-key Records rather than flattened to plain constants so every existing
// lookup site (FLOWCHART_TEMPLATES[activityMode] || FLOWCHART_TEMPLATES['Custom'])
// still resolves correctly without touching each call site.
const MODE_SUGGESTIONS: Record<string, string> = {
  'Custom': 'Press record and describe your scenario to start creating the activity. Please keep it short and simple — the app will help you refine it from there. Ex: "I want to create an activity where..."'
};

const FLOWCHART_TEMPLATES: Record<string, any> = {
  'Custom': { nodes: [{ id: '1', label: 'Start State', detailedPrompt: 'Your custom starting point...' }], edges: [] }
};

type TweakState = { tweakPrompt?: string; tweakFlowchart?: any; tweakTitle?: string; tweakDescription?: string; tweakConversationHistory?: any[] };

// A refresh (or any unexpected interruption) shouldn't lose an in-progress draft —
// only an intentional exit (Back button, successful save) clears these sessionStorage
// keys, so anything still present here means real work survived the interruption.
function getPersistedDraft(): any | null {
  try {
    if (!sessionStorage.getItem('draftId_design')) return null;
    const raw = sessionStorage.getItem('draftContent_design');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function Design() {
  const navigate = useNavigate();
  const location = useLocation();

  // TEMPORARY: "Needs Tweaking" hands the activity back here via location.state
  // while /content is bypassed. Read into useState initializers (not an
  // effect) to avoid a race with the "Initialize Template" effect below.
  const initialTweak = (location.state || {}) as TweakState;
  const hasTweak = Boolean(initialTweak.tweakPrompt || initialTweak.tweakFlowchart);
  const tweakSeedQuestion = 'Want to make any changes, or does it work as-is?';

  // A fresh tweak-navigation always wins over a stale leftover draft (getPersistedDraft
  // is skipped entirely when hasTweak is true) — computed once via the lazy useState
  // form so sessionStorage is only read at mount, not on every re-render.
  const [restoredDraft] = useState<any | null>(() => (!hasTweak ? getPersistedDraft() : null));

  // Template Gallery State
  const [view, setView] = useState<'select' | 'create'>(hasTweak || restoredDraft ? 'create' : 'select');
  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<any | null>(null);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(true);
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);

  // AI Suggestions State
  const [suggestedTemplates, setSuggestedTemplates] = useState<any[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(true);
  const [isRegeneratingSuggestions, setIsRegeneratingSuggestions] = useState(false);

  const currentUser = localStorage.getItem("currentUser") || "user1";
  const activeRobot = localStorage.getItem("activeRobot") || "whiteBot";
  const activeLearner = JSON.parse(localStorage.getItem("activeLearner") || '{}');
  const profileId = activeLearner.id || "unknown";

  // "Untitled" cards for drafts abandoned via the Back button this login session —
  // never saved to Firebase, just a visual receipt so accidental navigation doesn't
  // silently swallow real progress. Scoped per learner profile (not just per login)
  // so switching profiles doesn't leak one learner's draft into another's gallery.
  // Cleared on a fresh login (see Login.tsx).
  const abandonedDraftsKey = `abandonedDrafts_design_${profileId}`;
  const [abandonedDrafts, setAbandonedDrafts] = useState<any[]>(() => {
    try {
      const raw = sessionStorage.getItem(abandonedDraftsKey);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const persistAbandonedDrafts = (drafts: any[]) => {
    setAbandonedDrafts(drafts);
    sessionStorage.setItem(abandonedDraftsKey, JSON.stringify(drafts));
  };

  // Template Card Menu / Edit State
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Set while editing an existing saved template via voice — when set, the
  // Save Template modal overwrites this template in place (PUT) instead of
  // creating a new one (POST). Cleared by seedCreateView for any other
  // entry point (suggestions, duplicate, tweak-from-testing, "+ New Flow").
  const [editingTemplate, setEditingTemplate] = useState<any | null>(restoredDraft?.editingTemplate ?? null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Phase 2 timing + a per-session draft id (for the abandoned-draft log) —
  // most create-view entries are in-place setView calls, not remounts, so
  // this has to key off `view` rather than run once on mount.
  useEffect(() => {
    if (view === 'create') {
      if (!sessionStorage.getItem('phaseStart_design')) {
        sessionStorage.setItem('phaseStart_design', new Date().toISOString());
      }
      if (!sessionStorage.getItem('draftId_design')) {
        sessionStorage.setItem('draftId_design', crypto.randomUUID());
      }
    }
  }, [view]);

  useEffect(() => {
    if (view !== 'select') return;

    const fetchTemplates = async () => {
      setIsLoadingTemplates(true);
      try {
        const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
        const response = await fetch(`${apiBase}/api/templates/${activeRobot}/${currentUser}/${profileId}`);
        if (!response.ok) throw new Error("Failed to fetch templates");

        const data = await response.json();
        setTemplates(data.templates || []);
      } catch (error) {
        console.error("Error fetching templates from Firebase:", error);
      } finally {
        setIsLoadingTemplates(false);
      }
    };

    fetchTemplates();
  }, [view, activeRobot, currentUser, profileId]);

  // force=true is the "Generate More" button — the backend caches suggestions
  // against the profile and only re-hits the gateway when forced or when the
  // profile has actually changed since the cached batch was generated.
  const fetchSuggestions = async (force: boolean = false) => {
    if (force) {
      setIsRegeneratingSuggestions(true);
    } else {
      setIsLoadingSuggestions(true);
    }
    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/engine/suggest-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machine_name: activeRobot, user_id: currentUser, profile_id: profileId, count: 3, force })
      });
      if (!response.ok) throw new Error("Failed to fetch AI suggestions");

      const data = await response.json();
      setSuggestedTemplates(data.suggestions || []);
    } catch (error) {
      console.error("Error fetching AI template suggestions:", error);
      if (!force) setSuggestedTemplates([]);
    } finally {
      setIsLoadingSuggestions(false);
      setIsRegeneratingSuggestions(false);
    }
  };

  useEffect(() => {
    if (view !== 'select' || profileId === 'unknown') return;
    fetchSuggestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, activeRobot, currentUser, profileId]);

  // Seeds the voice-builder from a suggestion/duplicate/tweak. Needs a synthetic
  // assistant turn in conversationHistory, since that's voice-loop's only channel
  // for prior context — an empty history would look like a brand-new conversation.
  const seedCreateView = (
    prompt: string,
    flowchart: any,
    title: string,
    description: string,
    seedUserNote: string,
    seedQuestion: string,
    existingHistory?: any[],
    existingReferenceDocument?: string
  ) => {
    // Fresh, explicit entry — don't let a stale sessionStorage draft (or leftover
    // React state from a previous unsaved session) bleed into this one.
    sessionStorage.setItem('draftId_design', crypto.randomUUID());
    sessionStorage.setItem('phaseStart_design', new Date().toISOString());
    sessionStorage.removeItem('draftContent_design');
    setCurrentPrompt(prompt || '');
    setFlowchartData(flowchart || FLOWCHART_TEMPLATES['Custom']);
    setEditedNodeIds(new Set());
    setTemplateName(title || '');
    setTemplateDescription(description || '');
    setManualEdits([]);
    setFlowchartViews([]);
    setTurnTimings([]);
    setReferenceDocument(existingReferenceDocument || '');
    setReferenceFileNames([]);
    // Resume the real conversation if available, else fall back to a synthetic placeholder.
    setConversationHistory(
      Array.isArray(existingHistory) && existingHistory.length > 0
        ? existingHistory
        : [
            { role: 'user', content: seedUserNote },
            { role: 'assistant', content: JSON.stringify({ prompt: prompt || '', question: seedQuestion }) }
          ]
    );
    setLastQuestion(seedQuestion);
    // Overridden right after by handleEditTemplate for the in-place edit case.
    setEditingTemplate(null);
    setView('create');
  };

  // Clears any leftover state from a previous unsaved session (e.g. an AI
  // suggestion or edit that was never saved) before starting a blank one.
  const handleStartNewActivity = () => {
    sessionStorage.setItem('draftId_design', crypto.randomUUID());
    sessionStorage.setItem('phaseStart_design', new Date().toISOString());
    sessionStorage.removeItem('draftContent_design');
    setCurrentPrompt('');
    setFlowchartData(FLOWCHART_TEMPLATES['Custom']);
    setEditedNodeIds(new Set());
    setTemplateName('');
    setTemplateDescription('');
    setConversationHistory([]);
    setLastQuestion('');
    setEditingTemplate(null);
    setActivityMode('Custom');
    setManualEdits([]);
    setFlowchartViews([]);
    setTurnTimings([]);
    setReferenceDocument('');
    setReferenceFileNames([]);
    setView('create');
  };

  // Picking up an abandoned draft removes it from the "Untitled" list — if it
  // gets abandoned again, a fresh entry is appended, it doesn't reuse this slot.
  const handleResumeAbandonedDraft = (draft: any) => {
    persistAbandonedDrafts(abandonedDrafts.filter((d) => d.id !== draft.id));
    seedCreateView(
      draft.systemPrompt,
      draft.data,
      draft.title,
      draft.description,
      'Continue this abandoned draft.',
      'Want to make any changes, or does it work as-is?',
      draft.conversationHistory,
      draft.referenceDocument
    );
    setActivityMode(draft.activityMode || 'Custom');
  };

  const handleDismissAbandonedDraft = (draftId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    persistAbandonedDrafts(abandonedDrafts.filter((d) => d.id !== draftId));
  };

  const handleFileUpload = async (files: File[]) => {
    if (files.length > MAX_UPLOAD_FILES) {
      alert(`Please select at most ${MAX_UPLOAD_FILES} files at once.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsAnalyzingUpload(true);
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append('files', file));
      formData.append('context_type', 'activity');

      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/engine/analyze-upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Failed to analyze the uploaded file(s).');
      }

      const data = await response.json();
      // Accumulates rather than replaces — lets a batch that's too large for one
      // request (the gateway caps combined request size) be uploaded in smaller
      // groups without losing what was already analyzed.
      const newText = data.referenceText || '';
      if (newText) {
        setReferenceDocument((prev) => (prev ? `${prev}\n\n${newText}` : newText));
      }
      setReferenceFileNames((prev) => [...prev, ...files.map((f) => f.name)]);
    } catch (error: any) {
      console.error('Error analyzing uploaded file(s):', error);
      alert(error.message || 'Could not process those files. Please try .pdf, .docx, .txt, or image files.');
    } finally {
      setIsAnalyzingUpload(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Suggests a title/description from the actual final system prompt — not from any
  // uploaded reference file, since the file may end up unused in the finished design.
  // Only fills fields that are still empty, and only fires once, right before the Save
  // modal opens, so the suggestion always reflects what was actually built.
  const handleOpenSaveModal = async () => {
    if (!templateName.trim() && !templateDescription.trim() && currentPrompt.trim() && !isSuggestingFields) {
      setIsSuggestingFields(true);
      try {
        const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
        // Never worth making the researcher wait on this — if it's not back within
        // 3s, give up and let them just type their own title/description.
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), 3000);
        try {
          const response = await fetch(`${apiBase}/api/engine/suggest-activity-fields`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_prompt: currentPrompt }),
            signal: timeoutController.signal
          });
          if (response.ok) {
            const data = await response.json();
            if (data.title) setTemplateName(data.title);
            if (data.description) setTemplateDescription(data.description);
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        console.error('Error suggesting activity fields (or timed out):', error);
      } finally {
        setIsSuggestingFields(false);
      }
    }
    setShowSaveModal(true);
  };

  // Manually saving the edited prompt regenerates the flowchart to match it (outright
  // replaced, not smart-merged) and lets the AI know about the edit so it doesn't repeat
  // a question the edit may have already answered — without resending conversation history.
  const handleSavePromptEdit = async () => {
    if (!currentPrompt.trim() || isRegeneratingFlowchart) return;

    setIsRegeneratingFlowchart(true);
    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/engine/regenerate-flowchart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt: currentPrompt })
      });

      if (!response.ok) throw new Error(`Backend error: ${response.status}`);

      const data = await response.json();
      const newFlowchartData = data.flowchart || data.flowchartData;
      if (newFlowchartData && Array.isArray(newFlowchartData.nodes)) {
        setFlowchartData(newFlowchartData);
      }
      setEditedNodeIds(new Set());

      // Let the AI know its own remembered draft is now stale, so it doesn't
      // re-ask something the manual edit may have just answered.
      setConversationHistory((prev) => {
        if (prev.length === 0) return prev;
        const updated = [...prev];
        const lastIndex = updated.length - 1;
        const lastMessage = updated[lastIndex];
        if (lastMessage.role !== 'assistant') return prev;
        try {
          const aiMemory = JSON.parse(lastMessage.content);
          aiMemory.prompt = currentPrompt;
          aiMemory.manualEditNote = "The prompt above was just manually edited by the user in the text box (not by voice). If this edit already answers your last question, do not ask it again — move on to the next relevant question.";
          updated[lastIndex] = { ...lastMessage, content: JSON.stringify(aiMemory) };
          return updated;
        } catch {
          return prev;
        }
      });
    } catch (error) {
      console.error('Error regenerating flowchart:', error);
      alert('Could not regenerate the flowchart from your edits. Please try again.');
    } finally {
      setIsRegeneratingFlowchart(false);
    }
  };

  // Logs an "abandoned" snapshot only if the draft actually has something in
  // it — an untouched create view (opened, never recorded/edited/viewed)
  // logs nothing at all.
  const handleBackToGallery = async () => {
    audioPlayerRef.current?.pause();

    const hasRealActivity = conversationHistory.some((turn) => turn.role === 'user')
      || manualEdits.length > 0
      || flowchartViews.length > 0
      || turnTimings.length > 0;

    if (view === 'create' && hasRealActivity) {
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
            log_type: 'activity',
            event: 'abandoned',
            entity_id: sessionStorage.getItem('draftId_design') || '',
            entity_title: templateName.trim() || 'Untitled Flow',
            final_data: { title: templateName, description: templateDescription, systemPrompt: currentPrompt, data: flowchartData },
            conversation_history: conversationHistory,
            phase_entered_at: sessionStorage.getItem('phaseStart_design') || '',
            phase_exited_at: new Date().toISOString(),
            manual_edits: manualEdits,
            flowchart_views: flowchartViews,
            activity_mode: activityMode,
            turn_timings: turnTimings,
            reference_document: referenceDocument
          })
        });
      } catch (logError) {
        console.error('Error writing abandoned-draft log:', logError);
      }

      persistAbandonedDrafts([
        ...abandonedDrafts,
        {
          id: sessionStorage.getItem('draftId_design') || crypto.randomUUID(),
          title: templateName,
          description: templateDescription,
          systemPrompt: currentPrompt,
          data: flowchartData,
          conversationHistory,
          activityMode,
          referenceDocument,
          abandonedAt: new Date().toISOString()
        }
      ]);
    }

    sessionStorage.removeItem('phaseStart_design');
    sessionStorage.removeItem('draftId_design');
    sessionStorage.removeItem('draftContent_design');
    setView('select');
    setShowFlowchartModal(false);
  };

  const handleUseSuggestion = (suggestion: any) => {
    seedCreateView(
      suggestion.systemPrompt,
      suggestion.data,
      suggestion.title,
      suggestion.description,
      'Use the AI-suggested activity as a starting point.',
      'Want to make any changes to this activity, or does it work as-is?'
    );
  };

  // Opens a copy of a saved template in the voice-builder view.
  const handleDuplicateTemplate = (template: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenuId(null);

    const originalPrompt = template.systemPrompt || template.globalPrompt || template.prompt || template.data?.systemPrompt || '';
    seedCreateView(
      originalPrompt,
      template.data,
      `Copy of ${template.title || 'Untitled Flow'}`,
      template.description,
      'Duplicate this saved activity as a starting point.',
      'Want to make any changes to this copy, or does it work as-is?',
      template.conversationHistory,
      template.referenceDocument
    );
  };

  const handleContinueToContent = () => {
    if (!selectedTemplate) return;
    const originalGlobalPrompt = selectedTemplate.systemPrompt || selectedTemplate.globalPrompt || selectedTemplate.prompt || selectedTemplate.data?.systemPrompt || "";

    // TEMPORARY: bypass /content, go straight to /testing. To revert, delete the
    // navigate('/testing', ...) call below and uncomment this instead:
    //
    // navigate('/content', {
    //   state: {
    //     initialPrompt: originalGlobalPrompt,
    //     initialFlowchart: selectedTemplate.data,
    //     previousHistory: []
    //   }
    // });
    navigate('/testing', {
      state: {
        finalPrompt: originalGlobalPrompt,
        finalFlowchart: selectedTemplate.data,
        activityTitle: selectedTemplate.title,
        activityDescription: selectedTemplate.description,
        activityConversationHistory: selectedTemplate.conversationHistory
      }
    });
  };

  const handleDeleteTemplate = async (idToDelete: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenuId(null);
    if (!window.confirm("Are you sure you want to delete this template?")) return;

    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/templates/${activeRobot}/${currentUser}/${profileId}/${idToDelete}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete template");

      setTemplates((prev) => prev.filter((t) => t.id !== idToDelete));
      setSelectedTemplate((prev: any) => (prev?.id === idToDelete ? null : prev));
    } catch (error) {
      console.error("Error deleting template:", error);
      alert("Could not delete template. Please try again.");
    }
  };

  // Opens an existing saved template in the voice-builder view for editing.
  // Saving from here overwrites this template in place — see editingTemplate.
  const handleEditTemplate = (template: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenuId(null);

    const originalPrompt = template.systemPrompt || template.globalPrompt || template.prompt || template.data?.systemPrompt || '';
    seedCreateView(
      originalPrompt,
      template.data,
      template.title || '',
      template.description || '',
      'Edit this saved activity.',
      'Want to make any changes, or does it work as-is?',
      template.conversationHistory,
      template.referenceDocument
    );
    setEditingTemplate(template);
  };

  const handleClearAllTemplates = async () => {
    if (!window.confirm("Are you sure you want to delete all saved templates? This cannot be undone.")) return;

    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/templates/${activeRobot}/${currentUser}/${profileId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to clear templates");

      setTemplates([]);
      setSelectedTemplate(null);
    } catch (error) {
      console.error("Error clearing templates:", error);
      alert("Could not clear templates. Please try again.");
    }
  };

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const recordingStartedAtRef = useRef<number>(0);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // UI State
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string>('Ready to start. Press record.');
  const [activityMode, setActivityMode] = useState<string>(restoredDraft?.activityMode || 'Custom');
  // iOS Safari can silently block .play() once too much time has passed since the
  // last real tap (e.g. a slow gateway reply) — this surfaces a manual fallback
  // instead of leaving the interaction looking dead with no audio and no error.
  const [needsManualPlay, setNeedsManualPlay] = useState<boolean>(false);
  // Typed alternative to recording — goes through the exact same voice-loop
  // turn (and conversation history) as a spoken answer, just skipping STT.
  const [typedInput, setTypedInput] = useState<string>('');
  // The researcher's Settings STT language(s) — fetched once, not re-fetched per turn.
  const [sttLanguages, setSttLanguages] = useState<string[]>(['en-US']);

  // Reference document (optional, up to 5 files at once) — extracted/distilled text
  // gets fed to the AI as background context on every turn, and saved alongside the
  // template for future edits.
  const [referenceDocument, setReferenceDocument] = useState<string>(restoredDraft?.referenceDocument || '');
  const [referenceFileNames, setReferenceFileNames] = useState<string[]>([]);
  const [isAnalyzingUpload, setIsAnalyzingUpload] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const MAX_UPLOAD_FILES = 5;
  const [isSuggestingFields, setIsSuggestingFields] = useState<boolean>(false);

  // AI Pipeline State
  // Resume the real conversation if the tweaked activity has one stored, else use a placeholder.
  const hasRealTweakHistory = Array.isArray(initialTweak.tweakConversationHistory) && initialTweak.tweakConversationHistory.length > 0;
  const [conversationHistory, setConversationHistory] = useState<any[]>(
    restoredDraft?.conversationHistory ??
    (hasRealTweakHistory
      ? initialTweak.tweakConversationHistory!
      : hasTweak
      ? [
          { role: 'user', content: 'Continue refining this activity after testing it.' },
          { role: 'assistant', content: JSON.stringify({ prompt: initialTweak.tweakPrompt || '', question: tweakSeedQuestion }) }
        ]
      : [])
  );
  const [currentPrompt, setCurrentPrompt] = useState<string>(restoredDraft?.currentPrompt ?? (hasTweak ? (initialTweak.tweakPrompt || '') : ''));
  // Direct textarea edits, tracked separately from voice-driven turns — logged at save time, never merged into conversationHistory.
  const [manualEdits, setManualEdits] = useState<{ timestamp: string; previousText: string; newText: string }[]>(restoredDraft?.manualEdits ?? []);
  const [flowchartViews, setFlowchartViews] = useState<{ timestamp: string }[]>(restoredDraft?.flowchartViews ?? []);
  const promptOnFocusRef = useRef<string>('');
  // Per-turn timestamps for the record -> think -> speak cycle. Built up
  // incrementally across a turn (recording happens first, AI speech
  // playback is event-driven and finishes later), then committed to
  // turnTimings as one complete entry once the turn is fully done.
  type TurnTiming = { recordingStarted: string; recordingStopped: string; aiSpeechStarted: string; aiSpeechEnded: string };
  const [turnTimings, setTurnTimings] = useState<TurnTiming[]>(restoredDraft?.turnTimings ?? []);
  const currentTurnTimingRef = useRef<Partial<TurnTiming>>({});
  const [lastQuestion, setLastQuestion] = useState<string>(restoredDraft?.lastQuestion ?? (hasTweak ? tweakSeedQuestion : ''));
  const [, setLastTranscript] = useState<string>('');
  const [flowchartData, setFlowchartData] = useState<any>(restoredDraft?.flowchartData ?? (hasTweak ? (initialTweak.tweakFlowchart || FLOWCHART_TEMPLATES['Custom']) : null));
  const [activeNodePrompt, setActiveNodePrompt] = useState<any>(null);
  const [editedNodeIds, setEditedNodeIds] = useState<Set<string>>(new Set(restoredDraft?.editedNodeIds ?? []));
  const [isRegeneratingFlowchart, setIsRegeneratingFlowchart] = useState(false);

  // Flowchart Modal State
  const [showFlowchartModal, setShowFlowchartModal] = useState(false);

  // Save Modal State
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [templateName, setTemplateName] = useState(restoredDraft?.templateName ?? (hasTweak ? (initialTweak.tweakTitle || '') : ''));
  const [templateDescription, setTemplateDescription] = useState(restoredDraft?.templateDescription ?? (hasTweak ? (initialTweak.tweakDescription || '') : ''));

  // Keeps the in-progress draft in sessionStorage so a refresh (or other unexpected
  // interruption) doesn't lose work — only real intentional exits (Back button,
  // successful save) clear draftId_design/draftContent_design, and those already
  // count as done/abandoned.
  useEffect(() => {
    if (view !== 'create') return;
    const draftId = sessionStorage.getItem('draftId_design');
    if (!draftId) return;
    const draftContent = {
      currentPrompt,
      flowchartData,
      conversationHistory,
      templateName,
      templateDescription,
      activityMode,
      manualEdits,
      flowchartViews,
      turnTimings,
      editedNodeIds: Array.from(editedNodeIds),
      lastQuestion,
      editingTemplate,
      referenceDocument
    };
    sessionStorage.setItem('draftContent_design', JSON.stringify(draftContent));
  }, [view, currentPrompt, flowchartData, conversationHistory, templateName, templateDescription, activityMode, manualEdits, flowchartViews, turnTimings, editedNodeIds, lastQuestion, editingTemplate, referenceDocument]);

  // Auto-names tweak-saves "<base> -version N" instead of colliding with the original.
  useEffect(() => {
    if (!hasTweak) return;

    const versionSuffixRe = /\s*-version\s*\d+\s*$/i;
    const baseTitle = (initialTweak.tweakTitle || 'Untitled Flow').replace(versionSuffixRe, '').trim();

    const computeVersionedName = async () => {
      try {
        const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
        const response = await fetch(`${apiBase}/api/templates/${activeRobot}/${currentUser}/${profileId}`);
        if (!response.ok) throw new Error("Failed to fetch templates");
        const data = await response.json();
        const existing = Array.isArray(data.templates) ? data.templates : [];

        const matchCount = existing.filter((t: any) =>
          String(t.title || '').replace(versionSuffixRe, '').trim() === baseTitle
        ).length;

        setTemplateName(`${baseTitle} -version ${matchCount + 1}`);
      } catch (error) {
        console.error("Error computing versioned tweak name:", error);
      }
    };

    computeVersionedName();
  }, [hasTweak, initialTweak.tweakTitle, activeRobot, currentUser, profileId]);

  // Set via /language-setup (mandatory on first login) or changed anytime via the
  // 🌐 button — sticky per-username in localStorage. Falls back to English only if
  // that's somehow missing (e.g. a bookmarked deep link before ever logging in).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`sttLanguagesOverride_${currentUser}`);
      const parsed = saved ? JSON.parse(saved) : null;
      setSttLanguages(Array.isArray(parsed) && parsed.length > 0 ? parsed : ['en-US']);
    } catch (e) {
      console.warn('Could not parse saved language override:', e);
      setSttLanguages(['en-US']);
    }
  }, [currentUser]);

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversationHistory]);

  // Initialize Template
  useEffect(() => {
    if (conversationHistory.length === 0) {
      setFlowchartData(FLOWCHART_TEMPLATES[activityMode] || FLOWCHART_TEMPLATES['Custom']);
      setEditedNodeIds(new Set());
    }
  }, [activityMode, conversationHistory]);

  // Reads the mode's instructions aloud (minus the "Ex:" example, which varies
  // per mode) whenever the fresh-start guidance is what's on screen — re-fires
  // on every mode-tab switch since the text itself changes.
  useEffect(() => {
    const hasStarted = conversationHistory.some((turn) => turn.role === 'user');
    if (view !== 'create' || currentPrompt || isProcessing || hasStarted) return;

    let cancelled = false;
    const suggestion = MODE_SUGGESTIONS[activityMode] || MODE_SUGGESTIONS['Custom'];
    const spokenText = suggestion.split(' Ex:')[0];

    const speakSuggestion = async () => {
      try {
        audioPlayerRef.current?.pause();
        const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
        const response = await fetch(`${apiBase}/api/engine/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: spokenText })
        });
        if (!response.ok) throw new Error('TTS failed');
        if (cancelled) return;

        const data = await response.json();
        if (cancelled) return;

        const audioUrl = `data:audio/mp3;base64,${data.audio_base64}`;
        const newAudio = new Audio(audioUrl);
        audioPlayerRef.current = newAudio;
        newAudio.play().catch((e) => console.error('Playback blocked:', e));
      } catch (error) {
        console.error('Error generating suggestion audio:', error);
      }
    };

    speakSuggestion();

    // Stops mid-playback (and cancels an in-flight fetch) on mode switch, view change, or unmount.
    return () => {
      cancelled = true;
      audioPlayerRef.current?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityMode, view, currentPrompt, isProcessing, conversationHistory]);

  // Edit Node Label
  const handleNodeLabelChange = (nodeId: string, newText: string) => {
    setFlowchartData((prev: any) => ({
      ...prev,
      nodes: prev.nodes.map((n: any) =>
        n.id.toString() === nodeId ? { ...n, label: newText } : n
      )
    }));
    setEditedNodeIds((prev) => new Set(prev).add(nodeId));
  };

  // Auto-expanding textarea. Momentarily collapsing height to 'auto' makes the
  // browser think the focused caret went out of view and auto-scroll the page
  // to compensate. useLayoutEffect (not useEffect) runs before paint so the
  // collapsed frame is never actually shown, and the scrollY restore is
  // re-asserted on the next frame in case the browser's own correction is
  // deferred rather than synchronous with the resize.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const scrollY = window.scrollY;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
    window.scrollTo({ top: scrollY });
    const raf = requestAnimationFrame(() => window.scrollTo({ top: scrollY }));
    return () => cancelAnimationFrame(raf);
  }, [currentPrompt]);

  // Finalizes whatever's been captured so far for the in-progress turn
  // (overrides fill in blanks that never happened, e.g. no audio came back)
  // and appends it as one complete entry.
  const commitTurnTiming = (overrides: Partial<TurnTiming> = {}) => {
    const entry: TurnTiming = {
      recordingStarted: '',
      recordingStopped: '',
      aiSpeechStarted: '',
      aiSpeechEnded: '',
      ...currentTurnTimingRef.current,
      ...overrides
    };
    setTurnTimings((prev) => [...prev, entry]);
    currentTurnTimingRef.current = {};
  };

  // Fields shared by every turn regardless of how the user answered (voice or typed).
  const buildTurnFormData = (): FormData => {
    const formData = new FormData();
    formData.append('activity_mode', activityMode);
    formData.append('language_codes', JSON.stringify(sttLanguages));
    formData.append('reference_document', referenceDocument);
    // /content is bypassed, so the learner profile has to reach the AI here instead.
    formData.append('learner_age', activeLearner.targetAge || '');
    formData.append('learner_cognitive_profile', activeLearner.cognitiveProfile || '');
    formData.append('learner_interests', activeLearner.interests || '');

    // Force array and clone history
    const safeHistory = Array.isArray(conversationHistory) ? conversationHistory : [];
    const historyToSend = [...safeHistory];

    // Inject manual edits into AI memory
    if (historyToSend.length > 0) {
      const lastMessage = historyToSend[historyToSend.length - 1];
      if (lastMessage.role === 'assistant') {
        try {
          const aiMemory = JSON.parse(lastMessage.content);
          aiMemory.prompt = currentPrompt;
          lastMessage.content = JSON.stringify(aiMemory);
        } catch (e) {
          console.warn("Could not parse AI memory to inject manual edits.", e);
        }
      }
    }
    formData.append('conversation_history', JSON.stringify(historyToSend));
    return formData;
  };

  // Shared by the recording flow and the typed-input flow — same downstream handling
  // (history, flowchart merge, TTS playback, turn timing) regardless of how the user
  // answered, so typed turns behave exactly like voice turns from here on.
  const submitTurn = async (formData: FormData) => {
    setStatusText('Thinking and putting together your ideas... please wait...');
    setIsProcessing(true);
    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
      const response = await fetch(`${apiBase}/api/engine/voice-loop`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log("Server response:", errorText);
        if (response.status === 422) {
          throw new Error("Had trouble hearing that — please try again.");
        }
        throw new Error(`Backend error: ${response.status}`);
      }

      const data = await response.json();
      console.log(`[RECORDING DEBUG] Transcript: "${data.transcript}"`);

      // Update UI
      setLastTranscript(data.transcript);
      setCurrentPrompt(data.prompt);
      setLastQuestion(data.question);

      let parsedHistory: any[] = [];
      if (Array.isArray(data.history)) {
        parsedHistory = data.history;
      } else if (typeof data.history === 'string') {
        try {
          parsedHistory = JSON.parse(data.history);
        } catch {
          console.warn("Could not parse conversation history from backend:", data.history);
        }
      }
      setConversationHistory(parsedHistory);

      // Merge Flowchart Edits
      const newFlowchartData = data.flowchartData || data.flowchart || (Array.isArray(data.nodes) ? data : null);

      if (newFlowchartData && Array.isArray(newFlowchartData.nodes)) {
        setFlowchartData((prevFlowchart: any) => {
          if (!prevFlowchart || !Array.isArray(prevFlowchart.nodes)) return newFlowchartData;

          const smartMergedNodes = newFlowchartData.nodes.map((newNode: any) => {
            const matchingOldNode = prevFlowchart.nodes.find(
              (oldNode: any) => String(oldNode.id) === String(newNode.id) || oldNode.label === newNode.label
            );

            if (matchingOldNode && editedNodeIds.has(String(matchingOldNode.id))) {
              return {
                ...newNode,
                label: matchingOldNode.label,
                detailedPrompt: matchingOldNode.detailedPrompt
              };
            }
            return newNode;
          });
          return { ...newFlowchartData, nodes: smartMergedNodes };
        });
      } else {
        console.warn("Backend did not return valid flowchart nodes:", newFlowchartData);
      }

      setStatusText('Reply when ready!');

      if (data.audio_base64 && audioPlayerRef.current) {
        const audioUrl = `data:audio/mp3;base64,${data.audio_base64}`;
        audioPlayerRef.current.src = audioUrl;
        audioPlayerRef.current.onplaying = () => {
          currentTurnTimingRef.current.aiSpeechStarted = new Date().toISOString();
          setNeedsManualPlay(false);
        };
        audioPlayerRef.current.onended = () => {
          commitTurnTiming({ aiSpeechEnded: new Date().toISOString() });
        };
        audioPlayerRef.current.play().catch(e => {
          console.error("Playback blocked:", e);
          setNeedsManualPlay(true);
          setStatusText('Tap the button below to hear the reply.');
          commitTurnTiming(); // no speech playback happened — log what we have
        });
      } else {
        commitTurnTiming(); // no audio came back — log what we have
      }
    } catch (error: any) {
      console.error(error);
      setStatusText(error.message || 'Something went wrong — please try again.');
      commitTurnTiming(); // turn failed, but still log whatever timing we captured
    } finally {
      setIsProcessing(false);
    }
  };

  // Typing is treated as an instantaneous "recording" for turnTimings purposes —
  // there's no real recording phase, but AI speech timing after still matters.
  const handleTypedSubmit = async () => {
    const text = typedInput.trim();
    if (!text || isProcessing || isRecording || isAnalyzingUpload) return;

    audioPlayerRef.current?.pause();
    const now = new Date().toISOString();
    currentTurnTimingRef.current = { recordingStarted: now, recordingStopped: now };
    setTypedInput('');

    const formData = buildTurnFormData();
    formData.append('typed_text', text);
    await submitTurn(formData);
  };

  const handleRecordToggle = async () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
    }
    setNeedsManualPlay(false);

    if (isRecording) {
      // STOP RECORDING
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
        setIsRecording(false);
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
    } else {
      // START RECORDING
      if (isProcessing || isAnalyzingUpload) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        let selectedMimeType = 'audio/webm';
        const supportedTypes = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/wav'];
        
        for (const type of supportedTypes) {
          if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type)) {
            selectedMimeType = type;
            break;
          }
        }

        const mediaRecorder = new MediaRecorder(stream, { mimeType: selectedMimeType });
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) audioChunksRef.current.push(event.data);
        };

        mediaRecorder.onstop = async () => {
          currentTurnTimingRef.current.recordingStopped = new Date().toISOString();

          const recordedMs = Date.now() - recordingStartedAtRef.current;
          console.log(`[RECORDING DEBUG] Actual recorded duration: ${(recordedMs / 1000).toFixed(1)}s`);
          const audioBlob = await finalizeRecordingBlob(audioChunksRef.current, selectedMimeType, recordedMs);
          const formData = buildTurnFormData();
          formData.append('audio_file', audioBlob);
          await submitTurn(formData);
        };

        recordingStartedAtRef.current = Date.now();
        currentTurnTimingRef.current = { recordingStarted: new Date().toISOString() };
        mediaRecorder.start();
        setIsRecording(true);
        setStatusText('Listening... Speak into your microphone.');
      } catch (err) {
        console.error(err);
        setStatusText('Error: Microphone access denied.');
      }
    }
  };

  // Soft auto-stop nudge; handleRecordToggle's stop branch fires since isRecording is true.
  useRecordingCountdown(isRecording, handleRecordToggle);

  // ==========================================
  // VIEW 1: TEMPLATE GALLERY
  // ==========================================
  if (view === 'select') {
    return (
      <div className="max-w-5xl mx-auto px-4 py-12">
        <div className="flex justify-end mb-4">
          <span className="text-xs font-semibold bg-indigo-200 text-indigo-700 px-3 py-1 rounded-full">Phase 2: Activity Construction</span>
        </div>
        <div className="flex justify-between items-end mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-800 mb-2">What Activity is the Robot Going to Do?</h1>
            <p className="text-slate-500">Choose a saved activity or design a new one.</p>
          </div>
          <div className="flex items-center gap-4">
            {templates.length > 0 && (
              <button onClick={handleClearAllTemplates} className="text-xs font-semibold text-red-500 hover:underline">
                Clear All
              </button>
            )}
            <button onClick={() => navigate('/profiles')} className="text-sm font-semibold text-slate-400 hover:text-indigo-600 transition-colors">
              ← Back to User Profiles
            </button>
          </div>
        </div>

        {/* AI Suggestions Panel */}
        {(isLoadingSuggestions || suggestedTemplates.length > 0) && (
          <div className="mb-10 bg-violet-50 border-2 border-violet-100 rounded-2xl p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="font-bold text-violet-900">
                ✨ Suggested for {activeLearner.name || 'this learner'}
              </h2>
              {!isLoadingSuggestions && (
                <button
                  onClick={() => fetchSuggestions(true)}
                  disabled={isRegeneratingSuggestions}
                  className="text-xs font-bold text-violet-600 hover:text-violet-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isRegeneratingSuggestions ? 'Generating...' : '🔄 More Suggestions'}
                </button>
              )}
            </div>
            {isLoadingSuggestions ? (
              <p className="text-violet-400 font-medium animate-pulse text-sm">Generating suggestions...</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {suggestedTemplates.map((suggestion, index) => (
                  <div key={index} className="bg-white p-5 rounded-xl border-2 border-violet-200 shadow-sm flex flex-col">
                    <div className="text-3xl mb-2">{suggestion.icon || '✨'}</div>
                    <h3 className="font-bold text-slate-800">{suggestion.title || 'Suggested Activity'}</h3>
                    <p className="text-sm text-slate-500 mt-1 mb-4 flex-1 line-clamp-3">
                      {suggestion.description || ''}
                    </p>
                    <button
                      onClick={() => handleUseSuggestion(suggestion)}
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

        {isLoadingTemplates ? (
          <div className="flex justify-center items-center min-h-[200px]">
            <p className="text-slate-400 font-medium animate-pulse">Loading templates from cloud...</p>
          </div>
        ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* The "+" Card */}
          <div
            onClick={handleStartNewActivity}
            className="bg-indigo-50 border-2 border-dashed border-indigo-200 hover:border-indigo-400 hover:bg-indigo-100 p-6 rounded-2xl flex flex-col items-center justify-center text-center cursor-pointer transition-all min-h-[200px] group"
          >
            <div className="w-12 h-12 bg-indigo-200 text-indigo-700 rounded-full flex items-center justify-center text-2xl font-bold mb-4 group-hover:scale-110 transition-transform">
              +
            </div>
            <h3 className="font-bold text-indigo-900">Design New Activity</h3>
            <p className="text-xs text-indigo-600 mt-1">Create your own activity from scratch</p>
          </div>

          {/* The "Deployed Library" Shortcut Card */}
          <div
            onClick={() => navigate('/library')}
            className="bg-emerald-50 border-2 border-dashed border-emerald-200 hover:border-emerald-400 hover:bg-emerald-100 p-6 rounded-2xl flex flex-col items-center justify-center text-center cursor-pointer transition-all min-h-[200px] group"
          >
            <div className="w-12 h-12 bg-emerald-200 text-emerald-700 rounded-full flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">
              🚀
            </div>
            <h3 className="font-bold text-emerald-900 mt-4">Browse Activity Center</h3>
            <p className="text-xs text-emerald-600 mt-1">Skip ahead and resend an activity you have already made</p>
          </div>

          {/* Abandoned Draft Cards — never saved, temporary to this login session */}
          {abandonedDrafts.map((draft) => (
            <div
              key={draft.id}
              onClick={() => handleResumeAbandonedDraft(draft)}
              className="bg-white p-6 rounded-2xl cursor-pointer transition-all min-h-[200px] flex flex-col border-2 border-dashed border-amber-300 hover:border-amber-400 hover:shadow-md relative"
            >
              <button
                onClick={(e) => handleDismissAbandonedDraft(draft.id, e)}
                className="absolute top-4 right-4 text-slate-400 hover:text-red-500 font-bold text-lg leading-none z-10"
                title="Discard this draft"
              >
                ×
              </button>
              <span className="self-start text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-100 px-2 py-1 rounded-full mb-3">
                Draft
              </span>
              <h3 className="font-bold text-xl text-slate-800 pr-8">{draft.title?.trim() || 'Untitled Flow'}</h3>
              <p className="text-sm text-slate-500 mt-1 mb-4 flex-1 line-clamp-3">
                {draft.description || draft.systemPrompt || 'No details recorded.'}
              </p>
              <span className="text-xs text-slate-400">Click to pick back up</span>
            </div>
          ))}

          {/* Existing Template Cards */}
          {templates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;

            return (
              <div
                key={template.id}
                onClick={() => setSelectedTemplate(template)}
                className={`bg-white p-6 rounded-2xl cursor-pointer transition-all min-h-[200px] flex flex-col border-2 relative ${
                  isSelected
                    ? 'border-indigo-600 shadow-md ring-4 ring-indigo-50'
                    : 'border-slate-200 shadow-sm hover:shadow-md hover:border-indigo-300'
                }`}
              >
                {/* --- CARD MENU --- */}
                <div className="absolute top-4 right-4 z-10" ref={openMenuId === template.id ? menuRef : null}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(openMenuId === template.id ? null : template.id);
                    }}
                    className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors font-bold text-lg leading-none"
                  >
                    ⋮
                  </button>

                  {openMenuId === template.id && (
                    <div className="absolute right-0 mt-1 w-36 bg-white border border-slate-200 rounded-xl shadow-lg py-1.5 z-20 flex flex-col">
                      <button
                        onClick={(e) => handleEditTemplate(template, e)}
                        className="w-full text-left px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={(e) => handleDuplicateTemplate(template, e)}
                        className="w-full text-left px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        Duplicate
                      </button>
                      <button
                        onClick={(e) => handleDeleteTemplate(template.id, e)}
                        className="w-full text-left px-4 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 transition-colors"
                      >
                        Delete Template
                      </button>
                    </div>
                  )}
                </div>
                {/* ------------------------- */}

                <div className="flex justify-between items-start mb-4">
                  <div className="text-4xl">{template.icon || '⚙️'}</div>
                  {isSelected && (
                    <div className="absolute top-14 right-4 bg-indigo-600 text-white rounded-full p-1">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    </div>
                  )}
                </div>
                <h3 className="font-bold text-xl text-slate-800 pr-8">{template.title || "Untitled Flow"}</h3>
                <p className="text-sm text-slate-500 mt-1 mb-4 flex-1 line-clamp-3">
                  {template.description || ''}
                </p>
              </div>
            );
          })}
        </div>
        )}

        {/* The Continue Button */}
        <div className="mt-12 flex justify-end border-t border-slate-200 pt-6">
          <button
            onClick={handleContinueToContent}
            disabled={!selectedTemplate}
            className={`px-8 py-4 rounded-xl font-bold shadow-md transition-all text-lg ${
              selectedTemplate
                ? 'bg-indigo-600 hover:bg-indigo-700 text-white transform hover:-translate-y-1'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            {/* TEMPORARY label while context injection is bypassed — revert to "Continue to Content →" alongside handleContinueToContent */}
            Continue to Testing →
          </button>
        </div>

      </div>
    );
  }

  // ==========================================
  // VIEW 2: VOICE BUILDER
  // ==========================================
  // Truthiness alone isn't enough — voice_loop can return an empty { nodes: [] }.
  const hasValidFlowchart = Array.isArray(flowchartData?.nodes) && flowchartData.nodes.length > 0;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
      <audio ref={audioPlayerRef} className="hidden" />

      <div className="flex justify-between items-center">
        <button onClick={handleBackToGallery} className="text-sm font-bold text-slate-400 hover:text-indigo-600 transition-colors">← Back to Activity Designs</button>
        <span className="text-xs font-semibold bg-indigo-200 text-indigo-700 px-3 py-1 rounded-full">Phase 2: Activity Construction</span>
      </div>

      <p className="text-sm text-slate-500 text-center">Describe your activity by voice, and refine it as you go.</p>

      {/* Reference Document Upload (optional) */}
      <div className="w-full bg-white border border-slate-200 p-4 rounded-xl shadow-sm flex items-center gap-4 flex-wrap">
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
        {referenceDocument ? (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <span className="font-semibold">{referenceFileNames.length > 0 ? referenceFileNames.join(', ') : 'Saved reference document'}</span>
            <span className="text-slate-400">— the AI will use this while drafting</span>
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
          <span className="text-sm text-slate-400">Optional, up to 5 — e.g. a curriculum doc, rubric, or photo (.pdf, .docx, .txt, image up to 3MB each)</span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">
        
        {/* Left Column: Voice Interface */}
        <section className="md:col-span-1 bg-white border border-slate-200 p-6 rounded-2xl shadow-sm text-center flex flex-col items-center justify-center min-h-[250px]">
          <h2 className="text-lg font-bold text-slate-800 mb-6">Voice Agent</h2>
          <RecordingRing isRecording={isRecording} durationSeconds={RECORDING_LIMIT_SECONDS} size={96} className="mb-4">
            <button
              onClick={handleRecordToggle}
              disabled={isProcessing || isAnalyzingUpload}
              className={`w-24 h-24 rounded-full flex items-center justify-center text-white font-bold transition-all shadow-lg ${
                isRecording ? 'bg-red-500 animate-pulse ring-4 ring-red-100' :
                isProcessing ? 'bg-slate-400 cursor-not-allowed' :
                'bg-indigo-600 hover:bg-indigo-700 hover:scale-105 active:scale-95'
              }`}
            >
              {isRecording ? 'STOP' : isProcessing ? '...' : 'RECORD'}
            </button>
          </RecordingRing>
          <p className={`text-sm font-medium h-10 flex items-center justify-center ${isRecording || isProcessing ? 'text-indigo-600' : 'text-slate-600'}`}>
            {statusText}
          </p>
          {needsManualPlay && (
            <button
              onClick={() => {
                audioPlayerRef.current?.play().catch((e) => console.error("Manual playback also blocked:", e));
              }}
              className="mt-2 font-bold py-2 px-4 rounded-xl shadow bg-amber-500 hover:bg-amber-600 text-white text-sm transition-all animate-pulse"
            >
              🔊 Tap to Hear Reply
            </button>
          )}
        </section>

        {/* Right Column: AI Outputs */}
        <section className="md:col-span-2 bg-white border border-slate-200 p-6 rounded-2xl shadow-sm flex flex-col gap-4">
          
          {conversationHistory.some(turn => turn.role === 'user') && (
            <div className="flex flex-col gap-1">
              {/* SINGLE PINNED LABEL */}
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                You said:
              </span>
              
              {/* SCROLLABLE LIST (Newest First) */}
              <div className="max-h-[72px] overflow-y-auto pr-2 flex flex-col gap-3 scrollbar-thin">
                {conversationHistory
                  .filter((turn) => turn.role === 'user')
                  .map((turn, idx) => (
                    <p key={idx} className="text-sm text-slate-600 bg-slate-50 p-3 rounded-lg border border-slate-100 italic shrink-0">
                      "{turn.content}"
                    </p>
                ))}
                <div ref={chatEndRef} />
              </div>
            </div>
          )}

          {lastQuestion && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-bold text-amber-500 uppercase tracking-wider">AI asked:</span>
              <p className="text-sm text-amber-900 bg-amber-50 p-3 rounded-lg border border-amber-100 font-medium">"{lastQuestion}"</p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Your response:</span>
            <textarea
              value={typedInput}
              onChange={(e) => setTypedInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleTypedSubmit();
                }
              }}
              disabled={isRecording || isProcessing || isAnalyzingUpload}
              placeholder={isProcessing ? 'Thinking and putting together your ideas... please wait...' : isAnalyzingUpload ? 'Analyzing your uploaded file(s)... please wait...' : 'Type here, or talk to the Voice Agent to the left...'}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm outline-none focus:border-indigo-400 disabled:opacity-50 resize-none min-h-[80px]"
            />
            <button
              onClick={handleTypedSubmit}
              disabled={isRecording || isProcessing || isAnalyzingUpload || !typedInput.trim()}
              className="self-end bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm py-2 px-5 rounded-lg shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>

          {currentPrompt && (
            <div className="flex flex-col gap-1 mt-4 border-t border-slate-100 pt-4">
              <div className="flex justify-between items-center mb-1">
                <span className="text-xs font-bold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded shadow-sm">Current General Robot Instructions ✏️</span>
              </div>
              <textarea
                ref={textareaRef}
                value={currentPrompt}
                onChange={(e) => setCurrentPrompt(e.target.value)}
                onFocus={(e) => { promptOnFocusRef.current = e.target.value; }}
                onBlur={(e) => {
                  const newText = e.target.value;
                  if (newText !== promptOnFocusRef.current) {
                    setManualEdits((prev) => [...prev, {
                      timestamp: new Date().toISOString(),
                      previousText: promptOnFocusRef.current,
                      newText
                    }]);
                  }
                }}
                className="w-full bg-emerald-50 border border-emerald-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 p-4 rounded-xl text-sm text-slate-800 leading-relaxed whitespace-pre-wrap min-h-[100px] overflow-hidden outline-none transition-all shadow-inner"
                placeholder="The generated prompt will appear here..."
              />

              <button
                onClick={handleSavePromptEdit}
                disabled={isRegeneratingFlowchart || !currentPrompt.trim()}
                className={`self-end mt-2 text-sm font-bold py-2 px-4 rounded-lg shadow transition-all ${
                  isRegeneratingFlowchart || !currentPrompt.trim()
                    ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                }`}
              >
                {isRegeneratingFlowchart ? 'Saving...' : 'Save Edits & Update Flowchart'}
              </button>

              <div className="mt-6 flex gap-3">
                {hasValidFlowchart && (
                  <button
                    onClick={() => {
                      setShowFlowchartModal(true);
                      setFlowchartViews((prev) => [...prev, { timestamp: new Date().toISOString() }]);
                    }}
                    className="shrink-0 font-bold py-3 px-6 rounded-xl shadow transition-all whitespace-nowrap bg-white border-2 border-slate-800 text-slate-800 hover:bg-slate-50"
                  >
                    View Interaction Flow
                  </button>
                )}
                <button
                  onClick={handleOpenSaveModal}
                  disabled={conversationHistory.length === 0 || !hasValidFlowchart || isSuggestingFields}
                  className={`flex-1 font-bold py-3 rounded-xl shadow transition-all text-center block ${
                    conversationHistory.length === 0 || !hasValidFlowchart || isSuggestingFields ? 'bg-slate-300 text-slate-500 cursor-not-allowed' : 'bg-slate-800 hover:bg-slate-900 text-white'
                  }`}
                >
                  {conversationHistory.length === 0
                    ? 'Record audio to generate your specific map first'
                    : !hasValidFlowchart
                    ? 'Flowchart failed to generate — try recording again'
                    : isSuggestingFields
                    ? 'Preparing...'
                    : 'Save & Proceed →'}
                </button>
              </div>
            </div>
          )}
          
          {!currentPrompt && !isProcessing && (
             <div className="h-full flex items-center justify-center text-slate-400 text-sm italic text-center">
               {conversationHistory.some((turn) => turn.role === 'user')
                 ? "There was trouble drawing your flowchart. Please keep speaking and describe the changes you'd like to make — this gives the app another chance to redraw it."
                 : (MODE_SUGGESTIONS[activityMode] || MODE_SUGGESTIONS['Custom'])}
             </div>
          )}
        </section>
      </div>

      {/* Sub-Prompt Modal */}
      {activeNodePrompt && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <div>
                <h3 className="font-bold text-lg text-slate-800">State: {activeNodePrompt.label}</h3>
                <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold mt-1">Node-Specific Instructions</p>
              </div>
              <button onClick={() => setActiveNodePrompt(null)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">×</button>
            </div>

            <div className="p-6 overflow-y-auto">
              <textarea 
                value={activeNodePrompt.detailedPrompt}
                onChange={(e) => setActiveNodePrompt({...activeNodePrompt, detailedPrompt: e.target.value})}
                className="w-full min-h-[200px] md:h-[400px] bg-slate-50 border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 p-4 rounded-xl text-sm text-slate-700 leading-relaxed outline-none transition-all shadow-inner whitespace-pre-wrap font-mono"
              />
            </div>

            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button 
                onClick={() => setActiveNodePrompt(null)} 
                className="px-4 py-2 rounded-lg font-semibold text-slate-600 hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  const editedId = activeNodePrompt.id.toString();
                  setFlowchartData((prev: any) => ({
                    ...prev,
                    nodes: prev.nodes.map((n: any) => 
                      n.id.toString() === editedId ? { ...n, detailedPrompt: activeNodePrompt.detailedPrompt } : n
                    )
                  }));
                  setEditedNodeIds((prev) => new Set(prev).add(editedId));
                  setActiveNodePrompt(null);
                }} 
                className="px-6 py-2 rounded-lg font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow transition-all"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save Activity Modal */}
      {showSaveModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="font-bold text-lg text-slate-800">{editingTemplate ? 'Update Activity' : 'Save Custom Activity'}</h3>
              <button onClick={() => setShowSaveModal(false)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">×</button>
            </div>

            <div className="p-6 flex flex-col gap-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Activity Name</label>
                <input 
                  type="text" 
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="e.g., Spanish Vocab Quiz"
                  className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all"
                  autoFocus
                />
              </div>
              
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">Short Description (Optional)</label>
                <textarea 
                  value={templateDescription}
                  onChange={(e) => setTemplateDescription(e.target.value)}
                  placeholder="What is this activity designed to do?"
                  className="w-full bg-slate-50 border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 p-3 rounded-xl text-sm text-slate-700 outline-none transition-all resize-none min-h-[80px]"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setShowSaveModal(false)}
                className="px-4 py-2 rounded-lg font-semibold text-slate-600 hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={isSavingTemplate}
                onClick={async () => {
                  setIsSavingTemplate(true);
                  try {
                    const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
                    let savedEntityId = '';

                    if (editingTemplate) {
                      // Editing an existing template — overwrite it in place.
                      const response = await fetch(`${apiBase}/api/templates/${activeRobot}/${currentUser}/${profileId}/${editingTemplate.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          title: templateName.trim() || editingTemplate.title || 'Untitled Flow',
                          description: templateDescription.trim(),
                          icon: editingTemplate.icon || '🤖',
                          systemPrompt: currentPrompt,
                          data: flowchartData,
                          conversationHistory,
                          referenceDocument
                        })
                      });

                      if (!response.ok) throw new Error("Failed to update template");

                      const updated = { ...editingTemplate, title: templateName.trim() || editingTemplate.title, description: templateDescription.trim(), systemPrompt: currentPrompt, data: flowchartData, conversationHistory, referenceDocument };
                      setTemplates((prev) => prev.map((t) => (t.id === editingTemplate.id ? updated : t)));
                      setSelectedTemplate(updated);
                      savedEntityId = editingTemplate.id;
                      setEditingTemplate(null);
                    } else {
                      const response = await fetch(`${apiBase}/api/templates`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          machine_name: activeRobot,
                          user_id: currentUser,
                          profile_id: profileId,
                          title: templateName.trim() || `Custom Activity`,
                          description: templateDescription.trim() || '',
                          icon: '🤖',
                          systemPrompt: currentPrompt,
                          data: flowchartData,
                          conversationHistory,
                          referenceDocument
                        })
                      });

                      if (!response.ok) throw new Error("Failed to save activity");

                      const savedTemplate = await response.json();
                      setSelectedTemplate(savedTemplate);
                      savedEntityId = savedTemplate.id;
                    }

                    // Best-effort creation-process log — never let a logging
                    // failure surface as a save failure to the user.
                    try {
                      await fetch(`${apiBase}/api/activity-log`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          machine_name: activeRobot,
                          user_id: currentUser,
                          profile_id: profileId,
                          login_timestamp: localStorage.getItem("loginTimestamp") || "unknown_session",
                          log_type: 'activity',
                          event: editingTemplate ? 'edited' : 'created',
                          entity_id: savedEntityId,
                          entity_title: templateName.trim() || 'Untitled Flow',
                          final_data: { title: templateName, description: templateDescription, systemPrompt: currentPrompt, data: flowchartData },
                          conversation_history: conversationHistory,
                          phase_entered_at: sessionStorage.getItem('phaseStart_design') || '',
                          phase_exited_at: new Date().toISOString(),
                          manual_edits: manualEdits,
                          flowchart_views: flowchartViews,
                          activity_mode: activityMode,
                          turn_timings: turnTimings,
                          reference_document: referenceDocument
                        })
                      });
                      sessionStorage.removeItem('phaseStart_design');
                      sessionStorage.removeItem('draftId_design');
                      sessionStorage.removeItem('draftContent_design');
                    } catch (logError) {
                      console.error('Error writing activity log:', logError);
                    }

                    setShowSaveModal(false);
                    setShowFlowchartModal(false);
                    setTemplateName('');
                    setTemplateDescription('');
                    setView('select');
                  } catch (error) {
                    console.error("Error saving template:", error);
                    alert("Could not save activity. Please try again.");
                  } finally {
                    setIsSavingTemplate(false);
                  }
                }}
                className="px-6 py-2 rounded-lg font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSavingTemplate ? 'Saving...' : (editingTemplate ? 'Save Changes' : 'Save Activity')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Flowchart Modal */}
      {showFlowchartModal && hasValidFlowchart && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <div>
                <h3 className="font-bold text-lg text-slate-800">Interaction Flow</h3>
                <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold mt-1">Click the + to see the details of each step</p>
              </div>
              <button onClick={() => setShowFlowchartModal(false)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">×</button>
            </div>
            <div className="p-6 overflow-hidden">
              <div className="h-[70vh] w-full border border-slate-200 rounded-xl overflow-hidden shadow-inner">
                <InteractionFlowchart
                  data={flowchartData}
                  onEditNode={(nodeId: string) => {
                    const node = flowchartData.nodes.find((n: any) => n.id.toString() === nodeId);
                    if (node) setActiveNodePrompt(node);
                  }}
                  onLabelChange={handleNodeLabelChange}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}