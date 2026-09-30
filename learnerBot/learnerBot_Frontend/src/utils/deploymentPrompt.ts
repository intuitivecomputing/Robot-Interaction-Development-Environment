// Shared between Deploy.tsx (first deploy) and Library.tsx (redeploy) so the
// two flows can't diverge on how the robot-facing prompt/flowchart get built.

// Master list of expressions the robot can choose from — also rendered as
// toggleable boxes in SettingsSidebar. Researchers can narrow this set per-robot
// via Settings; an empty/missing selection falls back to the full list below.
export const FACIAL_EXPRESSION_OPTIONS = [
  'happy', 'sad', 'surprised', 'shocked', 'stressed', 'calm', 'confused', 'tired',
  'interested', 'sorrow', 'fear', 'excitement', 'disgust', 'anger', 'angry', 'concern'
];

// Same idea as FACIAL_EXPRESSION_OPTIONS — these are the raw values sent to the robot.
export const GESTURE_OPTIONS = [
  'beat', 'open_encourage', 'invite', 'invite_double', 'point_arm', 'body_shift', 'head_tilt', 'ack_nod', 'slow_nod'
];

// Display-only labels for the Settings UI — the raw values above are what's
// actually sent to the robot and never change.
export const GESTURE_LABELS: Record<string, string> = {
  beat: 'Wave Arm',
  open_encourage: 'Open Arms',
  invite: 'One Arm Invite',
  invite_double: 'Both Arms Invite',
  point_arm: 'Point With Arm',
  body_shift: 'Wiggle Body',
  head_tilt: 'Tilt Head',
  ack_nod: 'Quick Nod',
  slow_nod: 'Slow Nod',
};

// BCP-47 codes Google Speech-to-Text recognizes. Used both as the Settings default
// (SettingsSidebar) and as the per-recording override offered wherever someone can
// actually speak to the app (Design, CreateProfile) — a researcher's saved default
// shouldn't force a one-off Spanish-speaking parent through Settings first.
// Google Speech-to-Text technically allows up to 4 (1 primary + 3 alternatives),
// but capped lower here to keep the mixed-language use case simple.
export const MAX_STT_LANGUAGES = 2;

export const LANGUAGE_OPTIONS = [
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'es-US', label: 'Spanish (US)' },
  { id: 'es-ES', label: 'Spanish (Spain)' },
  { id: 'fr-FR', label: 'French' },
  { id: 'de-DE', label: 'German' },
  { id: 'it-IT', label: 'Italian' },
  { id: 'pt-BR', label: 'Portuguese (Brazil)' },
  { id: 'cmn-Hans-CN', label: 'Mandarin Chinese (Simplified)' },
  { id: 'ja-JP', label: 'Japanese' },
  { id: 'ko-KR', label: 'Korean' },
  { id: 'hi-IN', label: 'Hindi' },
  { id: 'ar-XA', label: 'Arabic' },
  { id: 'ru-RU', label: 'Russian' },
  { id: 'vi-VN', label: 'Vietnamese' },
  { id: 'tl-PH', label: 'Filipino (Tagalog)' },
  { id: 'th-TH', label: 'Thai' },
  { id: 'nl-NL', label: 'Dutch' },
  { id: 'pl-PL', label: 'Polish' },
  { id: 'tr-TR', label: 'Turkish' },
];

