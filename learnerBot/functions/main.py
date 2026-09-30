import os
import io
import json
import base64
import httpx
import traceback
import asyncio
import uuid
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List

from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv

from firebase_admin import credentials, initialize_app
from firebase_functions import https_fn, options
from a2wsgi import ASGIMiddleware
from werkzeug.wrappers import Response

# Load environment variables
current_directory = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(current_directory, ".env")
load_dotenv(env_path)

google_key_path = os.path.join(current_directory, "google-cloud-key.json")
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = google_key_path

app = FastAPI(title="learnerBot Voice Pipeline")

app.add_middleware(
    CORSMiddleware, 
    allow_origins=["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173", "https://your-firebase-project-id.web.app", "https://your-firebase-project-id.firebaseapp.com" ], 
    allow_credentials=True, 
    allow_methods=["*"], 
    allow_headers=["*"]
)

from firebase import get_rtdb_reference, get_rtdb_data, get_storage_bucket

def transcribe_long_audio(speech_module, google_speech_client, config, audio_bytes: bytes, timeout: int = 100):
    """long_running_recognize still caps inline audio duration — routes through a GCS URI to remove it."""
    bucket = get_storage_bucket()
    blob_name = f"temp_audio/{uuid.uuid4()}.webm"
    blob = bucket.blob(blob_name)
    blob.upload_from_string(audio_bytes, content_type="audio/webm")

    try:
        audio = speech_module.RecognitionAudio(uri=f"gs://{bucket.name}/{blob_name}")
        operation = google_speech_client.long_running_recognize(config=config, audio=audio)
        return operation.result(timeout=timeout)
    finally:
        try:
            blob.delete()
        except Exception as cleanup_error:
            print(f"[AUDIO DEBUG] Failed to delete temp GCS blob {blob_name}: {cleanup_error}")

def sanitize_firebase_keys(data):
    """
    Recursively scans a dictionary or list and replaces Firebase-illegal 
    characters ( . $ # [ ] / ) in dictionary keys with underscores.
    """
    if isinstance(data, dict):
        clean_dict = {}
        for key, value in data.items():
            # Force to string and strip illegal characters
            safe_key = str(key)
            for bad_char in ['.', '$', '#', '[', ']', '/']:
                safe_key = safe_key.replace(bad_char, '_')
            
            # Catch empty keys just in case
            if not safe_key.strip():
                safe_key = "empty_key_fixed"
                
            clean_dict[safe_key] = sanitize_firebase_keys(value)
        return clean_dict
    elif isinstance(data, list):
        return [sanitize_firebase_keys(item) for item in data]
    else:
        # It's a primitive value (string, int, etc.), return as-is
        return data

def slugify_key(name: str) -> str:
    """Turns a display name into a Firebase-safe key, e.g. 'Fifth grade class' -> 'Fifth_grade_class'."""
    key = name.strip().replace(" ", "_")
    for bad_char in ['.', '$', '#', '[', ']', '/']:
        key = key.replace(bad_char, '_')
    return key or "profile"

# Keys that sit directly under robots/{machine_name}/{user_id} but are NOT learner profiles.
NON_PROFILE_KEYS = {"last_login", "settings"}

# Hard cap on total state-visits per simulation session — guards against cyclic flowcharts.
MAX_SIMULATION_TURNS = 30

# Master list of expressions the robot can choose from — must stay in sync with
# FACIAL_EXPRESSION_OPTIONS in learnerBot_Frontend/src/utils/deploymentPrompt.ts.
FACIAL_EXPRESSION_OPTIONS = [
    "happy", "sad", "surprised", "shocked", "stressed", "calm", "confused", "tired",
    "interested", "sorrow", "fear", "excitement", "disgust", "anger", "angry", "concern"
]

# Same idea, for gestures — must stay in sync with GESTURE_OPTIONS in deploymentPrompt.ts.
GESTURE_OPTIONS = [
    "beat", "open_encourage", "invite", "invite_double", "point_arm", "body_shift", "head_tilt", "ack_nod", "slow_nod"
]

class ThemePayload(BaseModel):
    flowchart: Dict[str, Any]
    themeContext: str
    baseGlobalPrompt: str

class SimulatePayload(BaseModel):
    systemPrompt: str
    flowchart: Dict[str, Any]
    currentStateId: Optional[str] = None
    history: List[Dict[str, Any]] = []
    turnsToGenerate: int = 5
    totalTurnsGenerated: int = 0
    languages: List[str] = ["en-US"]  # what the deployed robot will be restricted to — preview should match

class TTSPayload(BaseModel):
    text: str

class ProfilePayload(BaseModel):
    machine_name: str = "whiteBot"
    user_id: str
    name: str
    targetAge: str = ""
    cognitiveProfile: str = ""
    interests: str = ""
    referenceDocument: str = ""  # extracted text from an uploaded reference file, if any

class LoginPayload(BaseModel):
    machine_name: str = "whiteBot"
    user_id: str
    timestamp: str

class TemplatePayload(BaseModel):
    machine_name: str = "whiteBot"
    user_id: str
    profile_id: str
    title: str
    description: str = ""
    icon: str = "🤖"
    systemPrompt: str = ""
    data: Dict[str, Any] = {}
    conversationHistory: list = []  # full {role, content} turn history, so re-editing later can resume from it
    referenceDocument: str = ""  # extracted text from an uploaded reference file, if any

class TemplateUpdatePayload(BaseModel):
    title: str
    description: str = ""
    icon: str = "🤖"
    systemPrompt: str = ""
    data: Dict[str, Any] = {}
    conversationHistory: list = []  # full {role, content} turn history, so re-editing later can resume from it
    referenceDocument: str = ""  # extracted text from an uploaded reference file, if any

class ContextPayload(BaseModel):
    machine_name: str = "whiteBot"
    user_id: str
    profile_id: str
    title: str
    description: str = ""
    robotRole: str = ""
    activityTask: str = ""
    contextRules: str = ""

class ContextUpdatePayload(BaseModel):
    title: str
    description: str = ""
    robotRole: str = ""
    activityTask: str = ""
    contextRules: str = ""

class ProfileUpdatePayload(BaseModel):
    name: str
    targetAge: str = ""
    cognitiveProfile: str = ""
    interests: str = ""
    referenceDocument: str = ""  # extracted text from an uploaded reference file, if any

class SettingsPayload(BaseModel):
    name: str = "Robot"
    voice: str = "alloy"
    voiceInstructions: str = ""
    languages: list = ["en-US"]  # what the robot itself listens for during a live deployed activity
    facialExpressions: list = FACIAL_EXPRESSION_OPTIONS
    gestures: list = GESTURE_OPTIONS
    pace: str = "Normal"

class SuggestionRequest(BaseModel):
    machine_name: str = "whiteBot"
    user_id: str
    profile_id: str
    count: int = 3
    force: bool = False  # bypass the cached suggestions and generate a fresh batch (the "Generate More" button)

class ActivityLogPayload(BaseModel):
    machine_name: str = "whiteBot"
    user_id: str
    profile_id: str
    login_timestamp: str = "unknown_session"  # groups everything from one login session together
    log_type: str        # "activity" | "profile"
    event: str            # "created" | "edited" | "abandoned"
    entity_id: str = ""   # template_id or profile_id of the thing that was made
    entity_title: str = ""
    final_data: Dict[str, Any] = {}       # the full saved object (title/systemPrompt/data, or name/targetAge/etc.)
    conversation_history: list = []       # the raw {role, content} turn array as accumulated client-side
    phase_entered_at: str = ""            # ISO timestamp, when the user entered this phase
    phase_exited_at: str = ""             # ISO timestamp, when the user completed/left this phase
    manual_edits: list = []               # [{timestamp, previousText, newText}] — direct textarea edits, separate from voice-driven turns
    flowchart_views: list = []            # [{timestamp}] — each time the flowchart modal was opened
    activity_mode: str = ""               # e.g. "Custom" | "Discussion" | "Roleplay" | "Question and Answer" | "Educational Game"
    turn_timings: list = []               # [{recordingStarted, recordingStopped, aiSpeechStarted, aiSpeechEnded}] per voice turn
    reference_document: str = ""          # distilled memory from any uploaded reference file(s), if used


@app.get("/api/health")
async def health_check():
    return {"status": "healthy"}


@app.post("/api/engine/tts")
async def text_to_speech(payload: TTSPayload):
    """Speaks arbitrary text — used for static greetings that need audio without a full voice-loop round trip."""
    from openai import OpenAI
    try:
        api_key = os.getenv("OPENAI_API_KEY")
        openai_client = OpenAI(api_key=api_key) if api_key else None
        if not openai_client or not payload.text.strip():
            raise Exception("Missing OpenAI API key or empty text.")

        tts_response = openai_client.audio.speech.create(
            model="tts-1",
            voice="alloy",
            input=payload.text
        )
        audio_base64 = base64.b64encode(tts_response.content).decode('utf-8')
        return {"audio_base64": audio_base64}
    except Exception as e:
        print(f"[TTS] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate speech.")


