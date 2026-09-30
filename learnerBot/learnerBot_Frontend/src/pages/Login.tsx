import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [robotName, setRobotName] = useState('whiteBot');
  const [isLoading, setIsLoading] = useState(false);

 useEffect(() => {
    // When the page loads, check the URL for "?robot=something"
    const params = new URLSearchParams(location.search);
    const urlRobot = params.get('robot');
    if (urlRobot) {
      setRobotName(urlRobot); // Automatically assign it!
    }
  }, [location]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    const safeUser = username.trim();
    if (!safeUser || isLoading) return;

    setIsLoading(true);

    try{
        const loginTimestamp = new Date().toISOString();
        localStorage.setItem("currentUser", safeUser);
        localStorage.setItem("activeRobot", robotName);
        // Groups every activity-log entry created during this session together —
        // see /api/activity-log's login_timestamp field.
        localStorage.setItem("loginTimestamp", loginTimestamp);
        // "Untitled" abandoned-draft cards on the Design gallery are temporary to
        // a single login session — a fresh login starts with a clean slate. Keyed
        // per learner profile (abandonedDrafts_design_<profileId>), so clear all of them.
        Object.keys(sessionStorage)
          .filter((key) => key.startsWith('abandonedDrafts_design_'))
          .forEach((key) => sessionStorage.removeItem(key));

        const apiBase = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/api\/?$/, '');
        const response = await fetch(`${apiBase}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machine_name: robotName,
          user_id: safeUser,
          timestamp: loginTimestamp
        })
      });

      if (!response.ok) {
        throw new Error(`Backend returned ${response.status}`);
      }

      // First-ever login for this username (on this device) — have them pick a
      // language before anything else. Every later login skips straight past it.
      const hasLanguageSetup = localStorage.getItem(`sttLanguagesOverride_${safeUser}`);
      navigate(hasLanguageSetup ? '/profiles' : '/language-setup');

    } catch (error) {
      console.error("Login error:", error);
      alert("Could not reach the backend server. Is it running?");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200 w-full max-w-md flex flex-col gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-slate-800">Welcome</h1>
          <p className="text-sm text-slate-500 mt-2">Enter your username to access your workspace.</p>
        </div>

        <form onSubmit={handleLogin} className="flex flex-col gap-4">
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Username</label>
            <input 
              type="text" 
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. User01" 
              className="w-full bg-slate-50 border border-slate-200 p-4 rounded-xl outline-none focus:border-indigo-400 text-slate-700 font-medium"
              autoFocus
            />
          </div>
          <button
            type="submit"
            disabled={!username.trim() || isLoading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-xl shadow-md transition-all disabled:opacity-50"
          >
            {isLoading ? 'Logging in...' : 'Access Workspace →'}
          </button>
        </form>
      </div>
    </div>
  );
}