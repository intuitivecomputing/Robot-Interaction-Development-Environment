import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { buildHardwareFlowchart, fetchRobotSettings, buildSettingsBlock, FACIAL_EXPRESSION_OPTIONS, GESTURE_OPTIONS } from '../utils/deploymentPrompt';

export default function Deploy() {
  const navigate = useNavigate();
  const location = useLocation();
  const { activityId, title, finalPrompt, finalFlowchart } = location.state || {};
  const [activityTitle, setActivityTitle] = useState(title || "");
  const [isDeploying, setIsDeploying] = useState(false);
  const [showSentModal, setShowSentModal] = useState(false);
  const [showSentToast, setShowSentToast] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const currentUser = localStorage.getItem("currentUser") || "user1";
  const activeRobot = localStorage.getItem("activeRobot") || "whiteBot";
  const activeLearner = JSON.parse(localStorage.getItem("activeLearner") || '{}');
  const profileId = activeLearner.id || "unknown";

  // SMART ROUTING: If no active deployment data is found, instantly redirect to the Library.
  useEffect(() => {
    if (!location.state || !finalPrompt || !finalFlowchart) {
      navigate('/library', { replace: true });
      return;
    }
    // Phase 4 timing — only seeded for a real visit, not the missing-state bounce above.
    if (!sessionStorage.getItem('phaseStart_deploy')) {
      sessionStorage.setItem('phaseStart_deploy', new Date().toISOString());
    }
  }, [location, navigate, finalPrompt, finalFlowchart]);

  if (!location.state || !finalPrompt || !finalFlowchart) {
    return null; 
  }

  const handleDeploy = async () => {
    if (!activityTitle.trim()) {
          alert("Please give your activity a title before deploying.");
          return;
        }

    setIsDeploying(true);
    try {
      const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');

      // Pull the researcher's global robot settings and append them to the system prompt.
      const robotSettings = await fetchRobotSettings(apiBase, activeRobot, currentUser);
      const settingsBlock = buildSettingsBlock(robotSettings);
      const finalSystemPrompt = `${finalPrompt}${settingsBlock}`;
      const allowedExpressions = Array.isArray(robotSettings?.facialExpressions) && robotSettings.facialExpressions.length > 0
        ? robotSettings.facialExpressions
        : FACIAL_EXPRESSION_OPTIONS;
      const allowedGestures = Array.isArray(robotSettings?.gestures) && robotSettings.gestures.length > 0
        ? robotSettings.gestures
        : GESTURE_OPTIONS;
      const allowedLanguages = Array.isArray(robotSettings?.languages) && robotSettings.languages.length > 0
        ? robotSettings.languages
        : ['en-US'];
      const hardwareFlowchart = buildHardwareFlowchart(finalFlowchart, allowedExpressions, allowedGestures, allowedLanguages);

      const payload = {
          title: activityTitle,
          machine_name: activeRobot,
          user_id: currentUser,
          profile_id: profileId,
          libraryFlowchart: finalFlowchart, // For the library
          hardwareFlowchart: hardwareFlowchart, // For the Robot
          // Separate so settings don't compound on redeploy: library keeps the clean prompt.
          systemPrompt: finalPrompt,
          hardwareSystemPrompt: finalSystemPrompt,
          timestamp: new Date().toISOString(),
          deploy_to_robot: true
        };

      let response;

      if (activityId){
        // OVERWRITE EXISTING (PUT)
        response = await fetch(`${apiBase}/api/library/${activeRobot}/${currentUser}/${profileId}/${activityId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      } else {
        // CREATE NEW (POST)
        response = await fetch(`${apiBase}/api/deploy-to-firebase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

       if (response.ok) {
        try {
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
              entity_id: 'deploy',
              entity_title: 'Send to Robot',
              phase_entered_at: sessionStorage.getItem('phaseStart_deploy') || '',
              phase_exited_at: new Date().toISOString()
            })
          });
          sessionStorage.removeItem('phaseStart_deploy');
        } catch (logError) {
          console.error('Error writing phase log:', logError);
        }

        const loginTimestamp = localStorage.getItem('loginTimestamp');
        const alreadyAcknowledged = loginTimestamp && localStorage.getItem('deploySetupAcknowledged') === loginTimestamp;
        if (alreadyAcknowledged) {
          setShowSentToast(true);
          setTimeout(() => navigate('/library'), 1500);
        } else {
          setDontShowAgain(false);
          setShowSentModal(true);
        }
      } else {
        throw new Error("Failed to sync to Firebase");
      }
    } catch (error) {
      alert("Sync Failed: Check your backend connection.");
      setIsDeploying(false);
    }
  };

  const handleCloseSentModal = () => {
    // Checking "I understand" is mandatory before this can close at all.
    if (!dontShowAgain) return;

    const loginTimestamp = localStorage.getItem('loginTimestamp');
    if (loginTimestamp) localStorage.setItem('deploySetupAcknowledged', loginTimestamp);
    setShowSentModal(false);
    setShowSentToast(true);
    setTimeout(() => navigate('/library'), 1500);
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-12 text-center flex flex-col gap-6 items-center">
      
      {/* Navigation Header */}
      <div className="w-full flex justify-between items-center mb-2">
        <div className="flex gap-4">
          <button 
            onClick={() => navigate('/testing', { state: { finalPrompt, finalFlowchart, activityTitle } })}
            className="text-sm text-slate-500 hover:text-indigo-600 transition-colors font-bold"
          >
            ← See Preview
          </button>
          
          {/* Jump to Deploy Library */}
          <button 
            onClick={() => navigate('/library', { state: { initialPrompt: finalPrompt, initialFlowchart: finalFlowchart } })} 
            className="text-sm text-slate-500 hover:text-indigo-600 transition-colors font-bold border-l border-slate-300 pl-4"
          >
            ↶ Jump to Activity Center
          </button>
        </div>
        
        <span className="text-xs font-semibold bg-emerald-100 text-emerald-800 px-3 py-1 rounded-full uppercase tracking-wider">
          Phase 4: Send to Robot
        </span>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm w-full">
        <span className="text-5xl mb-6 block">🚀</span>
        <h1 className="text-2xl font-bold text-slate-800 mb-2">Ready For The Robot?</h1>
        <p className="text-slate-500 text-sm mb-6">
          Name this activity to save it to your Activity Center, then send the final activity to the robot.
        </p>

        <div className="mb-8 text-left">
          <label className="block text-sm font-bold text-slate-700 mb-2">Final Activity Name <span className="text-red-500">*</span></label>
          <input 
            type="text" 
            value={activityTitle}
            onChange={(e) => setActivityTitle(e.target.value)}
            placeholder="e.g., Solar System Trivia"
            className="w-full bg-slate-50 border border-slate-200 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 p-4 rounded-xl text-slate-800 outline-none transition-all shadow-inner"
          />
        </div>

        <button 
          onClick={handleDeploy}
          disabled={isDeploying}
          className={`w-full py-4 rounded-xl font-bold text-white transition-all shadow-lg 
            ${isDeploying ? 'bg-slate-400 cursor-wait' : 'bg-emerald-600 hover:bg-emerald-700'}`}
        >
          {isDeploying ? 'SENDING TO ROBOT...' : 'SEND & SAVE TO ACTIVITY CENTER'}
        </button>
      </div>

      {finalPrompt && (
        <div className="w-full text-left bg-slate-50 p-4 rounded-lg border border-slate-200">
          <h3 className="text-xs font-bold text-slate-400 uppercase mb-2">Overview of Robot Personality:</h3>
          <div className="max-h-48 overflow-y-auto pr-2 scrollbar-thin">
            <p className="text-xs text-slate-600 font-mono whitespace-pre-wrap">{finalPrompt}</p>
          </div>
        </div>
      )}

      {/* Sent to Robot Modal — no dismiss-by-clicking-outside; can't close at all until "I understand" is checked */}
      {showSentModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col">
            <div className="px-8 py-5 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="font-bold text-2xl text-slate-800">Activity Sent!</h3>
              <button
                onClick={handleCloseSentModal}
                disabled={!dontShowAgain}
                className={`text-2xl font-bold ${dontShowAgain ? 'text-slate-400 hover:text-slate-600' : 'text-slate-200 cursor-not-allowed'}`}
              >
                ×
              </button>
            </div>
            <div className="p-8 flex flex-col gap-7 text-left">
              <div className="flex items-start gap-5">
                <div className="bg-emerald-500 text-white rounded-full p-2.5 shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
                <div className="flex flex-col gap-4">
                  <p className="text-lg text-slate-700 font-medium leading-relaxed">
                    Your activity has been sent to the robot. Make sure the robot is powered on and connected to receive it.
                  </p>
                  <div>
                    <p className="text-base font-bold text-slate-800 mb-2">Robot Set Up Instructions:</p>
                    <ol className="list-decimal list-inside text-base text-slate-600 leading-relaxed flex flex-col gap-2">
                      <li>Ensure you have the USB-C Power Cable plugged in and connected to the robot.</li>
                      <li>Ensure you have the Motor Power Cable plugged in and connected to the robot.</li>
                      <li>Press the power button on the right side of the robot's head to turn on the robot and to automatically start the activity!</li>
                    </ol>
                  </div>
                </div>
              </div>

              <label className="flex items-center gap-3 text-base text-slate-600 font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={dontShowAgain}
                  onChange={(e) => setDontShowAgain(e.target.checked)}
                  className="w-5 h-5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                />
                I understand and know how to set up the robot
              </label>

              <button
                onClick={handleCloseSentModal}
                disabled={!dontShowAgain}
                className={`w-full py-3 rounded-xl font-bold text-lg text-white shadow transition-all ${
                  dontShowAgain ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-slate-300 cursor-not-allowed'
                }`}
              >
                Continue to Activity Center →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sent to Robot Toast — shown instead of the full modal once setup has already been acknowledged this session */}
      {showSentToast && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="bg-slate-900 text-white px-8 py-6 rounded-2xl shadow-2xl flex items-center gap-4">
            <div className="bg-emerald-500 text-white rounded-full p-2 shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
            <span className="text-lg font-semibold">Activity sent to the robot!</span>
          </div>
        </div>
      )}
    </div>
  );
}