@app.post("/api/engine/voice-loop")
async def voice_loop(request: Request):
    from openai import OpenAI
    from google.cloud import speech
    print("\n[VOICE LOOP] Request received.")
    
    try:
        form_data = await request.form()
        audio_file = form_data.get("audio_file")
        typed_text = (form_data.get("typed_text") or "").strip()
        conversation_history = form_data.get("conversation_history", "[]")
        activity_mode = form_data.get("activity_mode", "Custom")
        language_code, alternative_language_codes = parse_language_codes(form_data.get("language_codes", ""))
        learner_age = form_data.get("learner_age", "")
        learner_cognitive_profile = form_data.get("learner_cognitive_profile", "")
        learner_interests = form_data.get("learner_interests", "")
        reference_document = form_data.get("reference_document", "")

        if not audio_file and not typed_text:
            raise Exception("No audio file or typed text found in the request!")

        # 1. Safely Parse History
        try:
            history = json.loads(conversation_history)
            if isinstance(history, str):
                history = json.loads(history)
            if not isinstance(history, list):
                history = []
        except Exception as e:
            print(f"[VOICE LOOP] Failed to load history, defaulting to empty list. Error: {e}")
            history = []

        api_key = os.getenv("OPENAI_API_KEY")
        openai_client = OpenAI(api_key=api_key) if api_key else None

        # 2. Get the user's turn — typed input skips STT entirely.
        if typed_text:
            user_text = typed_text
            print(f"[VOICE LOOP] User typed: '{user_text}'")
        else:
            google_speech_client = speech.SpeechClient()
            audio_bytes = await audio_file.read()
            print(f"[AUDIO DEBUG] [VOICE LOOP] Received {len(audio_bytes)} bytes ({len(audio_bytes) / 1024:.1f} KB)")
            config = speech.RecognitionConfig(
                encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
                sample_rate_hertz=48000,
                language_code=language_code,
                alternative_language_codes=alternative_language_codes,
            )
            google_response = transcribe_long_audio(speech, google_speech_client, config, audio_bytes)
            if not google_response.results:
                raise HTTPException(status_code=422, detail="No speech was detected in the recording. Please try again.")

            # Multiple results at pauses — results[0] alone misses everything after the first one.
            user_text = " ".join(result.alternatives[0].transcript for result in google_response.results).strip()
            if not user_text:
                raise HTTPException(status_code=422, detail="No speech was detected in the recording. Please try again.")
            print(f"[VOICE LOOP] User said: '{user_text}'")

        # 3. Setup Mode Instruction
        mode_instructions = """The user is building a CUSTOM activity — there is no preset format, so first identify what kind of interaction this is from what the user describes (e.g. open discussion, roleplay/scenario, quiz/assessment, game with rules, or something else entirely) and adapt your follow-up questions to fit that shape. Focus on the mechanical structure of the interaction. You must ask the user targeted questions ONE AT A TIME to understand:
        - The overall structure/phases the interaction follows, and how the robot decides to transition between them.
        - The specific trigger, condition, or rule that governs progression (e.g. a correct answer, a turn limit, a phase being complete, a topic being exhausted).
        - How the robot should handle unexpected, incorrect, or off-topic input from the user.
        - How the interaction concludes — the specific condition that ends it.
        """

        # 4. Construct Iterative System Prompt
        reference_block = f"""

REFERENCE MATERIAL: The researcher uploaded one or more files (documents and/or images), already read and transcribed below — treat this exactly as if you had read/seen the original files yourself, including any word lists, questions, or specific content they contain. Do not say you are unable to read images or files; the relevant content, if any existed, is already extracted here:
{reference_document}""" if reference_document else ""
        language_restriction = build_language_restriction([language_code] + alternative_language_codes, "question")

        messages = [
            {"role": "system", "content": f"""You are a Technical Systems Architect that helps users easily craft behavior prompts for a conversational social robot. Your job is to gather information step-by-step and continuously generate a usable system prompt for the robot.

CRITICAL MODE INSTRUCTION: {mode_instructions}

LEARNER PROFILE:
- Target Age/Grade: {learner_age or 'Not specified'}
- Cognitive/Skill Profile: {learner_cognitive_profile or 'Not specified'}
- Interests: {learner_interests or 'Not specified'}
Tailor the complexity of language, pacing, and mechanics you draft into the "prompt" field to this user. Use their interests to make the activity more engaging where relevant.
{reference_block}

Step 1 - Information Gathering:
If this is the first interaction, greet the user briefly (one short sentence), acknowledge the type of activity they are building, and immediately ask the first clarifying question based on the CRITICAL MODE INSTRUCTION above. Before asking your next question, check the conversation history. Do not ask redundant questions that the user may have already answered.


Step 2 - Prompt Draft Creation:
Based on the information gathered so far, You MUST generate a working draft in the "prompt" field on EVERY SINGLE TURN, starting from the very first message. Even if the user's request is extremely short (e.g., "act as a job interviewer"), invent a basic foundational prompt using reasonable defaults based on the chosen mode. NEVER leave the "prompt" field empty. An effective prompt should include:
1. Specific, descriptive, and detailed instructions about the desired context, outcome, length, and style.
2. Instructions on what the robot SHOULD do, rather than what it should NOT do.
3. A couple of good, positive examples of how the robot should speak, if available.
Never mix your own guiding role into the robot's instructions.

CRITICAL FORMATTING RULE: You are strictly forbidden from generating emojis, markdown images, HTML image tags, or image URLs under any circumstances. Output text only.

CRITICAL INTERACTION RULE: This is a purely spoken, voice-based interaction. The robot has no screen, buttons, or physical objects for the user to press, click, tap, or interact with. Never reference buttons, screens, menus, gestures the user must perform, or any pressable/clickable/touchable item — the only channel of interaction is spoken conversation.

CRITICAL ROLE RULE: You are the design assistant helping build this activity, not the robot performing it. Never actually run, conduct, or role-play through the activity itself (e.g. don't start quizzing the user, telling the story, or acting out the robot's part) — only discuss and draft it.
{language_restriction}

OUTPUT FORMAT:
You must always respond in valid JSON format with exactly two keys. Do not include markdown formatting like ```json.
{{
"prompt": "<Write your actual continuously updated generated draft of the robot's prompt here. Do not copy this placeholder text.>",
"question": "<Write your greeting or next clarifying question for the user here.>"
}}"""}
        ]

        messages.extend(history)
        messages.append({"role": "user", "content": user_text})

        # 5. Send to Claude via Gateway
        gateway_url = "https://gateway.engineering.jhu.edu/gateway/compat/chat/completions"
        gateway_key = os.getenv("GATEWAY_KEY")
        headers = {"Authorization": f"Bearer {gateway_key}", "Content-Type": "application/json"}
        
        payload = {
            "model": "anthropic/claude-sonnet-4.6",
            "messages": messages,
            "max_tokens": 3000
        }

        async with httpx.AsyncClient() as client:
            response1 = await client.post(gateway_url, headers=headers, json=payload, timeout=60.0)
            if response1.status_code != 200:
                raise Exception(f"Gateway returned status code {response1.status_code}: {response1.text}")
            gateway_data = response1.json()

        ai_text = gateway_data["choices"][0]["message"]["content"]
        
        # Safe JSON parsing for AI response
        try:
            ai_response = parse_ai_json(ai_text)
        except Exception as e:
            print(f"[VOICE LOOP] JSON Parse Error: {e}\nRAW CLAUDE OUTPUT:\n{ai_text}")
            ai_response = {}

        current_prompt = ai_response.get("prompt", "")
        clarifying_question = ai_response.get("question", "Could you provide more details?")

        # 6. Diagram Generator Claude
        flowchart_data = await generate_flowchart_from_prompt(current_prompt)

        # 7. OpenAI Text-to-Speech
        tts_response = openai_client.audio.speech.create(
            model="tts-1",
            voice="alloy", 
            input=clarifying_question
        )
        audio_base64 = base64.b64encode(tts_response.content).decode('utf-8')

        # 8. Package response
        new_history = history + [
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": ai_text}
        ]

        return JSONResponse(content={
            "transcript": user_text,
            "prompt": current_prompt,
            "question": clarifying_question,
            "audio_base64": audio_base64,
            "history": new_history, 
            "flowchart": flowchart_data
        })
    
    except HTTPException:
        raise
    except Exception as e:
        print("\n=== 🚨 CRITICAL ERROR CAUGHT (VOICE LOOP) 🚨 ===")
        traceback.print_exc()
        print("================================================\n")
        raise HTTPException(status_code=500, detail="Check backend terminal for exact error.")
    

class RegenerateFlowchartPayload(BaseModel):
    systemPrompt: str


@app.post("/api/engine/regenerate-flowchart")
async def regenerate_flowchart(payload: RegenerateFlowchartPayload):
    """Rebuilds the flowchart from a manually-edited prompt — triggered by Design.tsx's Save button, not part of the voice loop."""
    try:
        flowchart_data = await generate_flowchart_from_prompt(payload.systemPrompt)
        return JSONResponse(content={"flowchart": flowchart_data})
    except Exception as e:
        print(f"[REGENERATE FLOWCHART] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to regenerate flowchart.")


MAX_UPLOAD_FILES = 5


@app.post("/api/engine/analyze-upload")
async def analyze_upload(files: List[UploadFile] = File(...), context_type: str = Form("activity")):
    """Extracts text from each uploaded document (or, for an image, keeps it for a vision-capable
    model) across up to MAX_UPLOAD_FILES files, then asks Claude ONCE to both suggest field values
    AND distill everything into a single concise memory spanning all the files. Neither the raw
    files nor raw extracted text is persisted — the distilled memory is what gets stored (as
    referenceDocument) and kept feeding to the AI as background context on later turns, so recall
    stays cheap even for several long documents. Used by CreateProfile.tsx (context_type='profile')
    and Design.tsx (context_type='activity')."""
    try:
        if not files:
            raise HTTPException(status_code=400, detail="No files were uploaded.")
        if len(files) > MAX_UPLOAD_FILES:
            raise HTTPException(status_code=400, detail=f"Please upload at most {MAX_UPLOAD_FILES} files at once.")

        text_segments = []  # [(filename, text)]
        image_segments = []  # [(filename, mime, base64)]

        for upload in files:
            filename = upload.filename or "untitled"
            content = await upload.read()
            lower_name = filename.lower()
            image_mime = next((mime for ext, mime in IMAGE_MIME_TYPES.items() if lower_name.endswith(ext)), None)

            if image_mime:
                if len(content) > MAX_IMAGE_BYTES:
                    raise HTTPException(status_code=400, detail=f'"{filename}" is too large — please upload images under 3MB each.')
                image_segments.append((filename, image_mime, base64.b64encode(content).decode("utf-8")))
            else:
                try:
                    text_segments.append((filename, extract_text_from_upload(filename, content)))
                except ValueError as e:
                    raise HTTPException(status_code=400, detail=f'"{filename}": {e}')

        total_image_b64_bytes = sum(len(b64) for _, _, b64 in image_segments)
        if total_image_b64_bytes > MAX_TOTAL_IMAGE_B64_BYTES:
            raise HTTPException(
                status_code=400,
                detail="The combined size of your uploaded images is too large to analyze together — please upload fewer images at once, or smaller ones."
            )

        file_count = len(text_segments) + len(image_segments)
        source_description = "files" if file_count > 1 else ("an image" if image_segments else "the document")

        verbatim_instruction = "If any file (including an image) contains a specific list, set of items, or exact text — e.g. a vocabulary/word list, questions, names, numbers, or any content meant to be used as-is — transcribe those EXACTLY as written into the referenceMemory, not a paraphrase or general description. Only summarize the surrounding context; never summarize away the actual content itself."

        if context_type == "profile":
            field_instruction = f"""You will be given {source_description} uploaded by a researcher about a specific learner. Do two things:
1. Suggest values for a learner profile.
2. Write a memory of the important details — instructional needs, background, accommodations, specific facts worth remembering — that another AI assistant can use as context in every future conversation about this learner, without ever seeing the original files again. Draw from ALL files provided. {verbatim_instruction} Keep surrounding commentary focused; skip filler.

Respond with ONLY a raw JSON object with exactly these keys:
{{
  "name": "<the learner's name if mentioned, else empty string>",
  "targetAge": "<their age or grade level if mentioned, else empty string>",
  "cognitiveProfile": "<a brief description of their cognitive/skill profile or learning needs if mentioned, else empty string>",
  "interests": "<their interests/hobbies if mentioned, else empty string>",
  "referenceMemory": "<the memory described above, else empty string>"
}}
Leave a field as an empty string rather than guessing if the files don't say."""
        else:
            # No title/description here — those are suggested later, from the actual
            # finished system prompt (see /api/engine/suggest-activity-fields), since an
            # uploaded file may end up unused in the final design.
            field_instruction = f"""You will be given {source_description} uploaded by a researcher building a robot activity. Write a memory of the important details — topics, questions, content, structure, rules — that another AI assistant can use as background context in every future conversation about designing this activity, without ever seeing the original files again. Draw from ALL files provided. {verbatim_instruction} Keep surrounding commentary focused; skip filler.

Respond with ONLY a raw JSON object with exactly this key:
{{
  "referenceMemory": "<the memory described above, else empty string>"
}}
Leave it as an empty string rather than guessing if the files don't give enough to work with."""

        # One combined message: all document text up front, then each image labeled by filename.
        user_content: list = []
        if text_segments:
            combined_text = "\n\n".join(f"--- Document: {name} ---\n{text}" for name, text in text_segments)
            user_content.append({"type": "text", "text": combined_text})
        elif not image_segments:
            user_content.append({"type": "text", "text": ""})
        for name, mime, b64 in image_segments:
            user_content.append({"type": "text", "text": f"--- Image: {name} ---"})
            user_content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})

        analysis_payload = {
            "model": "anthropic/claude-sonnet-4.6",
            "messages": [
                {"role": "system", "content": field_instruction},
                {"role": "user", "content": user_content}
            ],
            # Raised from 2000 — verbatim word lists/transcribed content can run long,
            # and truncation here silently drops exactly the content meant to be kept.
            "max_tokens": 3000
        }

        suggested_fields: dict = {}
        # Falls back to the raw extracted document text only if distillation itself fails —
        # better to remember something than nothing, but this should be rare. Image-only
        # uploads have no raw-text fallback, so a failed analysis leaves this empty.
        reference_memory = "\n\n".join(text for _, text in text_segments)
        analysis_error: Optional[str] = None
        try:
            fields_text = await call_gateway_with_retry(analysis_payload, timeout=45.0, label="ANALYZE_UPLOAD")
            result = parse_ai_json(fields_text)
            reference_memory = (result.pop("referenceMemory", "") or reference_memory)[:MAX_REFERENCE_TEXT_CHARS]
            suggested_fields = result
        except Exception as e:
            print(f"[ANALYZE UPLOAD] Field extraction error: {e}")
            analysis_error = str(e)

        # Never silently succeed with nothing to show for it — that's a genuinely failed
        # upload (e.g. the gateway call errored on an image-only upload with no raw-text
        # fallback), not a real "empty file", and the researcher needs to know to retry.
        if not reference_memory.strip():
            raise HTTPException(
                status_code=502,
                detail="Could not analyze the uploaded file(s) — the AI service may be temporarily unavailable. Please try again." + (f" ({analysis_error})" if analysis_error else "")
            )

        return JSONResponse(content={"referenceText": reference_memory, "suggestedFields": suggested_fields})
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ANALYZE UPLOAD] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to analyze uploaded file(s).")


