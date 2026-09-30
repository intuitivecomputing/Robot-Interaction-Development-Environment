# Robot Interaction Development Environment (RIDE)
## Introduction
This repository accompanies the paper, **"Rapid Conversational Authoring of Interactive Human-Robot Activities"**. It contains source code for RIDE, a web-based authoring tool that lets users design conversational activities for a social robot without handwriting behavior prompts or state machines themselves. A user creates a profile (Name, Age, Relevant Background Knowledge) and then describes an activity out loud (or by typing) to an AI design assistant, which iteratively drafts the robot's system prompt and a corresponding interaction flowchart turn by turn, converging on a complete, deployable activity. The system prompt engineers several specialized agents rather than a single model: Claude (`claude-sonnet-4.6`) drafts the robot's system prompt, generates the interaction flowchart, produces AI-suggested activities from a user's profile, and simulates a mock run-through of an activity for preview before deployment; GPT-4o-mini drives the shorter, structured conversation used to fill out a user profile; and OpenAI's TTS (`tts-1`) synthesizes all spoken audio played back to the researcher during design. User speech throughout is transcribed by Google Cloud Speech-to-Text before reaching whichever agent is active. Finished activities are deployed to a physical robot via Firebase.
## Software and Hardware Requirements

### Environment:
- Windows, macOS, or Linux (developed primarily on Windows)

### Prerequisites:
- Node.js
- React
- Python 3.14
- Firebase CLI (Realtime Database, Storage, Cloud Functions)
- Google Cloud service account Speech-to-Text access
- OpenAI API key
- Claude API key

## Contents
**learnerBot:**
The full interface code, split into a frontend and a backend.

- *learnerBot_Frontend:* A React + TypeScript + Vite application.
  - `src/pages/Login.tsx`: username/robot login
  - `src/pages/UserProfiles.tsx`: select or create a learner profile
  - `src/pages/CreateProfile.tsx`: voice/text-driven profile creation
  - `src/pages/Design.tsx`: the Activity Design workspace: the voice/text conversation with the design agent, plus the flowchart view
  - `src/pages/Testing.tsx`: runs the mock-conversation agent against the current flowchart for preview
  - `src/pages/Deploy.tsx`: sends a finished activity to the robot
  - `src/pages/Library.tsx`: browse/redeploy previously-deployed activities
  - `src/utils/deploymentPrompt.ts`: builds the actual robot-facing prompt/flowchart sent at deploy time
- *functions:* A FastAPI app deployed as a single Firebase Cloud Function (Python 3.14)
  - `main.py` — every backend AI agent (profile-filling, draft-prompting, flowchart generation, activity suggestion, document distillation, mock-conversation simulation, speech-to-text/text-to-speech)
  - `firebase.py` — Firebase Admin SDK wrapper for Realtime Database and Storage access

## Usage

### Frontend
To launch the web app:
```
cd learnerBot/learnerBot_Frontend
npm install
npm run dev
```

### Backend
To run the backend locally:
```
cd learnerBot/functions
python -m venv venv
venv\Scripts\activate    # or source venv/bin/activate on macOS/Linux
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```
The frontend expects the backend at `http://127.0.0.1:8000` by default in local development.

### Deployment
To deploy the backend and/or frontend to Firebase:
```
cd learnerBot
firebase deploy --only functions
firebase deploy --only hosting
```

## Questions
For questions not covered in this README, we welcome developers to open an issue or contact the author at shiyecao@cs.jhu.edu.

## BibTeX
If you use this system in a scientific publication, please cite our work:
```
@inproceedings{,
  title={Rapid Conversational Authoring of Interactive Human-Robot Activities}
  author={Cao, Shiye and Tchamdja, Aureliane and Huang, Chien-Ming}
  year={2026}
}
```