export const generateNodeOutputStructure = (
  nodeId: string,
  nodeLabel: string,
  edges: any[],
  allowedExpressions: string[] = FACIAL_EXPRESSION_OPTIONS,
  allowedGestures: string[] = GESTURE_OPTIONS,
  endNodeId?: string,
  allowedLanguages: string[] = ['en-US']
) => {
  const expressionList = allowedExpressions.length > 0 ? allowedExpressions : FACIAL_EXPRESSION_OPTIONS;
  const gestureList = allowedGestures.length > 0 ? allowedGestures : GESTURE_OPTIONS;
  const languageList = allowedLanguages.length > 0 ? allowedLanguages : ['en-US'];
  const languageNames = Array.from(new Set(
    languageList.map((code) => LANGUAGE_OPTIONS.find((option) => option.id === code)?.label || code)
  ));
  const nodeEdges = edges.filter((edge: any) => edge.from.toString() === nodeId.toString());
  // Every non-end node gets a fallback path to the ending state, even if the
  // researcher's flowchart never wired one up explicitly for this node.
  const hasEarlyExit = endNodeId !== undefined && endNodeId !== null && endNodeId.toString() !== nodeId.toString();

  let transitionFormat = '';
  let transitionRules = '';
  let exampleTransition = '';

  if (nodeEdges.length > 0 || hasEarlyExit) {
    transitionFormat = `, {"transition": "<target_state_id>"}`;

    transitionRules = `\n\n--- STATE TRANSITION RULES ---\nYou are currently in state_${nodeId}. Evaluate the user's input against the following conditions. If a condition is met, you MUST include the transition object as the final item in your JSON array:\n`;
    nodeEdges.forEach((edge: any) => {
      const condition = edge.label || 'next';
      transitionRules += `- IF user action implies '${condition}', set "<target_state_id>" to "state_${edge.to}"\n`;
    });

    if (hasEarlyExit) {
      exampleTransition = `,\n  {"transition": "state_${endNodeId}"}`;
      transitionRules += `- IF the user says or clearly implies they are finished, done for today, or want to stop/end the activity — regardless of where the interaction currently stands — set "<target_state_id>" to "state_${endNodeId}" and make this turn's utterance a brief, warm goodbye.\n`;
    } else {
      exampleTransition = `,\n  {"transition": "state_${nodeEdges[0].to}"}`; // Uses the first valid path for the example
    }

    transitionRules += `If no transition conditions are met, omit the transition object entirely.`;
  }

  // The role attribute in the XML is dynamically set to the node's label
  const formattedRole = nodeLabel.toLowerCase().replace(/[^a-z0-9]/g, '_');
  // Keep the worked example's expressions/gestures inside whatever sets were actually allowed above.
  const exampleExpr1 = expressionList[0] || 'happy';
  const exampleExpr2 = expressionList.find((e) => e !== exampleExpr1) || exampleExpr1;
  const exampleGesture1 = gestureList[0] || 'open_encourage';
  const exampleGesture2 = gestureList.find((g) => g !== exampleGesture1) || exampleGesture1;

  return `- Output Rules: Your response must be returned as a single JSON array of strings. You must never output more than one array per turn.
The array must follow this format:

[
 {"strategy": "${nodeLabel}"},{"utterance": "<text of spoken segment>", "expression": "<an expression to go along with the utterance chosen from the following list: [${expressionList.join(', ')}] and an accompanying emotion intensity [i.e. high or low]>", "gesture": "<A body gesture chosen from this list [${gestureList.join(', ')}] to accompany the utterance a timing marker indicating when the gesture occurs relative to the utterance (i.e. start, mid, end)>"}${transitionFormat}
]



Do not include anything else outside this format.

ONLY choose expressions and gestures from the provided list – do not assume the existence of other expressions.

LANGUAGE RULE (CRITICAL): Every "utterance" must be written only in ${languageNames.join(' or ')}. Never switch to or mix in any other language, even if the user speaks another language.

CHUNK YOUR UTTERANCES: Make sure each individual utterance is 10 words or less. If you have longer sentences, chunk them into smaller consecutive utterance objects.

INTERACTION TAGGING (CRITICAL):

When you ask the user a question or prompt them to speak, you MUST wrap that specific sentence in an XML interaction tag inside the utterance string.

Format: <interaction role="${formattedRole}">Your question here</interaction>

Do not add labels, headings, explanations, or commentary. Do not include preamble or closing text.

${transitionRules}

--- EXAMPLE DESIRED OUTPUT ---

[
  {"strategy": "${nodeLabel}"},

  {"utterance": "Hello! I am so excited to see you.", "expression": "${exampleExpr1}:high", "gesture": "${exampleGesture1}:start"},

  {"utterance": "<interaction role=\"${formattedRole}\">Are you ready to play a game?</interaction>", "expression": "${exampleExpr2}:high", "gesture": "${exampleGesture2}:end"}${exampleTransition}
]`;
};

// Appends the per-node OUTPUT RULES block used by the physical robot, without
// mutating the clean flowchart the library stores.
export const buildHardwareFlowchart = (
  flowchart: any,
  allowedExpressions: string[] = FACIAL_EXPRESSION_OPTIONS,
  allowedGestures: string[] = GESTURE_OPTIONS,
  allowedLanguages: string[] = ['en-US']
) => {
  // The flowchart-generation prompt always labels the terminal node "End: ...".
  const endNode = (flowchart.nodes || []).find(
    (n: any) => typeof n.label === 'string' && n.label.trim().toLowerCase().startsWith('end:')
  );

  return {
    ...flowchart,
    nodes: flowchart.nodes.map((node: any) => {
      const customOutputStructure = generateNodeOutputStructure(node.id, node.label, flowchart.edges || [], allowedExpressions, allowedGestures, endNode?.id, allowedLanguages);
      return {
        ...node,
        detailedPrompt: `${node.detailedPrompt}\n\n=== OUTPUT RULES ===\n${customOutputStructure}`
      };
    })
  };
};

// Fetches the researcher's saved robot settings. Never throws — callers get
// null on failure and decide their own fallback.
export const fetchRobotSettings = async (apiBase: string, activeRobot: string, currentUser: string): Promise<any | null> => {
  try {
    const settingsResponse = await fetch(`${apiBase}/api/settings/${activeRobot}/${currentUser}`);
    if (!settingsResponse.ok) return null;
    return await settingsResponse.json();
  } catch (settingsError) {
    console.error("Could not load global settings, deploying without them:", settingsError);
    return null;
  }
};

// Formats a settings object (from fetchRobotSettings) as a text block for the robot prompt.
export const buildSettingsBlock = (settings: any | null): string => {
  if (!settings) return '';
  const languageCodes = Array.isArray(settings.languages) && settings.languages.length > 0 ? settings.languages : ['en-US'];
  const languageNames = Array.from(new Set(
    languageCodes.map((code: string) => LANGUAGE_OPTIONS.find((option) => option.id === code)?.label || code)
  ));
  return `\n\n--- GLOBAL ROBOT SETTINGS ---\nROBOT NAME: ${settings.name || 'Robot'}\nSPEAKING PACE: ${settings.pace || 'Normal'}\nLANGUAGE: You must respond only in ${languageNames.join(' or ')}. Never switch to or mix in any other language, even if the user does.`;
};