class SuggestActivityFieldsPayload(BaseModel):
    system_prompt: str = ""


@app.post("/api/engine/suggest-activity-fields")
async def suggest_activity_fields(payload: SuggestActivityFieldsPayload):
    # Suggests a title/description from the ACTUAL finished system prompt — not from any
    # uploaded reference file — so the suggestion always reflects what was actually built,
    # even if reference material the researcher uploaded earlier went unused.
    try:
        if not payload.system_prompt.strip():
            return JSONResponse(content={"title": "", "description": ""})

        instruction = """You will be given the full system prompt for a robot activity a researcher just finished designing. Suggest a short title and a one-sentence description for it.

Respond with ONLY a raw JSON object with exactly these keys:
{
  "title": "<a short activity title, else empty string>",
  "description": "<a one-sentence description of what this activity covers, else empty string>"
}"""
        gateway_payload = {
            "model": "anthropic/claude-sonnet-4.6",
            "messages": [
                {"role": "system", "content": instruction},
                {"role": "user", "content": payload.system_prompt[:8000]}
            ],
            "max_tokens": 300
        }
        fields_text = await call_gateway_with_retry(gateway_payload, timeout=30.0, label="SUGGEST_ACTIVITY_FIELDS")
        result = parse_ai_json(fields_text)
        return JSONResponse(content={"title": result.get("title", ""), "description": result.get("description", "")})
    except Exception as e:
        print(f"[SUGGEST ACTIVITY FIELDS] Error: {e}")
        return JSONResponse(content={"title": "", "description": ""})


@app.post("/api/engine/content-voice-loop")
async def content_voice_loop(request: Request):
    from openai import OpenAI
    from google.cloud import speech
    print("\n[CONTENT LOOP] Request received.")
    
    try:
        form_data = await request.form()
        audio_file = form_data.get("audio_file")
        conversation_history = form_data.get("conversation_history", "[]")
        
        # Grab what the user manually typed in the text boxes
        current_role = form_data.get("current_role", "")
        current_task = form_data.get("current_task", "")
        current_rules = form_data.get("current_rules", "")
        
        if not audio_file:
            raise Exception("No audio file found in the request!")
            
        # 1. Initialize Clients Locally (Thread-Safe)
        api_key = os.getenv("OPENAI_API_KEY")
        openai_client = OpenAI(api_key=api_key) if api_key else None
        google_speech_client = speech.SpeechClient()
        
        # 2. Parse History safely
        try:
            history = json.loads(conversation_history)
            if isinstance(history, str):
                history = json.loads(history)
            if not isinstance(history, list):
                history = []
        except Exception as e:
            history = []

        # 3. Google Speech-to-Text
        audio_bytes = await audio_file.read()
        print(f"[AUDIO DEBUG] [CONTENT LOOP] Received {len(audio_bytes)} bytes ({len(audio_bytes) / 1024:.1f} KB)")
        config = speech.RecognitionConfig(
            encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
            sample_rate_hertz=48000,
            language_code="en-US",
        )
        google_response = transcribe_long_audio(speech, google_speech_client, config, audio_bytes)
        if not google_response.results:
             raise HTTPException(status_code=422, detail="No speech was detected in the recording. Please try again.")

        # Multiple results at pauses — results[0] alone misses everything after the first one.
        user_text = " ".join(result.alternatives[0].transcript for result in google_response.results).strip()
        if not user_text:
            raise HTTPException(status_code=422, detail="No speech was detected in the recording. Please try again.")
        print(f"[CONTENT LOOP] User said: '{user_text}'")

        # 4. System Prompt for Content Extraction
        system_instruction = f"""You are an AI assistant helping a user finalize the thematic context and behavioral prompt for a social robot.
You have access to the user's previous conversation history where they designed the mechanical logic. 

CURRENT FORM STATE:
- Robot Role/Persona: "{current_role}"
- Activity Task: "{current_task}"
- Specific Rules: "{current_rules}"

YOUR TASK:
1. Listen to the user's new request.
2. Update or generate the "robotRole", "activityTask", and "contextRules" strings based on what they asked for. Keep them concise and actionable.
3. Ask a follow-up question to clarify any missing thematic details.

CRITICAL FORMATTING RULE: You are strictly forbidden from generating emojis, markdown images, HTML image tags, or image URLs under any circumstances. Output text only.

CRITICAL INTERACTION RULE: This is a purely spoken, voice-based interaction. The robot has no screen, buttons, or physical objects for the user to press, click, tap, or interact with. Never reference buttons, screens, menus, gestures the user must perform, or any pressable/clickable/touchable item — the only channel of interaction is spoken conversation.

OUTPUT FORMAT:
You MUST respond with valid JSON only. Do not use markdown blocks like ```json.
{{
  "robotRole": "<Updated Persona>",
  "activityTask": "<Updated Task>",
  "contextRules": "<Updated Rules>",
  "question": "<Your follow-up question spoken the to user>"
}}"""

        messages = [{"role": "system", "content": system_instruction}]
        messages.extend(history)
        messages.append({"role": "user", "content": user_text})

        # 5. Send to Claude Gateway
        gateway_url = "https://gateway.engineering.jhu.edu/gateway/compat/chat/completions"
        gateway_key = os.getenv("GATEWAY_KEY")
        headers = {"Authorization": f"Bearer {gateway_key}", "Content-Type": "application/json"}
        
        payload = {
            "model": "anthropic/claude-sonnet-4.6",
            "messages": messages,
            "max_tokens": 1000
        }
        
        async with httpx.AsyncClient() as client:
            response = await client.post(gateway_url, headers=headers, json=payload, timeout=60.0)
            if response.status_code != 200:
                raise Exception(f"Gateway Error: {response.text}")
            
        ai_text = response.json()["choices"][0]["message"]["content"]
        
        # 6. Safe JSON Parsing
        try:
            ai_response = parse_ai_json(ai_text)
        except Exception as e:
            print(f"[CONTENT LOOP] JSON Parse Error: {e}\nRAW CLAUDE OUTPUT:\n{ai_text}")
            ai_response = {}

        clarifying_question = ai_response.get("question", "Could you provide more details about the theme?")

        # 7. OpenAI Text-to-Speech
        tts_response = openai_client.audio.speech.create(
            model="tts-1",
            voice="alloy", 
            input=clarifying_question
        )
        audio_base64 = base64.b64encode(tts_response.content).decode('utf-8')

        # 8. Package response 
        new_history = history + [
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": ai_text}
        ]

        return JSONResponse(content={
            "transcript": user_text,
            "robotRole": ai_response.get("robotRole", current_role),
            "activityTask": ai_response.get("activityTask", current_task),
            "contextRules": ai_response.get("contextRules", current_rules),
            "question": clarifying_question,
            "audio_base64": audio_base64,
            "history": new_history
        })

    except HTTPException:
        raise
    except Exception as e:
        print("\n=== 🚨 ERROR (CONTENT LOOP) 🚨 ===")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/engine/suggest-templates")
async def suggest_templates(payload: SuggestionRequest):
    print("\n[SUGGEST TEMPLATES] Request received.")
    try:
        profile_path = f"robots/{payload.machine_name}/{payload.user_id}/{payload.profile_id}"
        profile = get_rtdb_data(profile_path)
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")

        # Reuse the last generated batch if the profile hasn't changed since — regeneration
        # only happens on the "Generate More" button (force=True) or when nothing's cached yet.
        cached_suggestions = profile.get("suggestedTemplates")
        cached_at = profile.get("suggestedTemplatesGeneratedAt")
        profile_last_modified = profile.get("lastModified")
        if not payload.force and cached_suggestions and cached_at and (not profile_last_modified or cached_at >= profile_last_modified):
            print("[SUGGEST TEMPLATES] Serving cached suggestions — profile unchanged since last generation.")
            return {"suggestions": cached_suggestions}

        profile_summary = f"""LEARNER NAME: {profile.get('name', 'Not specified')}
TARGET AGE/GRADE: {profile.get('targetAge', 'Not specified')}
COGNITIVE/SKILL PROFILE: {profile.get('cognitiveProfile', 'Not specified')}
INTERESTS: {profile.get('interests', 'Not specified')}"""

        system_instruction = f"""You are a Technical Systems Architect that designs conversational social robot activities. Your job is to propose {payload.count} DISTINCT activity flow ideas tailored to a specific learner's profile.

Each idea must be a complete, ready-to-use activity: a short title, description, single-emoji icon, a full robot system prompt, and a high-level interaction flowchart — the researcher can accept one as-is or refine it further.

--- LEARNER PROFILE ---
{profile_summary}

FOR EACH ACTIVITY IDEA, GENERATE:
1. "title": A short, descriptive name (3-6 words).
2. "description": One sentence summarizing the activity.
3. "icon": A single emoji representing the activity.
4. "systemPrompt": A complete, detailed robot behavior prompt covering context, outcome, length, and style, and what the robot SHOULD do. Never mix guiding/meta instructions into it.
5. "data": An interaction flowchart object with "nodes" and "edges":
   - USE MACRO-STATES: 4 to 6 core nodes maximum.
   - PREVENT SPAGHETTI LOOPS: route cyclical actions cleanly back to a central node.
   - For EVERY node, generate a `detailedPrompt` string structured as: Overall guidelines (Task) / Specific instructions / Style Guide / Example.
   - The first node MUST have `"id": "1"` and a label starting with "Start:".
   - The final node MUST have a label starting with "End:", and MUST NOT have an edge looping back to the start.

CRITICAL FORMATTING RULE: You are strictly forbidden from generating emojis (other than the single "icon" field), markdown images, HTML image tags, or image URLs under any circumstances. Output text only.

CRITICAL INTERACTION RULE: This is a purely spoken, voice-based interaction. The robot has no screen, buttons, or physical objects for the user to press, click, tap, or interact with. Never reference buttons, screens, menus, gestures the user must perform, or any pressable/clickable/touchable item — the only channel of interaction is spoken conversation.

OUTPUT FORMAT:
You must respond with ONLY a raw, valid JSON object. Do not include markdown formatting like ```json. Use this exact schema:
{{
  "suggestions": [
    {{
      "title": "...",
      "description": "...",
      "icon": "...",
      "systemPrompt": "...",
      "data": {{
        "nodes": [{{"id": "1", "label": "Start: ...", "detailedPrompt": "..."}}],
        "edges": [{{"from": "1", "to": "2", "label": "..."}}]
      }}
    }}
  ]
}}"""

        gateway_url = "https://gateway.engineering.jhu.edu/gateway/compat/chat/completions"
        gateway_key = os.getenv("GATEWAY_KEY")
        headers = {"Authorization": f"Bearer {gateway_key}", "Content-Type": "application/json"}

        gateway_payload = {
            "model": "anthropic/claude-sonnet-4.6",
            "messages": [{"role": "user", "content": system_instruction}],
            # Raised back from 6000 — 3 full suggestions (systemPrompt + flowchart each)
            # were measurably hitting truncation mid-JSON at 6000, causing outright
            # JSON-parse failures rather than just shorter content.
            "max_tokens": 8000
        }

        # Retry on network errors / 5xx only — 4xx won't fix itself.
        response = None
        last_error = None
        for attempt in range(3):
            try:
                async with httpx.AsyncClient() as client:
                    # 150s, not the usual 60s — this asks for 3 full suggestions
                    # (systemPrompt + flowchart each), and real profiles have
                    # measured up to ~103s with claude-sonnet-4.6. Leaves ~30s
                    # of the 180s function budget for everything else.
                    response = await client.post(gateway_url, headers=headers, json=gateway_payload, timeout=150.0)
                if response.status_code == 200 or response.status_code < 500:
                    break
                last_error = f"{response.status_code}: {response.text}"
                print(f"[SUGGEST TEMPLATES] Gateway {response.status_code} on attempt {attempt + 1}: {last_error}")
            except httpx.TransportError as e:
                last_error = str(e)
                print(f"[SUGGEST TEMPLATES] Network error on attempt {attempt + 1}: {e}")
                response = None
            if attempt < 2 and (response is None or response.status_code >= 500):
                await asyncio.sleep(1)

        if response is None:
            raise Exception(f"Could not reach the gateway after retrying: {last_error}")
        if response.status_code != 200:
            raise Exception(f"Gateway returned status code {response.status_code}: {response.text}")
        ai_text = response.json()["choices"][0]["message"]["content"]

        try:
            ai_response = parse_ai_json(ai_text)
        except Exception as e:
            print(f"[SUGGEST TEMPLATES] JSON Parse Error: {e}\nRAW CLAUDE OUTPUT:\n{ai_text}")
            ai_response = {}

        suggestions = ai_response.get("suggestions", [])
        try:
            get_rtdb_reference(profile_path).update(sanitize_firebase_keys({
                "suggestedTemplates": suggestions,
                "suggestedTemplatesGeneratedAt": datetime.now(timezone.utc).isoformat(),
            }))
        except Exception as e:
            print(f"[SUGGEST TEMPLATES] Failed to cache suggestions: {e}")

        return {"suggestions": suggestions}

    except HTTPException:
        raise
    except Exception as e:
        print("\n=== 🚨 CRITICAL ERROR CAUGHT (SUGGEST TEMPLATES) 🚨 ===")
        traceback.print_exc()
        print("========================================================\n")
        raise HTTPException(status_code=500, detail="Check backend terminal for exact error.")


@app.post("/api/engine/suggest-contexts")
async def suggest_contexts(payload: SuggestionRequest):
    print("\n[SUGGEST CONTEXTS] Request received.")
    try:
        profile_path = f"robots/{payload.machine_name}/{payload.user_id}/{payload.profile_id}"
        profile = get_rtdb_data(profile_path)
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")

        profile_summary = f"""LEARNER NAME: {profile.get('name', 'Not specified')}
TARGET AGE/GRADE: {profile.get('targetAge', 'Not specified')}
COGNITIVE/SKILL PROFILE: {profile.get('cognitiveProfile', 'Not specified')}
INTERESTS: {profile.get('interests', 'Not specified')}"""

        system_instruction = f"""You are an AI assistant that proposes thematic contexts and behavioral prompts for a social robot, tailored to a specific learner's profile.

--- LEARNER PROFILE ---
{profile_summary}

Propose {payload.count} DISTINCT context ideas. Each should give the activity a persona, task, and rules that suit the learner's age, cognitive profile, and interests.

FOR EACH CONTEXT IDEA, GENERATE:
1. "title": A short, descriptive name (3-6 words).
2. "description": One sentence summarizing the theme.
3. "robotRole": The robot's persona for this context.
4. "activityTask": The concrete task the robot guides the learner through.
5. "contextRules": Any specific rules, constraints, or guardrails for this context.

CRITICAL FORMATTING RULE: You are strictly forbidden from generating emojis, markdown images, HTML image tags, or image URLs under any circumstances. Output text only.

CRITICAL INTERACTION RULE: This is a purely spoken, voice-based interaction. The robot has no screen, buttons, or physical objects for the user to press, click, tap, or interact with. Never reference buttons, screens, menus, gestures the user must perform, or any pressable/clickable/touchable item — the only channel of interaction is spoken conversation.

OUTPUT FORMAT:
You must respond with ONLY a raw, valid JSON object. Do not include markdown formatting like ```json. Use this exact schema:
{{
  "suggestions": [
    {{
      "title": "...",
      "description": "...",
      "robotRole": "...",
      "activityTask": "...",
      "contextRules": "..."
    }}
  ]
}}"""

        gateway_url = "https://gateway.engineering.jhu.edu/gateway/compat/chat/completions"
        gateway_key = os.getenv("GATEWAY_KEY")
        headers = {"Authorization": f"Bearer {gateway_key}", "Content-Type": "application/json"}

        gateway_payload = {
            "model": "anthropic/claude-haiku-4-5",
            "messages": [{"role": "user", "content": system_instruction}],
            "max_tokens": 2000
        }

        # Retry on network errors / 5xx only — 4xx won't fix itself.
        response = None
        last_error = None
        for attempt in range(3):
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.post(gateway_url, headers=headers, json=gateway_payload, timeout=60.0)
                if response.status_code == 200 or response.status_code < 500:
                    break
                last_error = f"{response.status_code}: {response.text}"
                print(f"[SUGGEST CONTEXTS] Gateway {response.status_code} on attempt {attempt + 1}: {last_error}")
            except httpx.TransportError as e:
                last_error = str(e)
                print(f"[SUGGEST CONTEXTS] Network error on attempt {attempt + 1}: {e}")
                response = None
            if attempt < 2 and (response is None or response.status_code >= 500):
                await asyncio.sleep(1)

        if response is None:
            raise Exception(f"Could not reach the gateway after retrying: {last_error}")
        if response.status_code != 200:
            raise Exception(f"Gateway returned status code {response.status_code}: {response.text}")
        ai_text = response.json()["choices"][0]["message"]["content"]

        try:
            ai_response = parse_ai_json(ai_text)
        except Exception as e:
            print(f"[SUGGEST CONTEXTS] JSON Parse Error: {e}\nRAW CLAUDE OUTPUT:\n{ai_text}")
            ai_response = {}

        return {"suggestions": ai_response.get("suggestions", [])}

    except HTTPException:
        raise
    except Exception as e:
        print("\n=== 🚨 CRITICAL ERROR CAUGHT (SUGGEST CONTEXTS) 🚨 ===")
        traceback.print_exc()
        print("=======================================================\n")
        raise HTTPException(status_code=500, detail="Check backend terminal for exact error.")


@app.post("/api/activity-log")
async def log_activity_creation(payload: ActivityLogPayload):
    try:
        log_entry = sanitize_firebase_keys({
            "logType": payload.log_type,
            "event": payload.event,
            "userId": payload.user_id,
            "profileId": payload.profile_id,
            "entityId": payload.entity_id,
            "entityTitle": payload.entity_title,
            "finalData": payload.final_data,
            "conversationHistory": payload.conversation_history,
            "phaseEnteredAt": payload.phase_entered_at,
            "phaseExitedAt": payload.phase_exited_at,
            "manualEdits": payload.manual_edits,
            "flowchartViews": payload.flowchart_views,
            "activityMode": payload.activity_mode,
            "turnTimings": payload.turn_timings,
            "referenceDocument": payload.reference_document,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        # slugify_key: ISO timestamps contain "." which is Firebase-illegal in keys.
        login_key = slugify_key(payload.login_timestamp)
        log_path = f"robots/{payload.machine_name}/activity_log/{payload.user_id}/{payload.profile_id}/{login_key}"
        get_rtdb_reference(log_path).push(log_entry)
        return {"status": "success"}
    except Exception as e:
        print(f"[ACTIVITY LOG] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to write activity log")


@app.post("/api/apply-context")
# Apply Context to State Prompts
async def apply_context_route(payload: ThemePayload):
    try:
        flowchart = payload.flowchart
        nodes = flowchart.get("nodes", [])
        
        async def merge_node_context(node: dict) -> dict:
            current_prompt = node.get("detailedPrompt", "")
            node_label = node.get("label", "Unnamed State")

            system_prompt = f"""You are a logic-preserving AI architect.
Your task is to merge a new thematic context into a social robot's specific behavioral state.
CRITICAL RULES:
1. Preserve the mechanical logic of the original state.
2. Apply the new theme's flavor, persona, and subject matter.
3. Output ONLY the rewritten instruction. No commentary.

CRITICAL FORMATTING RULE: You are strictly forbidden from generating emojis, markdown images, HTML image tags, or image URLs under any circumstances. Output text only.

CRITICAL INTERACTION RULE: This is a purely spoken, voice-based interaction. The robot has no screen, buttons, or physical objects for the user to press, click, tap, or interact with. Never reference buttons, screens, menus, gestures the user must perform, or any pressable/clickable/touchable item — the only channel of interaction is spoken conversation.

--- INPUTS ---
STATE NAME: {node_label}
ORIGINAL LOGIC: {current_prompt}
NEW THEME CONTEXT: {payload.themeContext}"""
            
            gateway_url = "https://gateway.engineering.jhu.edu/gateway/compat/chat/completions"
            gateway_key = os.getenv("GATEWAY_KEY")
            headers = {"Authorization": f"Bearer {gateway_key}", "Content-Type": "application/json"}
            
            payload_data = {
                "model": "anthropic/claude-haiku-4-5",
                "messages": [{"role": "user", "content": system_prompt}],
                "max_tokens": 1000
            }
            
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.post(gateway_url, headers=headers, json=payload_data, timeout=60.0)
                    if resp.status_code == 200:
                        merged_text = resp.json()["choices"][0]["message"]["content"].strip()
                    else:
                        merged_text = current_prompt
            except Exception as e:
                print(f"[APPLY CONTEXT] Node '{node_label}' merge failed, keeping original: {e}")
                merged_text = current_prompt

            updated_node = node.copy()
            updated_node["detailedPrompt"] = merged_text
            return updated_node

# Apply context to Main Prompt
        async def merge_global_prompt() -> str:
            if not payload.baseGlobalPrompt:
                return payload.themeContext
                
            system_prompt = f"""You are an AI architect designing a system prompt for a social robot.
Your task is to REWRITE an existing system prompt for a social robot to use a brand new persona and context, while strictly preserving its mechanical logic.

CRITICAL INSTRUCTIONS:
1. If it exists, STRIP out the old persona, old topic, and old scenario from the Structural Mechanics.
2. INJECT the new Thematic Context (Role, Task, Rules).
3. PRESERVE 100% of the mechanical logic (turn-taking, loop conditions, etc.). formatting rules, and state boundaries must remain exactly as long and detailed as the original. Do not summarize the structural rules.
4. Output ONLY the final synthesized system prompt. No preamble.

CRITICAL FORMATTING RULE: You are strictly forbidden from generating emojis, markdown images, HTML image tags, or image URLs under any circumstances. Output text only.

CRITICAL INTERACTION RULE: This is a purely spoken, voice-based interaction. The robot has no screen, buttons, or physical objects for the user to press, click, tap, or interact with. Never reference buttons, screens, menus, gestures the user must perform, or any pressable/clickable/touchable item — the only channel of interaction is spoken conversation.

--- INPUTS ---
ORIGINAL STRUCTURAL MECHANICS: {payload.baseGlobalPrompt}
THEMATIC CONTEXT: {payload.themeContext}"""
            
            gateway_url = "https://gateway.engineering.jhu.edu/gateway/compat/chat/completions"
            gateway_key = os.getenv("GATEWAY_KEY")
            headers = {"Authorization": f"Bearer {gateway_key}", "Content-Type": "application/json"}
            
            payload_data = {
                "model": "anthropic/claude-haiku-4-5",
                "messages": [{"role": "user", "content": system_prompt}],
                "max_tokens": 1500
            }
            
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.post(gateway_url, headers=headers, json=payload_data, timeout=60.0)
                    if resp.status_code == 200:
                        return resp.json()["choices"][0]["message"]["content"].strip()
                    return payload.baseGlobalPrompt
            except Exception as e:
                print(f"[APPLY CONTEXT] Global prompt merge failed, keeping original: {e}")
                return payload.baseGlobalPrompt
            
        node_tasks = [merge_node_context(node) for node in nodes]
        results = await asyncio.gather(merge_global_prompt(), *node_tasks)
        
        flowchart["nodes"] = list(results[1:])
        
        return {
            "mergedFlowchart": flowchart, 
            "mergedGlobalPrompt": results[0]
        }

    except Exception as e:
        print("\n=== 🚨 CRITICAL ERROR CAUGHT (APPLY CONTEXT) 🚨 ===")
        traceback.print_exc()
        print("====================================================\n")
        raise HTTPException(status_code=500, detail="Failed to merge context")
    

async def call_gateway_with_retry(gateway_payload: dict, timeout: float = 60.0, label: str = "GATEWAY", max_attempts: int = 3) -> str:
    """Retry on network errors / 5xx only — 4xx won't fix itself. Returns the raw message content.

    max_attempts=1 for callers nested inside another already-budgeted call (e.g. voice_loop's
    flowchart step) — retrying there risks blowing the shared Cloud Function timeout_sec rather
    than just gracefully degrading like a single failed attempt would.
    """
    gateway_url = "https://gateway.engineering.jhu.edu/gateway/compat/chat/completions"
    gateway_key = os.getenv("GATEWAY_KEY")
    headers = {"Authorization": f"Bearer {gateway_key}", "Content-Type": "application/json"}

    response = None
    last_error = None
    for attempt in range(max_attempts):
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(gateway_url, headers=headers, json=gateway_payload, timeout=timeout)
            if response.status_code == 200 or response.status_code < 500:
                break
            last_error = f"{response.status_code}: {response.text}"
            print(f"[{label}] Gateway {response.status_code} on attempt {attempt + 1}: {last_error}")
        except httpx.TransportError as e:
            last_error = str(e)
            print(f"[{label}] Network error on attempt {attempt + 1}: {e}")
            response = None
        if attempt < max_attempts - 1 and (response is None or response.status_code >= 500):
            await asyncio.sleep(1)

    if response is None:
        raise Exception(f"Could not reach the gateway after retrying: {last_error}")
    if response.status_code != 200:
        raise Exception(f"Gateway returned status code {response.status_code}: {response.text}")
    return response.json()["choices"][0]["message"]["content"]


def parse_ai_json(ai_text: str) -> dict:
    """Parses the first complete JSON object in ai_text, ignoring leading prose/fences and any trailing extra data (e.g. a stray extra '}')."""
    start_idx = ai_text.find('{')
    if start_idx == -1:
        raise ValueError("No JSON object found in the response.")
    return json.JSONDecoder(strict=False).raw_decode(ai_text, start_idx)[0]


def parse_language_codes(raw: str) -> tuple:
    """Parses a JSON array of BCP-47 codes (e.g. '["en-US","es-ES"]') into
    (primary, alternatives) for Google STT's RecognitionConfig. Falls back to
    en-US alone if empty/invalid. Google caps alternative_language_codes at 3."""
    try:
        codes = json.loads(raw) if raw else []
        if not isinstance(codes, list) or not codes:
            codes = ["en-US"]
    except Exception:
        codes = ["en-US"]
    return codes[0], codes[1:4]


# Plain names for prompt instructions — must stay in sync with LANGUAGE_OPTIONS
# in learnerBot_Frontend/src/utils/deploymentPrompt.ts.
LANGUAGE_NAMES = {
    "en-US": "English", "en-GB": "English", "es-US": "Spanish", "es-ES": "Spanish",
    "fr-FR": "French", "de-DE": "German", "it-IT": "Italian", "pt-BR": "Portuguese",
    "cmn-Hans-CN": "Mandarin Chinese", "ja-JP": "Japanese", "ko-KR": "Korean",
    "hi-IN": "Hindi", "ar-XA": "Arabic", "ru-RU": "Russian", "vi-VN": "Vietnamese",
    "tl-PH": "Filipino (Tagalog)", "th-TH": "Thai", "nl-NL": "Dutch", "pl-PL": "Polish",
    "tr-TR": "Turkish",
}


def build_language_restriction(codes: list, field_name: str) -> str:
    """Builds a CRITICAL LANGUAGE RULE instruction restricting a spoken-output field
    to the researcher's chosen language(s) (up to MAX_STT_LANGUAGES on the frontend)."""
    names = []
    for code in codes:
        name = LANGUAGE_NAMES.get(code, code)
        if name not in names:
            names.append(name)
    if not names:
        names = ["English"]
    return f"""

CRITICAL LANGUAGE RULE: The \"{field_name}\" field must be written only in {' or '.join(names)}. Never switch to or mix in any other language, even if the user does."""


# Cap on extracted reference-document text — keeps gateway token budgets and
# RTDB value sizes bounded even for a lengthy uploaded document.
MAX_REFERENCE_TEXT_CHARS = 20000

IMAGE_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
# The JHU gateway hard-caps the WHOLE request body at 10MB (confirmed live: a 413
# REQUEST_BODY_TOO_LARGE with limitBytes: 10485760). Base64 inflates each image ~33%,
# and multiple images in one upload combine into the same request — so this has to be
# a per-file cap AND a separate combined-total cap (see MAX_TOTAL_IMAGE_B64_BYTES),
# not just one or the other.
MAX_IMAGE_BYTES = 3 * 1024 * 1024
# Budget for the summed base64 size of all images in one request — leaves headroom
# under the 10MB gateway limit for document text, instructions, and JSON overhead.
MAX_TOTAL_IMAGE_B64_BYTES = 7 * 1024 * 1024


def extract_text_from_upload(filename: str, content: bytes) -> str:
    """Extracts plain text from an uploaded .pdf/.docx/.txt file. Raises on unsupported types or empty extraction."""
    lower_name = (filename or "").lower()

    if lower_name.endswith(".pdf"):
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(content))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    elif lower_name.endswith(".docx"):
        from docx import Document
        document = Document(io.BytesIO(content))
        text = "\n".join(paragraph.text for paragraph in document.paragraphs)
    elif lower_name.endswith(".txt"):
        text = content.decode("utf-8", errors="ignore")
    else:
        raise ValueError("Unsupported file type — please upload a .pdf, .docx, or .txt file.")

    text = text.strip()
    if not text:
        raise ValueError("Could not find any readable text in that file.")
    return text[:MAX_REFERENCE_TEXT_CHARS]


async def generate_flowchart_from_prompt(current_prompt: str) -> dict:
    """Builds {nodes, edges} for a robot system prompt — the same diagramming step voice_loop runs after each turn, extracted so a manual prompt edit can also trigger it directly."""
    default = {"nodes": [], "edges": []}
    if not current_prompt.strip():
        return default

    flowchart_system_instruction = """You are a technical diagramming engine. Your job is to analyze a social robot's system prompt and output a highly streamlined, high-level interaction flowchart.

CRITICAL RULES FOR A CLEAN, SIMPLE LAYOUT:
1. USE MACRO-STATES: Combine closely related actions into single macro-nodes. Aim for 4 to 6 core nodes maximum.
2. PREVENT SPAGHETTI LOOPS: Route cyclical actions cleanly back to a central node.
3. DETAILED SUB-PROMPTS: For EVERY node you create, you MUST generate a `detailedPrompt` string. This acts as the specific AI system prompt when the robot is in that state.
The `detailedPrompt` MUST follow this exact structure:
- Overall guidelines (Task): setting/scenario, robot role
- Specific instructions (Required content): what the robot must say or evaluate in this step
- Style Guide: tone, pace, personality
- Example: Example input and output
4. NO RESTART LOOPS: The final ending node of the interaction MUST NEVER have an edge that loops back to the introduction or starting node. Once the activity reaches its conclusion state, it must terminate there.
5. IDENTIFY THE STARTING NODE: Always assign `"id": "1"` to the very first node of the interaction. Its label must clearly indicate it is the entry point by starting with "Start:" (e.g., "Start: Welcome & Intro").
6. IDENTIFY THE ENDING NODE: The final node where the interaction terminates MUST have a label that begins with "End:" (e.g., "End: Goodbye & Sign-off").

CRITICAL FORMATTING RULE: You are strictly forbidden from generating emojis, markdown images, HTML image tags, or image URLs under any circumstances. Output text only.

CRITICAL INTERACTION RULE: This is a purely spoken, voice-based interaction. The robot has no screen, buttons, or physical objects for the user to press, click, tap, or interact with. Never reference buttons, screens, menus, gestures the user must perform, or any pressable/clickable/touchable item — the only channel of interaction is spoken conversation.

OUTPUT FORMAT:
You must respond with ONLY a raw, valid JSON object containing a list of nodes and edges. Use this exact schema:
{
  "nodes": [
    {
      "id": "1",
      "label": "Welcome & Intro",
      "detailedPrompt": "Overall guidelines (Task): You are a math tutor... \nSpecific instructions: Greet the user... \nStyle Guide: Upbeat... \nOutput Rules: Short text... \nExample: ..."
    }
  ],
  "edges": [
    {"from": "1", "to": "2", "label": "Intro complete"}
  ]
}"""

    flowchart_payload = {
        "model": "anthropic/claude-sonnet-4.6",
        "messages": [
            {"role": "system", "content": flowchart_system_instruction},
            {"role": "user", "content": f"Analyze this system prompt and build its interaction flowchart:\n\n{current_prompt}"}
        ],
        "max_tokens": 4000
    }

    try:
        flow_text = await call_gateway_with_retry(flowchart_payload, timeout=60.0, label="FLOWCHART", max_attempts=1)
        return parse_ai_json(flow_text)
    except Exception as e:
        print(f"[FLOWCHART] Error: {e}")
        return default


def format_flowchart_for_db(flowchart_data: Dict[str, Any]) -> Dict[str, Any]:
    if not flowchart_data:
        return {}
        
    db_states = {}
    
    for node in flowchart_data.get("nodes", []):
        state_id = f"state_{node['id']}"
        db_states[state_id] = {
            "label": node.get("label", ""),
            "prompt": node.get("detailedPrompt", ""), 
            "transitions": {}
        }
        
    for edge in flowchart_data.get("edges", []):
        source_id = f"state_{edge['from']}"
        target_id = f"state_{edge['to']}"
        transition_label = edge.get("label", "next")
        
        if source_id in db_states:
            db_states[source_id]["transitions"][transition_label] = target_id
            
    return db_states


@app.post("/api/deploy-to-firebase")
async def deploy_to_firebase(payload: Dict[str, Any]):
    try:
        # GENERATE UNIQUE ID FOR THE LIBRARY
        # Use the ID passed from the frontend, or generate a new one
        library_id = payload.get("id") or f"activity-{uuid.uuid4().hex[:8]}"

        machine_name = payload.get("machine_name", "whiteBot")
        user_id = payload.get("user_id", "user1")
        profile_id = payload.get("profile_id", "unknown")
        library_flowchart = payload.get("libraryFlowchart", {})
        hardware_flowchart = payload.get("hardwareFlowchart", {})
        formatted_states = format_flowchart_for_db(hardware_flowchart)


        # --- 1. DEPLOY TO ROBOT (Hardware Data) ---
        robot_id = "activity-1"
        print(f"[DEPLOY] Overwriting hardware configuration for: {robot_id}")
        robot_ref = get_rtdb_reference(f"robots/{machine_name}/robot_configs/{robot_id}")

        user_settings = {**DEFAULT_SETTINGS, **(get_rtdb_data(f"robots/{machine_name}/{user_id}/settings") or {})}

        # hardwareSystemPrompt = settings-appended; library keeps the clean systemPrompt so settings don't compound on redeploy.
        sanitize_keys = {
            "title": payload.get("title", "Untitled Activity"),
            "raw_flowchart": hardware_flowchart, # The flowchart with formatting rules added in
            "state_machine": formatted_states,
            "systemPrompt": payload.get("hardwareSystemPrompt") or payload.get("systemPrompt"),
            "settings": user_settings,
            "libraryId": library_id, # Which deployed_library entry this came from, for the "Currently Deployed" indicator
            "lastUpdated": payload.get("timestamp")
        }

        sanitized_payload = sanitize_firebase_keys(sanitize_keys)

        robot_ref.set(sanitized_payload)

       # --- 2. SAVE TO LIBRARY (Clean Data) ---
        print(f"[LIBRARY] Saving clean activity to library: {library_id}")
        library_ref = get_rtdb_reference(f"robots/{machine_name}/{user_id}/{profile_id}/deployed_library/{library_id}")

        # Sanitize keys for Library
        clean_keys = {
            "title": payload.get("title", "Untitled Activity"),
            "raw_flowchart": library_flowchart, # The clean flowchart without output rules
            "systemPrompt": payload.get("systemPrompt"),
            "lastUpdated": payload.get("timestamp")
        }

        clean_payload = sanitize_firebase_keys(clean_keys)
        library_ref.set(clean_payload)
        
        return {"status": "success", "saved_id": library_id}
    
    except Exception as e:
        print("\n=== 🚨 CRITICAL ERROR CAUGHT (DEPLOY) 🚨 ===")
        traceback.print_exc()
        print("==========================================\n")
        raise HTTPException(status_code=500, detail="Sync to Firebase failed")
    
@app.post("/api/login")
async def login(payload: LoginPayload):
    try:
        if not payload.user_id.strip():
            raise HTTPException(status_code=400, detail="user_id is required")

        path = f"robots/{payload.machine_name}/{payload.user_id}/last_login"
        get_rtdb_reference(path).set(payload.timestamp)

        return {"status": "success"}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[LOGIN] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to record login")


@app.post("/api/profiles")
async def create_profile(payload: ProfilePayload):
    try:
        if not payload.user_id.strip() or not payload.name.strip():
            raise HTTPException(status_code=400, detail="user_id and name are required")

        profile_data = sanitize_firebase_keys({
            "name": payload.name,
            "targetAge": payload.targetAge,
            "cognitiveProfile": payload.cognitiveProfile,
            "interests": payload.interests,
            "referenceDocument": payload.referenceDocument,
            "lastModified": datetime.now(timezone.utc).isoformat(),
        })

        path = f"robots/{payload.machine_name}/{payload.user_id}"
        existing = get_rtdb_data(path) or {}

        base_key = slugify_key(payload.name)
        profile_id = base_key
        if profile_id in existing:
            profile_id = f"{base_key}-{uuid.uuid4().hex[:6]}"

        get_rtdb_reference(f"{path}/{profile_id}").set(profile_data)

        return {"status": "success", "id": profile_id, **profile_data}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[CREATE PROFILE] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to save profile")


@app.get("/api/profiles/{machine_name}/{user_id}")
async def list_profiles(machine_name: str, user_id: str):
    try:
        path = f"robots/{machine_name}/{user_id}"
        data = get_rtdb_data(path)
        if not data:
            return {"profiles": []}

        # Profiles sit directly under user_id, as sibling keys to "last_login"/"settings" — skip those.
        profiles = [
            {"id": key, **value}
            for key, value in data.items()
            if key not in NON_PROFILE_KEYS and isinstance(value, dict)
        ]
        return {"profiles": profiles}
    except Exception as e:
        print(f"[LIST PROFILES] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch profiles")


@app.put("/api/profiles/{machine_name}/{user_id}/{profile_id}")
async def update_profile(machine_name: str, user_id: str, profile_id: str, payload: ProfileUpdatePayload):
    try:
        if not payload.name.strip():
            raise HTTPException(status_code=400, detail="name is required")

        profile_data = sanitize_firebase_keys({
            "name": payload.name,
            "targetAge": payload.targetAge,
            "cognitiveProfile": payload.cognitiveProfile,
            "interests": payload.interests,
            "referenceDocument": payload.referenceDocument,
            "lastModified": datetime.now(timezone.utc).isoformat(),
        })

        path = f"robots/{machine_name}/{user_id}/{profile_id}"
        # Use update(), not set(), so sibling collections (templates/contexts/deployed_library) aren't wiped out.
        get_rtdb_reference(path).update(profile_data)

        return {"status": "success", "id": profile_id, **profile_data}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[UPDATE PROFILE] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to update profile")


@app.delete("/api/profiles/{machine_name}/{user_id}/{profile_id}")
async def delete_profile(machine_name: str, user_id: str, profile_id: str):
    try:
        path = f"robots/{machine_name}/{user_id}/{profile_id}"
        get_rtdb_reference(path).delete()
        return {"status": "success"}
    except Exception as e:
        print(f"[DELETE PROFILE] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete profile")


@app.delete("/api/profiles/{machine_name}/{user_id}")
async def clear_profiles(machine_name: str, user_id: str):
    try:
        path = f"robots/{machine_name}/{user_id}"
        data = get_rtdb_data(path) or {}

        for key, value in data.items():
            if key not in NON_PROFILE_KEYS and isinstance(value, dict):
                get_rtdb_reference(f"{path}/{key}").delete()

        return {"status": "success"}
    except Exception as e:
        print(f"[CLEAR PROFILES] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to clear profiles")


DEFAULT_SETTINGS = {
    "name": "Robot",
    "voice": "alloy",
    "voiceInstructions": "",
    "languages": ["en-US"],
    "facialExpressions": FACIAL_EXPRESSION_OPTIONS,
    "gestures": GESTURE_OPTIONS,
    "pace": "Normal",
}


@app.get("/api/settings/{machine_name}/{user_id}")
async def get_settings(machine_name: str, user_id: str):
    try:
        path = f"robots/{machine_name}/{user_id}/settings"
        data = get_rtdb_data(path)
        return {**DEFAULT_SETTINGS, **(data or {})}
    except Exception as e:
        print(f"[GET SETTINGS] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch settings")


@app.put("/api/settings/{machine_name}/{user_id}")
async def update_settings(machine_name: str, user_id: str, payload: SettingsPayload):
    try:
        path = f"robots/{machine_name}/{user_id}/settings"
        settings_data = sanitize_firebase_keys({
            "name": payload.name,
            "voice": payload.voice,
            "voiceInstructions": payload.voiceInstructions,
            "languages": payload.languages,
            "facialExpressions": payload.facialExpressions,
            "gestures": payload.gestures,
            "pace": payload.pace,
        })
        get_rtdb_reference(path).set(settings_data)
        return {"status": "success", **settings_data}
    except Exception as e:
        print(f"[UPDATE SETTINGS] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to save settings")


@app.post("/api/templates")
async def create_template(payload: TemplatePayload):
    try:
        if not payload.user_id.strip() or not payload.profile_id.strip() or not payload.title.strip():
            raise HTTPException(status_code=400, detail="user_id, profile_id, and title are required")

        template_data = sanitize_firebase_keys({
            "title": payload.title,
            "description": payload.description,
            "icon": payload.icon,
            "systemPrompt": payload.systemPrompt,
            "data": payload.data,
            "conversationHistory": payload.conversationHistory,
            "referenceDocument": payload.referenceDocument,
        })

        path = f"robots/{payload.machine_name}/{payload.user_id}/{payload.profile_id}/templates"
        existing = get_rtdb_data(path) or {}

        base_key = slugify_key(payload.title)
        template_id = base_key
        if template_id in existing:
            template_id = f"{base_key}-{uuid.uuid4().hex[:6]}"

        get_rtdb_reference(f"{path}/{template_id}").set(template_data)

        return {"status": "success", "id": template_id, **template_data}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[CREATE TEMPLATE] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to save template")


@app.get("/api/templates/{machine_name}/{user_id}/{profile_id}")
async def list_templates(machine_name: str, user_id: str, profile_id: str):
    try:
        path = f"robots/{machine_name}/{user_id}/{profile_id}/templates"
        data = get_rtdb_data(path)
        if not data:
            return {"templates": []}

        templates = [{"id": key, **value} for key, value in data.items()]
        return {"templates": templates}
    except Exception as e:
        print(f"[LIST TEMPLATES] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch templates")


@app.put("/api/templates/{machine_name}/{user_id}/{profile_id}/{template_id}")
async def update_template(machine_name: str, user_id: str, profile_id: str, template_id: str, payload: TemplateUpdatePayload):
    try:
        if not payload.title.strip():
            raise HTTPException(status_code=400, detail="title is required")

        template_data = sanitize_firebase_keys({
            "title": payload.title,
            "description": payload.description,
            "icon": payload.icon,
            "systemPrompt": payload.systemPrompt,
            "data": payload.data,
            "referenceDocument": payload.referenceDocument,
        })
        # Only set if non-empty — .update() would wipe stored history with an empty list.
        if payload.conversationHistory:
            template_data["conversationHistory"] = sanitize_firebase_keys(payload.conversationHistory)

        path = f"robots/{machine_name}/{user_id}/{profile_id}/templates/{template_id}"
        get_rtdb_reference(path).update(template_data)

        return {"status": "success", "id": template_id, **template_data}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[UPDATE TEMPLATE] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to update template")


@app.delete("/api/templates/{machine_name}/{user_id}/{profile_id}/{template_id}")
async def delete_template(machine_name: str, user_id: str, profile_id: str, template_id: str):
    try:
        path = f"robots/{machine_name}/{user_id}/{profile_id}/templates/{template_id}"
        get_rtdb_reference(path).delete()
        return {"status": "success"}
    except Exception as e:
        print(f"[DELETE TEMPLATE] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete template")


@app.delete("/api/templates/{machine_name}/{user_id}/{profile_id}")
async def clear_templates(machine_name: str, user_id: str, profile_id: str):
    try:
        path = f"robots/{machine_name}/{user_id}/{profile_id}/templates"
        get_rtdb_reference(path).delete()
        return {"status": "success"}
    except Exception as e:
        print(f"[CLEAR TEMPLATES] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to clear templates")


@app.post("/api/contexts")
async def create_context(payload: ContextPayload):
    try:
        if not payload.user_id.strip() or not payload.profile_id.strip() or not payload.title.strip():
            raise HTTPException(status_code=400, detail="user_id, profile_id, and title are required")

        context_data = sanitize_firebase_keys({
            "title": payload.title,
            "description": payload.description,
            "robotRole": payload.robotRole,
            "activityTask": payload.activityTask,
            "contextRules": payload.contextRules,
        })

        path = f"robots/{payload.machine_name}/{payload.user_id}/{payload.profile_id}/contexts"
        existing = get_rtdb_data(path) or {}

        base_key = slugify_key(payload.title)
        context_id = base_key
        if context_id in existing:
            context_id = f"{base_key}-{uuid.uuid4().hex[:6]}"

        get_rtdb_reference(f"{path}/{context_id}").set(context_data)

        return {"status": "success", "id": context_id, **context_data}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[CREATE CONTEXT] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to save context")


@app.get("/api/contexts/{machine_name}/{user_id}/{profile_id}")
async def list_contexts(machine_name: str, user_id: str, profile_id: str):
    try:
        path = f"robots/{machine_name}/{user_id}/{profile_id}/contexts"
        data = get_rtdb_data(path)
        if not data:
            return {"contexts": []}

        contexts = [{"id": key, **value} for key, value in data.items()]
        return {"contexts": contexts}
    except Exception as e:
        print(f"[LIST CONTEXTS] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch contexts")


@app.put("/api/contexts/{machine_name}/{user_id}/{profile_id}/{context_id}")
async def update_context(machine_name: str, user_id: str, profile_id: str, context_id: str, payload: ContextUpdatePayload):
    try:
        if not payload.title.strip():
            raise HTTPException(status_code=400, detail="title is required")

        context_data = sanitize_firebase_keys({
            "title": payload.title,
            "description": payload.description,
            "robotRole": payload.robotRole,
            "activityTask": payload.activityTask,
            "contextRules": payload.contextRules,
        })

        path = f"robots/{machine_name}/{user_id}/{profile_id}/contexts/{context_id}"
        get_rtdb_reference(path).update(context_data)

        return {"status": "success", "id": context_id, **context_data}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[UPDATE CONTEXT] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to update context")


@app.delete("/api/contexts/{machine_name}/{user_id}/{profile_id}/{context_id}")
async def delete_context(machine_name: str, user_id: str, profile_id: str, context_id: str):
    try:
        path = f"robots/{machine_name}/{user_id}/{profile_id}/contexts/{context_id}"
        get_rtdb_reference(path).delete()
        return {"status": "success"}
    except Exception as e:
        print(f"[DELETE CONTEXT] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete context")


@app.delete("/api/contexts/{machine_name}/{user_id}/{profile_id}")
async def clear_contexts(machine_name: str, user_id: str, profile_id: str):
    try:
        path = f"robots/{machine_name}/{user_id}/{profile_id}/contexts"
        get_rtdb_reference(path).delete()
        return {"status": "success"}
    except Exception as e:
        print(f"[CLEAR CONTEXTS] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to clear contexts")


@app.get("/api/robot-config/{machine_name}")
async def get_robot_config(machine_name: str):
    try:
        data = get_rtdb_data(f"robots/{machine_name}/robot_configs/activity-1")
        if not data:
            return {"libraryId": None, "lastUpdated": None}
        return {"libraryId": data.get("libraryId"), "lastUpdated": data.get("lastUpdated")}
    except Exception as e:
        print(f"[GET ROBOT CONFIG] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch robot config")


@app.get("/api/library/{machine_name}/{user_id}/{profile_id}")
async def get_library(machine_name: str, user_id: str, profile_id: str):
    try:
        ref = get_rtdb_reference(f"robots/{machine_name}/{user_id}/{profile_id}/deployed_library")
        data = ref.get()
        if not data:
            return {"activities": []}

        # RTDB returns a dict. Convert it to a list of dicts for React.
        activities = [{"id": k, **v} for k, v in data.items()]
        return {"activities": activities}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/library/{machine_name}/{user_id}/{profile_id}/{activity_id}")
async def delete_activity(machine_name: str, user_id: str, profile_id: str, activity_id: str):
    try:
        ref = get_rtdb_reference(f"robots/{machine_name}/{user_id}/{profile_id}/deployed_library/{activity_id}")
        ref.delete()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/library/{machine_name}/{user_id}/{profile_id}")
async def clear_library(machine_name: str, user_id: str, profile_id: str):
    try:
        ref = get_rtdb_reference(f"robots/{machine_name}/{user_id}/{profile_id}/deployed_library")
        ref.delete()
        return {"status": "success"}
    except Exception as e:
        print(f"[CLEAR LIBRARY] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to clear activity center")

@app.put("/api/library/{machine_name}/{user_id}/{profile_id}/{activity_id}")
async def update_activity(machine_name: str, user_id: str, profile_id: str, activity_id: str, payload: dict):
    try:
        library_ref = get_rtdb_reference(f"robots/{machine_name}/{user_id}/{profile_id}/deployed_library/{activity_id}")
        current_data = library_ref.get()
        
        if not current_data:
            raise HTTPException(status_code=404, detail="Activity not found")

        # DETERMINE THE PAYLOAD FORMAT
        if "libraryFlowchart" in payload:
            # Format A: From Deploy Page (Full Flowchart)
            library_flowchart = payload.get("libraryFlowchart", {})
            hardware_flowchart = payload.get("hardwareFlowchart", {})
        else:
            # Format B: From Library Edit Modal (Nodes only)
            library_flowchart = current_data.get("raw_flowchart", {})
            if "nodes" in payload:
                library_flowchart["nodes"] = payload["nodes"]
            
            # Since this is a quick edit, hardware matches library 
            hardware_flowchart = library_flowchart

        formatted_states = format_flowchart_for_db(hardware_flowchart)


        # --- 1. DEPLOY TO ROBOT (Hardware Data) ---
        should_deploy = payload.get("deploy_to_robot", False)
        if should_deploy:
            robot_id = "activity-1"
            print(f"[DEPLOY] Overwriting hardware configuration for: {robot_id}")

            user_settings = {**DEFAULT_SETTINGS, **(get_rtdb_data(f"robots/{machine_name}/{user_id}/settings") or {})}

            # hardwareSystemPrompt = settings-appended; library keeps the clean systemPrompt so settings don't compound on redeploy.
            sanitize_keys = {
                "title": payload.get("title", "Untitled Activity"),
                "raw_flowchart": hardware_flowchart, # The flowchart with formatting rules added in
                "state_machine": formatted_states,
                "systemPrompt": payload.get("hardwareSystemPrompt") or payload.get("systemPrompt"),
                "settings": user_settings,
                "libraryId": activity_id, # Which deployed_library entry this came from, for the "Currently Deployed" indicator
                "lastUpdated": payload.get("timestamp")
            }

            sanitized_payload = sanitize_firebase_keys(sanitize_keys)

            robot_ref = get_rtdb_reference(f"robots/{machine_name}/robot_configs/{robot_id}")
            robot_ref.set(sanitized_payload)
        
       # --- 2. SAVE TO LIBRARY (Clean Data) ---
        print(f"[LIBRARY] Saving clean activity to library: {activity_id}")
        

        # Sanitize keys for Library
        clean_keys = {
            "title": payload.get("title", current_data.get("title", "Untitled Activity")),
            "raw_flowchart": library_flowchart, # The clean flowchart without output rules
            "systemPrompt": payload.get("systemPrompt", current_data.get("systemPrompt", "")),
            "lastUpdated": payload.get("timestamp")
        }

        clean_payload = sanitize_firebase_keys(clean_keys)
        library_ref.set(clean_payload)

        return {"status": "success"}
    except Exception as e:
        print("\n=== 🚨 CRITICAL ERROR CAUGHT (PUT) 🚨 ===")
        traceback.print_exc()
        print("==========================================\n")
        raise HTTPException(status_code=500, detail=str(e))
    

@app.post("/api/simulate")
async def simulate_conversation(payload: SimulatePayload):
    try:
        db_states = format_flowchart_for_db(payload.flowchart)
        current_state_id = payload.currentStateId or "state_1"

        if payload.totalTurnsGenerated >= MAX_SIMULATION_TURNS:
            return {
                "transcript": [],
                "currentStateId": current_state_id,
                "totalTurnsGenerated": payload.totalTurnsGenerated,
                "finished": False,
                "safetyCapped": True
            }

        turns_to_generate = min(payload.turnsToGenerate, MAX_SIMULATION_TURNS - payload.totalTurnsGenerated)
        print(f"\n[SIMULATE] Generating up to {turns_to_generate} turn(s) from '{current_state_id}'.")

        language_names = []
        for code in payload.languages:
            name = LANGUAGE_NAMES.get(code, code)
            if name not in language_names:
                language_names.append(name)
        if not language_names:
            language_names = ["English"]

        transcript = []
        history = list(payload.history)
        total_turns = payload.totalTurnsGenerated
        finished = False

        for i in range(turns_to_generate):
            state = db_states.get(current_state_id)
            if not state:
                print(f"[SIMULATE] Unknown state '{current_state_id}', stopping batch.")
                finished = True
                break

            transitions = state.get("transitions", {})
            transition_labels = list(transitions.keys())
            transitions_block = (
                "\n".join(f'- "{label}"' for label in transition_labels)
                if transition_labels
                else "NONE — this is a terminal state, the activity ends here."
            )

            system_instruction = f"""You are simulating ONE step of a live conversation between a social robot and a user, walking a real state machine turn by turn.

OVERALL ROBOT SYSTEM PROMPT (persona/context for the whole activity):
{payload.systemPrompt}

CONVERSATION SO FAR:
{json.dumps(history, indent=2)}

CURRENT STATE: {state.get('label', current_state_id)}
These are instructions the robot internally follows in this state — NEVER speak them aloud, restate them, or reveal their structure (e.g. never say things like "Overall guidelines:" or "Specific instructions:"). Your "robot_line" output must be pure in-character spoken dialogue that FOLLOWS these instructions, not a restatement of them:
{state.get('prompt', '')}

AVAILABLE TRANSITIONS OUT OF THIS STATE (choose EXACTLY ONE of these labels, verbatim, if any exist):
{transitions_block}

YOUR TASK:
1. Generate the robot's next line of dialogue for this state, consistent with the conversation so far. If — and ONLY if — this state's own instructions explicitly require the robot to stay silent / wait without speaking for this specific turn, set "robot_line" to "" and "robot_silent" to true instead of inventing a line. Do not use this for short or terse lines, only genuine, instructed silence.
2. {"Generate a plausible, short simulated user reply to that robot line. If this state's own instructions call for the user to also not respond yet (still waiting, not a terminal state), set \"user_reply\" to null and \"user_silent\" to true instead." if transition_labels else 'This is a terminal state — set "user_reply" to null and "user_silent" to false.'}
3. {"Based on that reply, choose exactly one transition label from the list above, copied verbatim. Looping back to a state already visited earlier in the conversation is ALLOWED and expected if the transitions call for it — do not avoid it." if transition_labels else 'Set "chosen_transition" to null.'}

CRITICAL RULES:
1. PURE DIALOGUE ONLY for "robot_line"/"user_reply" — never restate or reveal instructions/labels.
2. Forbidden from generating emojis, markdown images, HTML image tags, or image URLs. Output text only.
3. This is a purely spoken, voice-based interaction — the robot has no screen or physical objects. Never reference buttons, screens, menus, or any pressable/clickable/touchable item.
4. LANGUAGE: Both "robot_line" and "user_reply" must be written only in {' or '.join(language_names)} — this is what the deployed robot is restricted to, and the only language(s) it can reliably understand. Never switch to or mix in any other language.
5. "robot_silent"/"user_silent" are for genuine instructed silence only (e.g. "wait for the user to speak first," "do not respond yet") — sparingly, never as a default or filler.

OUTPUT FORMAT — valid JSON only, no markdown fences, no extra text:
{{"robot_line": "..." or "", "robot_silent": true or false, "user_reply": "..." or null, "user_silent": true or false, "chosen_transition": "..." or null}}"""

            gateway_payload = {
                "model": "anthropic/claude-sonnet-4.6",
                "messages": [{"role": "user", "content": system_instruction}],
                "max_tokens": 500
            }

            try:
                ai_text = await call_gateway_with_retry(gateway_payload, timeout=60.0, label="SIMULATE")
                turn_data = parse_ai_json(ai_text)
            except Exception as turn_error:
                print(f"[SIMULATE] Error generating turn at state '{current_state_id}': {turn_error}")
                if i == 0:
                    raise
                break

            robot_line = (turn_data.get("robot_line") or "").strip()
            robot_silent = bool(turn_data.get("robot_silent"))
            if not robot_line and not robot_silent:
                if i == 0:
                    raise Exception("AI did not return a robot_line.")
                break

            state_label = state.get("label", "")
            # A silent turn is displayed as a placeholder (never left blank/omitted) so the
            # mock transcript makes clear the silence was intentional, not a dropped turn —
            # but only ever appears for turns the AI explicitly flagged as instructed silence.
            robot_display = robot_line if robot_line else "..."
            transcript.append({"role": "robot", "content": robot_display, "stateId": current_state_id, "stateLabel": state_label, "silent": robot_silent})
            history.append({"role": "robot", "content": robot_display})
            total_turns += 1

            if not transition_labels:
                finished = True
                break

            user_reply = (turn_data.get("user_reply") or "").strip()
            user_silent = bool(turn_data.get("user_silent"))
            if user_reply:
                transcript.append({"role": "user", "content": user_reply, "stateId": current_state_id, "stateLabel": state_label})
                history.append({"role": "user", "content": user_reply})
            elif user_silent:
                transcript.append({"role": "user", "content": "...", "stateId": current_state_id, "stateLabel": state_label, "silent": True})
                history.append({"role": "user", "content": "..."})

            chosen_transition = turn_data.get("chosen_transition")
            if chosen_transition not in transitions:
                fallback_label = transition_labels[0]
                print(f"[SIMULATE] Transition '{chosen_transition}' not found at state '{current_state_id}', falling back to '{fallback_label}'.")
                chosen_transition = fallback_label

            current_state_id = transitions[chosen_transition]

        return {
            "transcript": transcript,
            "currentStateId": current_state_id,
            "totalTurnsGenerated": total_turns,
            "finished": finished,
            "safetyCapped": total_turns >= MAX_SIMULATION_TURNS and not finished
        }

    except Exception as e:
        print(f"[SIMULATE] Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate simulation")


@app.post("/api/engine/profile-voice-loop")
async def profile_voice_loop(request: Request):
    from openai import OpenAI
    from google.cloud import speech
    print("\n[PROFILE LOOP] Request received.")
    
    try:
        # 1. Extract frontend data
        form_data = await request.form()
        audio_file = form_data.get("audio_file")
        conversation_history = json.loads(form_data.get("conversation_history", "[]"))
        language_code, alternative_language_codes = parse_language_codes(form_data.get("language_codes", ""))

        current_name = form_data.get("current_name", "")
        current_age = form_data.get("current_age", "")
        current_cognitive = form_data.get("current_cognitive", "")
        current_interests = form_data.get("current_interests", "")
        reference_document = form_data.get("reference_document", "")

        if not audio_file:
            raise Exception("No audio file found in the request!")

        # 2. Initialize Clients
        api_key = os.getenv("OPENAI_API_KEY")
        openai_client = OpenAI(api_key=api_key) if api_key else None
        google_speech_client = speech.SpeechClient()

        # 3. Google Speech-to-Text (Listening)
        audio_bytes = await audio_file.read()
        print(f"[AUDIO DEBUG] [PROFILE LOOP] Received {len(audio_bytes)} bytes ({len(audio_bytes) / 1024:.1f} KB)")
        config = speech.RecognitionConfig(
            encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
            sample_rate_hertz=48000,
            language_code=language_code,
            alternative_language_codes=alternative_language_codes,
        )
        google_response = transcribe_long_audio(speech, google_speech_client, config, audio_bytes)
        if not google_response.results:
             raise HTTPException(status_code=422, detail="No speech was detected in the recording. Please try again.")

        # Multiple results at pauses — results[0] alone misses everything after the first one.
        transcript = " ".join(result.alternatives[0].transcript for result in google_response.results).strip()
        if not transcript:
            raise HTTPException(status_code=422, detail="No speech was detected in the recording. Please try again.")
        print(f"[PROFILE LOOP] User said: '{transcript}'")

        # 4. LLM Processing (Extract data & formulate response)
        reference_block = f"""

        REFERENCE MATERIAL: The researcher uploaded one or more files (documents and/or images), already read and transcribed below — treat this exactly as if you had read/seen the original files yourself. Do not say you are unable to read images or files; the relevant content, if any existed, is already extracted here:
        {reference_document}""" if reference_document else ""
        language_restriction = build_language_restriction([language_code] + alternative_language_codes, "ai_spoken_response")

        system_prompt = f"""You are a friendly AI assistant helping a user design a profile for a learner.
        Your goal is to fill out these four fields based on the conversation:
        1. Learner Name: {current_name}
        2. Target Age: {current_age}
        3. Cognitive/Skill Profile: {current_cognitive}
        4. Interests: {current_interests}
        {reference_block}
        {language_restriction}

        The user will say something. You must:
        1. Extract any new information and update the relevant fields. Retain existing information if it hasn't changed.
        2. Generate a short, conversational response asking for whatever is still missing, or confirming completion if everything is filled out. Keep your response under 2 sentences.

        Return ONLY a raw JSON object with this exact schema:
        {{
            "ai_spoken_response": "Got it! And what kind of things is Alex interested in?",
            "learnerName": "Updated Name",
            "targetAge": "Updated Age",
            "cognitiveProfile": "Updated Profile",
            "interests": "Updated Interests"
        }}"""

        # Append new user message to history for context
        messages = [{"role": "system", "content": system_prompt}]
        for msg in conversation_history:
            messages.append(msg)
        messages.append({"role": "user", "content": transcript})

        completion = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            response_format={"type": "json_object"}
        )
        
        ai_response_json = completion.choices[0].message.content
        parsed_data = json.loads(ai_response_json)
        ai_question = parsed_data.get("ai_spoken_response", "Let's keep going.")

        # 5. OpenAI Text-to-Speech (Talking)
        tts_response = openai_client.audio.speech.create(
            model="tts-1",
            voice="alloy", 
            input=ai_question
        )
        
        audio_base64 = base64.b64encode(tts_response.content).decode("utf-8")

        # 6. Build updated history
        updated_history = conversation_history + [
            {"role": "user", "content": transcript},
            {"role": "assistant", "content": ai_question}
        ]

        # 7. Return everything to React
        return JSONResponse(content={
            "learnerName": parsed_data.get("learnerName", ""),
            "targetAge": parsed_data.get("targetAge", ""),
            "cognitiveProfile": parsed_data.get("cognitiveProfile", ""),
            "interests": parsed_data.get("interests", ""),
            "history": updated_history,
            "transcript": transcript,
            "question": ai_question,
            "audio_base64": audio_base64
        })

    except HTTPException as http_exc:
        return JSONResponse(status_code=http_exc.status_code, content={"error": http_exc.detail})
    except Exception as e:
        import traceback
        print("\n=== 🚨 ERROR (PROFILE LOOP) 🚨 ===")
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})



@https_fn.on_request(max_instances=10,
    memory=options.MemoryOption.GB_1,
    timeout_sec=180)
def api(req: https_fn.Request) -> https_fn.Response:
    print(f"[API] Request received: {req.path}", flush=True)
    try:
        local_wsgi_app = ASGIMiddleware(app)
        environ = req.environ.copy()
        body = req.get_data()
        environ['wsgi.input'] = io.BytesIO(body)
        environ['CONTENT_LENGTH'] = str(len(body))
        werkzeug_response = Response.from_app(local_wsgi_app, environ)
 
        response_body = werkzeug_response.get_data()
        
        return https_fn.Response(
            response=response_body,
            status=werkzeug_response.status_code,
            headers=dict(werkzeug_response.headers)
        )
    except Exception as e:
        print(f"Wrapper Error: {e}")
        return https_fn.Response("Internal Server Error", status=500)